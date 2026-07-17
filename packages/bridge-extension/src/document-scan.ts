import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { buildComponentTypeSchema, type ComponentTypeSchemaResult } from './component-schema';
import { ProbeError } from './probe-errors';
import {
  normalizeNodeDump,
  normalizePrefabDump,
  readComponentFileId
} from './scene-probe';
import { readObject } from './raw-reflection';

export type DocumentScanMode = 'summary' | 'full';

export interface DocumentScanRequest {
  mode?: DocumentScanMode;
  cursor?: string | null;
  pageSize?: number;
  includeRaw?: boolean;
  concurrency?: number;
  document?: {
    assetUuid: string | null;
    path: string | null;
    filePath: string | null;
    documentType: 'scene' | 'prefab' | null;
  };
}

type DocumentScanDocument = NonNullable<DocumentScanRequest['document']>;

export interface DocumentScanSource {
  queryNodeTree: () => Promise<unknown>;
  queryNode: (nodeUuid: string) => Promise<unknown>;
  queryComponent: (componentUuid: string) => Promise<unknown>;
}

export interface DocumentIdentityEvidence {
  assetUuid: string | null;
  mode: string | null;
  source: string | null;
  failures: Array<{ source: string; reason: string }>;
}

interface HierarchyComponentEntry {
  componentUuid: string;
  nodeUuid: string;
  nodePath: string | null;
  componentIndex: number;
}

interface HierarchyNodeEntry {
  nodeUuid: string;
  name: string | null;
  type: string | null;
  active: boolean | null;
  path: string | null;
  parentUuid: string | null;
  childUuids: string[];
  siblingIndex: number;
  components: HierarchyComponentEntry[];
  prefabAssetUuid: string | null;
  prefabState: number | null;
  prefabIsNested: boolean | null;
  prefabInstanceRoot: boolean;
  prefabInstanceChain: Array<{
    depth: number;
    assetUuid: string;
    instanceNodeUuid: string | null;
    state: number | null;
    isNested: boolean | null;
  }>;
}

interface DocumentNodeResult {
  kind: 'node';
  identity: {
    sessionId: null;
    objectUuid: string;
    assetUuid: null;
    fileId: string | null;
    typeId: string | null;
    scriptUuid: null;
  };
  name: string | null;
  path: string | null;
  parentObjectUuid: string | null;
  childObjectUuids: string[];
  siblingIndex: number;
  active: boolean | null;
  layer: number | null;
  localTransform: unknown;
  raw?: unknown;
}

interface BoundComponentSchema extends ComponentTypeSchemaResult {
  componentUuid: string;
  componentFileId: string | null;
  nodeUuid: string;
  nodePath: string | null;
  componentIndex: number;
}

type DocumentPrefabInstance = ReturnType<typeof normalizePrefabDump> & {
  instanceChain: HierarchyNodeEntry['prefabInstanceChain'];
};

interface DocumentScanCursor {
  version: 1;
  snapshotId: string;
  revision: string;
  offset: number;
  pageSize: number;
  mode: DocumentScanMode;
  includeRaw: boolean;
  document: DocumentScanDocument;
}

export interface DocumentSnapshotResult {
  document: {
    assetUuid: string | null;
    path: string | null;
    filePath: string | null;
    documentType: 'scene' | 'prefab' | null;
    available: boolean;
    raw: Record<string, unknown>;
  };
  revision: string;
  mode: DocumentScanMode;
  page: {
    offset: number;
    pageSize: number;
    totalNodes: number;
    nextCursor: string | null;
  };
  nodes: DocumentNodeResult[];
  componentSchemas: BoundComponentSchema[];
  prefabInstances: DocumentPrefabInstance[];
  coverage: {
    nodes: { total: number; decoded: number };
    components: { total: number; decoded: number };
    properties: { total: number; decoded: number };
    references: { total: number; resolved: number };
    prefabInstances: { total: number; resolved: number };
    overrides: { total: number; decoded: number };
  };
  unresolved: Array<{ path: string; reason: string; details?: unknown }>;
  diagnostics: Array<{ code: string; message: string; details?: unknown }>;
  raw?: unknown;
}

type DocumentSnapshotContent = Omit<DocumentSnapshotResult, 'page'>;

interface DocumentSnapshotSession {
  snapshotId: string;
  includeRaw: boolean;
  content: DocumentSnapshotContent;
}

interface StoredDocumentSnapshotSession extends DocumentSnapshotSession {
  expiresAt: number;
}

export interface DocumentScanSessionStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface DocumentScanSessionStore {
  create: (
    content: DocumentSnapshotContent,
    includeRaw: boolean
  ) => DocumentSnapshotSession;
  read: (snapshotId: string) => DocumentSnapshotSession | null;
  clear: () => void;
  dispose: () => void;
}

const DEFAULT_DOCUMENT_SCAN_SESSION_TTL_MS = 120_000;
const DEFAULT_DOCUMENT_SCAN_SESSION_MAX_ENTRIES = 2;
const MAX_DOCUMENT_SCAN_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 创建固定快照分页会话仓库。
 *
 * @param options 会话空闲 TTL、最大快照数和当前时间来源。
 * @returns 可登记和读取固定文档快照的会话仓库。
 */
export function createDocumentScanSessionStore(
  options: DocumentScanSessionStoreOptions = {}
): DocumentScanSessionStore {
  const ttlMs = options.ttlMs ?? DEFAULT_DOCUMENT_SCAN_SESSION_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_DOCUMENT_SCAN_SESSION_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ProbeError('INVALID_DOCUMENT_SCAN_SESSION_STORE', { ttlMs });
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new ProbeError('INVALID_DOCUMENT_SCAN_SESSION_STORE', { maxEntries });
  }
  const sessions = new Map<string, StoredDocumentSnapshotSession>();
  let sequence = 0;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  let isDisposed = false;

  /**
   * 读取并校验会话时钟，同时避免系统时钟回拨破坏 TTL 顺序。
   *
   * @returns 当前可用于会话过期计算的单调时间。
   */
  const readCurrentTime = (): number => {
    const currentTime = now();
    if (!Number.isFinite(currentTime)) {
      throw new ProbeError('INVALID_DOCUMENT_SCAN_SESSION_STORE', { currentTime });
    }
    latestTime = Math.max(latestTime, currentTime);
    return latestTime;
  };

  const removeExpired = (currentTime: number): void => {
    for (const [snapshotId, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(snapshotId);
    }
  };

  /**
   * 取消当前等待执行的快照释放计时器。
   */
  const cancelCleanup = (): void => {
    if (cleanupTimer === null) return;
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  };

  /**
   * 按最早快照的过期时刻安排下一次主动释放。
   *
   * @param currentTime 当前会话时钟，用于计算下一次等待时长。
   */
  const scheduleCleanup = (currentTime: number): void => {
    cancelCleanup();
    let nextExpiresAt: number | null = null;
    for (const session of sessions.values()) {
      nextExpiresAt = nextExpiresAt === null
        ? session.expiresAt
        : Math.min(nextExpiresAt, session.expiresAt);
    }
    if (nextExpiresAt === null) return;

    const delayMs = Math.min(
      Math.max(nextExpiresAt - currentTime, 0),
      MAX_DOCUMENT_SCAN_TIMER_DELAY_MS
    );
    const scheduledTime = currentTime + delayMs;
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      const observedTime = now();
      latestTime = Number.isFinite(observedTime)
        ? Math.max(latestTime, observedTime, scheduledTime)
        : Math.max(latestTime, scheduledTime);
      const cleanupTime = latestTime;
      removeExpired(cleanupTime);
      scheduleCleanup(cleanupTime);
    }, delayMs);

    // Node 环境下不让缓存清理计时器阻止测试或扩展进程退出。
    const timerWithUnref = cleanupTimer as unknown as { unref?: () => void };
    timerWithUnref.unref?.();
  };

  return {
    create: (content, includeRaw) => {
      if (isDisposed) {
        throw new ProbeError('DOCUMENT_SCAN_SESSION_STORE_DISPOSED');
      }
      const currentTime = readCurrentTime();
      removeExpired(currentTime);
      while (sessions.size >= maxEntries) {
        const oldestSnapshotId = sessions.keys().next().value as string | undefined;
        if (!oldestSnapshotId) break;
        sessions.delete(oldestSnapshotId);
      }
      sequence += 1;
      const snapshotId = sha256(stableStringify({
        revision: content.revision,
        sequence,
        createdAt: currentTime
      }));
      const session = {
        snapshotId,
        includeRaw,
        content,
        expiresAt: currentTime + ttlMs
      };
      sessions.set(snapshotId, session);
      scheduleCleanup(currentTime);
      return session;
    },
    read: (snapshotId) => {
      if (isDisposed) return null;
      const currentTime = readCurrentTime();
      removeExpired(currentTime);
      const session = sessions.get(snapshotId);
      if (!session) {
        scheduleCleanup(currentTime);
        return null;
      }
      session.expiresAt = currentTime + ttlMs;
      sessions.delete(snapshotId);
      sessions.set(snapshotId, session);
      scheduleCleanup(currentTime);
      return session;
    },
    clear: () => {
      sessions.clear();
      cancelCleanup();
    },
    dispose: () => {
      isDisposed = true;
      sessions.clear();
      cancelCleanup();
    }
  };
}

let defaultDocumentScanSessionStore = createDocumentScanSessionStore();

/**
 * 清理默认文档扫描快照会话及其释放计时器。
 */
export function clearDefaultDocumentScanSessions(): void {
  defaultDocumentScanSessionStore.dispose();
  defaultDocumentScanSessionStore = createDocumentScanSessionStore();
}

/**
 * 扫描 Creator 当前打开文档并返回可分页的只读快照。
 *
 * @param request 扫描模式、分页、原始数据和并发配置。
 * @param source Creator Scene 消息读取适配器。
 * @param scriptPathsByUuid 脚本 UUID 到 db 路径的资产索引。
 * @param documentIdentity Creator 当前可确认的文档身份。
 * @param sessionStore 固定快照分页会话仓库。
 * @returns 当前文档只读快照。
 */
export async function scanCurrentDocument(
  request: DocumentScanRequest,
  source: DocumentScanSource,
  scriptPathsByUuid: ReadonlyMap<string, string> = new Map(),
  documentIdentity: DocumentIdentityEvidence = {
    assetUuid: null,
    mode: null,
    source: null,
    failures: []
  },
  sessionStore: DocumentScanSessionStore = defaultDocumentScanSessionStore
): Promise<DocumentSnapshotResult> {
  const cursor = request.cursor ? decodeCursor(request.cursor) : null;
  if (cursor) {
    return readSnapshotPageFromCursor(request, cursor, documentIdentity, sessionStore);
  }

  const mode = readMode(request.mode);
  const pageSize = readPageSize(request.pageSize);
  const concurrency = readConcurrency(request.concurrency);
  const includeRaw = request.includeRaw === true;
  const requestedDocument = request.document ?? {
    assetUuid: null,
    path: null,
    filePath: null,
    documentType: null
  };
  const document = mergeDocumentIdentity(requestedDocument, documentIdentity);

  const hierarchy = await source.queryNodeTree();
  const hierarchyEntries = flattenHierarchy(hierarchy);
  const componentEntries = hierarchyEntries.flatMap((entry) => entry.components);
  const prefabInstanceEntries = hierarchyEntries.filter((entry) =>
    entry.parentUuid !== null
    && entry.prefabInstanceRoot
    && entry.prefabAssetUuid !== null
    && entry.prefabAssetUuid !== document.assetUuid
  );
  if (mode === 'summary') {
    const nodes = hierarchyEntries.map(buildHierarchyNodeResult);
    const revision = sha256(stableStringify({ document, hierarchy }));
    const session = sessionStore.create({
      document: {
        ...document,
        available: true,
        raw: buildDocumentIdentityRaw(documentIdentity)
      },
      revision,
      mode,
      nodes,
      componentSchemas: [],
      prefabInstances: [],
      coverage: {
        nodes: { total: hierarchyEntries.length, decoded: nodes.length },
        components: { total: componentEntries.length, decoded: 0 },
        properties: { total: 0, decoded: 0 },
        references: { total: 0, resolved: 0 },
        prefabInstances: { total: prefabInstanceEntries.length, resolved: 0 },
        overrides: { total: 0, decoded: 0 }
      },
      unresolved: buildDocumentUnresolved(requestedDocument, document, documentIdentity),
      diagnostics: [{
        code: 'DOCUMENT_SCAN_SUMMARY_COMPLETE',
        message: '当前文档层级摘要已完成',
        details: {
          nodeCount: hierarchyEntries.length,
          componentCount: componentEntries.length
        }
      }],
      ...(includeRaw ? { raw: { hierarchy } } : {})
    }, includeRaw);
    return buildSnapshotPage(session, 0, pageSize);
  }

  const nodeDumps = await mapWithConcurrency(
    hierarchyEntries,
    concurrency,
    (entry) => queryWithContext(
      'DOCUMENT_NODE_QUERY_FAILED',
      { nodeUuid: entry.nodeUuid },
      () => source.queryNode(entry.nodeUuid)
    )
  );
  const componentDumps = await mapWithConcurrency(
    componentEntries,
    concurrency,
    (entry) => queryWithContext(
      'DOCUMENT_COMPONENT_QUERY_FAILED',
      {
        componentUuid: entry.componentUuid,
        nodeUuid: entry.nodeUuid,
        componentIndex: entry.componentIndex
      },
      () => source.queryComponent(entry.componentUuid)
    )
  );
  const currentHierarchy = await source.queryNodeTree();
  const initialHierarchyRevision = sha256(stableStringify(hierarchy));
  const currentHierarchyRevision = sha256(stableStringify(currentHierarchy));
  if (currentHierarchyRevision !== initialHierarchyRevision) {
    throw new ProbeError('DOCUMENT_CHANGED_DURING_SCAN', {
      initialHierarchyRevision,
      currentHierarchyRevision
    });
  }
  const nodes = hierarchyEntries.map((entry, index) => buildNodeResult(
    entry,
    nodeDumps[index],
    includeRaw
  ));
  const componentSchemas = componentEntries.map((entry, index) => ({
    ...buildComponentTypeSchema(componentDumps[index], scriptPathsByUuid),
    componentUuid: entry.componentUuid,
    componentFileId: readComponentFileId(componentDumps[index]),
    nodeUuid: entry.nodeUuid,
    nodePath: entry.nodePath,
    componentIndex: entry.componentIndex
  }));
  const propertyCount = componentSchemas.reduce(
    (total, schema) => total + schema.properties.length,
    0
  );
  const references = componentSchemas.flatMap((schema) =>
    schema.properties.flatMap((property) => property.references)
  );
  const prefabInstances = prefabInstanceEntries.map((entry) => {
    const nodeIndex = hierarchyEntries.indexOf(entry);
    const normalized = normalizePrefabDump(
      nodeDumps[nodeIndex],
      document.assetUuid,
      entry.path
    );
    const sourcePrefabAssetUuid = normalized.sourcePrefabAssetUuid
      ?? entry.prefabAssetUuid;
    return {
      ...normalized,
      sourcePrefabAssetUuid,
      unresolved: sourcePrefabAssetUuid
        ? normalized.unresolved.filter((item) => item.path !== 'sourcePrefabAssetUuid')
        : normalized.unresolved,
      instanceChain: buildPrefabInstanceChain(entry, document, hierarchyEntries[0]?.nodeUuid ?? null)
    };
  });
  const overrideCount = prefabInstances.reduce(
    (total, instance) => total
      + instance.propertyOverrides.length
      + instance.targetOverrides.length
      + instance.mountedChildren.length
      + instance.mountedComponents.length
      + instance.removedComponents.length,
    0
  );
  const revision = sha256(stableStringify({
    document,
    hierarchy,
    nodeDumps,
    componentDumps
  }));
  const session = sessionStore.create({
    document: {
      ...document,
      available: true,
      raw: buildDocumentIdentityRaw(documentIdentity)
    },
    revision,
    mode,
    nodes,
    componentSchemas,
    prefabInstances,
    coverage: {
      nodes: { total: hierarchyEntries.length, decoded: nodes.length },
      components: { total: componentEntries.length, decoded: componentSchemas.length },
      properties: { total: propertyCount, decoded: propertyCount },
      references: {
        total: references.length,
        resolved: references.filter((reference) =>
          reference.kind !== 'missing' && reference.available
        ).length
      },
      prefabInstances: {
        total: prefabInstances.length,
        resolved: prefabInstances.filter((instance) =>
          instance.sourcePrefabAssetUuid !== null
          && instance.sourceObjectFileId !== null
          && instance.instanceFileId !== null
        ).length
      },
      overrides: { total: overrideCount, decoded: overrideCount }
    },
    unresolved: buildDocumentUnresolved(requestedDocument, document, documentIdentity),
    diagnostics: [{
      code: 'DOCUMENT_SCAN_COMPLETE',
      message: '当前文档只读快照已完成',
      details: {
        nodeCount: hierarchyEntries.length,
        componentCount: componentEntries.length,
        concurrency
      }
    }],
    ...(includeRaw ? { raw: { hierarchy, nodeDumps, componentDumps } } : {})
  }, includeRaw);
  return buildSnapshotPage(session, 0, pageSize);
}

/**
 * 从 cursor 绑定的固定快照返回下一页，不重新读取 Creator 动态 Dump。
 *
 * @param request 当前分页请求，用于校验显式文档和模式没有跨会话变化。
 * @param cursor 已解码的快照 cursor。
 * @param documentIdentity Creator 当前可确认的文档身份。
 * @param sessionStore 固定快照分页会话仓库。
 * @returns cursor 指向的固定快照页。
 */
function readSnapshotPageFromCursor(
  request: DocumentScanRequest,
  cursor: DocumentScanCursor,
  documentIdentity: DocumentIdentityEvidence,
  sessionStore: DocumentScanSessionStore
): DocumentSnapshotResult {
  const session = sessionStore.read(cursor.snapshotId);
  if (!session) {
    throw new ProbeError('SCAN_CURSOR_STALE', {
      expectedRevision: cursor.revision,
      reason: 'SNAPSHOT_SESSION_NOT_FOUND'
    });
  }
  assertCursorContext(request, cursor, session, documentIdentity);
  return buildSnapshotPage(session, cursor.offset, cursor.pageSize);
}

/**
 * 校验 cursor 与已登记快照、显式请求和当前文档身份仍属于同一分页会话。
 *
 * @param request 当前分页请求。
 * @param cursor 已解码的快照 cursor。
 * @param session cursor 指向的固定快照会话。
 * @param documentIdentity Creator 当前可确认的文档身份。
 */
function assertCursorContext(
  request: DocumentScanRequest,
  cursor: DocumentScanCursor,
  session: DocumentSnapshotSession,
  documentIdentity: DocumentIdentityEvidence
): void {
  const sessionDocument = readSnapshotDocument(session.content);
  const requestedDocument = request.document
    ? mergeDocumentIdentity(request.document, documentIdentity)
    : documentIdentity.assetUuid
      ? mergeDocumentIdentity(cursor.document, documentIdentity)
      : cursor.document;
  const contextMatches = session.content.revision === cursor.revision
    && session.content.mode === cursor.mode
    && session.includeRaw === cursor.includeRaw
    && documentsEqual(sessionDocument, cursor.document)
    && documentsEqual(requestedDocument, cursor.document)
    && (request.mode === undefined || readMode(request.mode) === cursor.mode)
    && (request.includeRaw === undefined || (request.includeRaw === true) === cursor.includeRaw);
  if (!contextMatches) {
    throw new ProbeError('SCAN_CURSOR_STALE', {
      expectedRevision: cursor.revision,
      reason: 'SNAPSHOT_CONTEXT_CHANGED',
      expectedDocument: cursor.document,
      currentDocument: requestedDocument
    });
  }
}

/**
 * 从固定快照切出一页节点，以及这些节点对应的组件和 Prefab 实例。
 *
 * @param session 已登记的完整快照会话。
 * @param offset 当前页起始节点下标。
 * @param pageSize 当前页大小。
 * @returns 不触发 Creator 查询的分页快照。
 */
function buildSnapshotPage(
  session: DocumentSnapshotSession,
  offset: number,
  pageSize: number
): DocumentSnapshotResult {
  const { content } = session;
  const offsetOutOfRange = content.nodes.length === 0
    ? offset !== 0
    : offset >= content.nodes.length;
  if (offset < 0 || offsetOutOfRange) {
    throw new ProbeError('INVALID_DOCUMENT_SCAN_CURSOR', {
      reason: 'CURSOR_OFFSET_OUT_OF_RANGE',
      offset,
      totalNodes: content.nodes.length
    });
  }
  const pageNodes = content.nodes.slice(offset, offset + pageSize);
  const pageNodeUuids = new Set(pageNodes.map((node) => node.identity.objectUuid));
  const pageComponentSchemas = content.componentSchemas.filter((schema) =>
    pageNodeUuids.has(schema.nodeUuid)
  );
  const pagePrefabInstances = content.prefabInstances.filter((instance) =>
    instance.instanceRootObjectUuid !== null
    && pageNodeUuids.has(instance.instanceRootObjectUuid)
  );
  const unresolved = [...content.unresolved];
  for (let index = 0; index < pageComponentSchemas.length; index += 1) {
    for (const item of pageComponentSchemas[index].unresolved) {
      unresolved.push({
        ...item,
        path: `componentSchemas.${index}.${item.path}`
      });
    }
  }
  for (let index = 0; index < pagePrefabInstances.length; index += 1) {
    for (const item of pagePrefabInstances[index].unresolved) {
      unresolved.push({
        ...item,
        path: `prefabInstances.${index}.${item.path}`
      });
    }
  }

  return {
    ...content,
    page: {
      offset,
      pageSize,
      totalNodes: content.nodes.length,
      nextCursor: createNextCursor({
        session,
        offset,
        pageSize,
        totalNodes: content.nodes.length
      })
    },
    nodes: pageNodes,
    componentSchemas: pageComponentSchemas,
    prefabInstances: pagePrefabInstances,
    unresolved
  };
}

function readSnapshotDocument(content: DocumentSnapshotContent): DocumentScanDocument {
  return {
    assetUuid: content.document.assetUuid,
    path: content.document.path,
    filePath: content.document.filePath,
    documentType: content.document.documentType
  };
}

function documentsEqual(left: DocumentScanDocument, right: DocumentScanDocument): boolean {
  return left.assetUuid === right.assetUuid
    && left.path === right.path
    && left.filePath === right.filePath
    && left.documentType === right.documentType;
}

/**
 * 规范化并校验文档扫描模式。
 *
 * @param value 用户请求的模式。
 * @returns summary 或 full，默认 full。
 */
function readMode(value: DocumentScanMode | undefined): DocumentScanMode {
  const mode = value ?? 'full';
  if (mode !== 'summary' && mode !== 'full') {
    throw new ProbeError('INVALID_DOCUMENT_SCAN_MODE', { mode });
  }
  return mode;
}

/**
 * 解码并校验分页 cursor，拒绝无法识别或被破坏的状态。
 *
 * @param value Base64URL 编码的 cursor。
 * @returns 已校验的分页状态。
 */
function decodeCursor(value: string): DocumentScanCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const cursor = readObject(parsed);
    const document = readObject(cursor.document);
    if (
      cursor.version !== 1
      || typeof cursor.snapshotId !== 'string'
      || cursor.snapshotId.length === 0
      || typeof cursor.revision !== 'string'
      || cursor.revision.length === 0
      || !Number.isInteger(cursor.offset)
      || (cursor.offset as number) < 0
      || !Number.isInteger(cursor.pageSize)
      || (cursor.pageSize as number) < 1
      || (cursor.pageSize as number) > 500
      || (cursor.mode !== 'summary' && cursor.mode !== 'full')
      || typeof cursor.includeRaw !== 'boolean'
      || !('assetUuid' in document)
      || (document.assetUuid !== null && typeof document.assetUuid !== 'string')
      || !('path' in document)
      || (document.path !== null && typeof document.path !== 'string')
      || !('filePath' in document)
      || (document.filePath !== null && typeof document.filePath !== 'string')
      || !('documentType' in document)
      || (
        document.documentType !== null
        && document.documentType !== 'scene'
        && document.documentType !== 'prefab'
      )
    ) {
      throw new Error('INVALID_CURSOR_PAYLOAD');
    }
    return {
      version: 1,
      snapshotId: cursor.snapshotId as string,
      revision: cursor.revision as string,
      offset: cursor.offset as number,
      pageSize: cursor.pageSize as number,
      mode: cursor.mode as DocumentScanMode,
      includeRaw: cursor.includeRaw as boolean,
      document: document as unknown as DocumentScanDocument
    };
  } catch (error) {
    throw new ProbeError('INVALID_DOCUMENT_SCAN_CURSOR', {
      reason: error instanceof Error ? error.message : 'CURSOR_DECODE_FAILED'
    });
  }
}

/**
 * 在仍有后续节点时生成绑定 Revision 的下一页 cursor。
 *
 * @param state 当前快照会话、分页位置、页大小和节点总数。
 * @param state.session 当前固定快照会话。
 * @param state.offset 当前页起始节点下标。
 * @param state.pageSize 当前页大小。
 * @param state.totalNodes 当前文档节点总数。
 * @returns 下一页 cursor；已经到末页时返回 null。
 */
function createNextCursor(state: {
  session: DocumentSnapshotSession;
  offset: number;
  pageSize: number;
  totalNodes: number;
}): string | null {
  const nextOffset = state.offset + state.pageSize;
  if (nextOffset >= state.totalNodes) return null;
  const cursor: DocumentScanCursor = {
    version: 1,
    snapshotId: state.session.snapshotId,
    revision: state.session.content.revision,
    offset: nextOffset,
    pageSize: state.pageSize,
    mode: state.session.content.mode,
    includeRaw: state.session.includeRaw,
    document: readSnapshotDocument(state.session.content)
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * 仅使用 query-node-tree 摘要构建节点，不触发完整节点 Dump 查询。
 *
 * @param entry 层级摘要中的节点条目。
 * @returns 协议可校验的摘要节点。
 */
function buildHierarchyNodeResult(entry: HierarchyNodeEntry): DocumentNodeResult {
  return {
    kind: 'node',
    identity: {
      sessionId: null,
      objectUuid: entry.nodeUuid,
      assetUuid: null,
      fileId: null,
      typeId: entry.type,
      scriptUuid: null
    },
    name: entry.name,
    path: entry.path,
    parentObjectUuid: entry.parentUuid,
    childObjectUuids: entry.childUuids,
    siblingIndex: entry.siblingIndex,
    active: entry.active,
    layer: null,
    localTransform: null
  };
}

/**
 * 按 query-node-tree 的先序顺序展开节点和组件摘要。
 *
 * @param hierarchy Creator query-node-tree 原始结果。
 * @returns 带节点路径、父子关系和组件 UUID 的扁平条目。
 */
function flattenHierarchy(hierarchy: unknown): HierarchyNodeEntry[] {
  const entries: HierarchyNodeEntry[] = [];

  /**
   * 递归展开单个层级节点。
   *
   * @param value 当前节点摘要。
   * @param parentUuid 父节点 UUID；根节点为 null。
   * @param siblingIndex 当前节点同级顺序。
   * @param parentPrefabAssetUuid 父级节点当前所属 Prefab Asset UUID。
   * @param parentPrefabChain 父级节点已经建立的 Prefab 实例来源链。
   */
  const visit = (
    value: unknown,
    parentUuid: string | null,
    siblingIndex: number,
    parentPrefabAssetUuid: string | null,
    parentPrefabChain: HierarchyNodeEntry['prefabInstanceChain']
  ): void => {
    const node = readObject(value);
    const nodeUuid = readString(node.uuid);
    if (!nodeUuid) throw new ProbeError('DOCUMENT_NODE_UUID_MISSING');
    const nodePath = readString(node.path);
    const prefab = readObject(node.prefab);
    const prefabAssetUuid = readString(prefab.assetUuid);
    const prefabState = readNumber(prefab.state);
    const prefabIsNested = readBoolean(prefab.isNested);
    const prefabInstanceRoot = prefabAssetUuid !== null
      && prefabAssetUuid !== parentPrefabAssetUuid;
    const prefabInstanceChain = prefabInstanceRoot
      ? [...parentPrefabChain, {
          depth: parentPrefabChain.length,
          assetUuid: prefabAssetUuid,
          instanceNodeUuid: nodeUuid,
          state: prefabState,
          isNested: prefabIsNested
        }]
      : parentPrefabChain;
    const children = Array.isArray(node.children) ? node.children : [];
    const components = (Array.isArray(node.components) ? node.components : []).map(
      (componentValue, componentIndex): HierarchyComponentEntry => {
        const component = readObject(componentValue);
        const componentUuid = readString(component.value);
        if (!componentUuid) {
          throw new ProbeError('DOCUMENT_COMPONENT_UUID_MISSING', {
            nodeUuid,
            componentIndex
          });
        }
        return {
          componentUuid,
          nodeUuid,
          nodePath,
          componentIndex
        };
      }
    );
    entries.push({
      nodeUuid,
      name: readString(node.name),
      type: readString(node.type),
      active: readBoolean(node.active),
      path: nodePath,
      parentUuid,
      childUuids: children
        .map((child) => readString(readObject(child).uuid))
        .filter((uuid): uuid is string => uuid !== null),
      siblingIndex,
      components,
      prefabAssetUuid,
      prefabState,
      prefabIsNested,
      prefabInstanceRoot,
      prefabInstanceChain
    });
    children.forEach((child, index) => visit(
      child,
      nodeUuid,
      index,
      prefabAssetUuid ?? parentPrefabAssetUuid,
      prefabInstanceChain
    ));
  };

  visit(hierarchy, null, 0, null, []);
  return entries;
}

/**
 * 为单个实例根补齐宿主文档并重新编号来源链深度。
 *
 * @param entry 当前 Prefab 实例根的层级条目。
 * @param document 当前扫描文档的稳定资产身份。
 * @param rootNodeUuid 当前文档根节点运行时 UUID。
 * @returns 从宿主文档到当前源 Prefab 的有序实例来源链。
 */
function buildPrefabInstanceChain(
  entry: HierarchyNodeEntry,
  document: DocumentScanDocument,
  rootNodeUuid: string | null
): HierarchyNodeEntry['prefabInstanceChain'] {
  const chain = [...entry.prefabInstanceChain];
  if (document.assetUuid && chain[0]?.assetUuid !== document.assetUuid) {
    chain.unshift({
      depth: 0,
      assetUuid: document.assetUuid,
      instanceNodeUuid: rootNodeUuid,
      state: null,
      isNested: false
    });
  }
  return chain.map((link, depth) => ({ ...link, depth }));
}

/**
 * 将单个 query-node Dump 转换为文档快照节点。
 *
 * @param entry query-node-tree 中的节点摘要。
 * @param rawNode Creator query-node 完整 Dump。
 * @param includeRaw 是否在节点上保留完整原始 Dump。
 * @returns 协议可校验的节点结构。
 */
function buildNodeResult(
  entry: HierarchyNodeEntry,
  rawNode: unknown,
  includeRaw: boolean
): DocumentNodeResult {
  const normalized = normalizeNodeDump(rawNode, entry.siblingIndex);
  return {
    kind: 'node',
    identity: {
      sessionId: null,
      objectUuid: entry.nodeUuid,
      assetUuid: null,
      fileId: normalized.identity.fileId,
      typeId: entry.type,
      scriptUuid: null
    },
    name: normalized.name ?? entry.name,
    path: entry.path,
    parentObjectUuid: entry.parentUuid,
    childObjectUuids: entry.childUuids,
    siblingIndex: entry.siblingIndex,
    active: normalized.active,
    layer: normalized.layer,
    localTransform: normalized.transform,
    ...(includeRaw ? { raw: rawNode } : {})
  };
}

/**
 * 使用固定数量 worker 执行 Creator 查询，同时保持结果与输入顺序一致。
 *
 * @param values 待读取条目。
 * @param concurrency 并发 worker 数量。
 * @param worker 单个条目的异步读取方法。
 * @returns 与输入顺序一致的结果数组。
 */
async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let stopped = false;
  let hasFailure = false;
  let failure: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(values.length, 1)) },
    async () => {
      while (!stopped && nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        try {
          results[currentIndex] = await worker(values[currentIndex]);
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            failure = error;
          }
          stopped = true;
        }
      }
    }
  );
  await Promise.all(workers);
  if (hasFailure) throw failure;
  return results;
}

/**
 * 为 Creator 查询失败补充扫描阶段和对象上下文。
 *
 * @param code 失败阶段对应的稳定错误码。
 * @param details 节点或组件 UUID 等查询上下文。
 * @param query 实际 Creator 查询。
 * @returns Creator 查询结果。
 */
async function queryWithContext<T>(
  code: string,
  details: Record<string, unknown>,
  query: () => Promise<T>
): Promise<T> {
  try {
    return await query();
  } catch (error) {
    throw new ProbeError(code, {
      ...details,
      reason: error instanceof ProbeError
        ? error.code
        : error instanceof Error
          ? error.message
          : 'CREATOR_QUERY_FAILED'
    });
  }
}

/**
 * 规范化并校验 Creator 查询并发数。
 *
 * @param value 用户请求的并发数。
 * @returns 1 至 4 的并发数，默认 2。
 */
function readConcurrency(value: number | undefined): number {
  const concurrency = value ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new ProbeError('INVALID_DOCUMENT_SCAN_CONCURRENCY', { concurrency });
  }
  return concurrency;
}

/**
 * 规范化并校验快照页大小。
 *
 * @param value 用户请求的页大小。
 * @returns 1 至 500 的页大小，默认 100。
 */
function readPageSize(value: number | undefined): number {
  const pageSize = value ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new ProbeError('INVALID_DOCUMENT_SCAN_PAGE_SIZE', { pageSize });
  }
  return pageSize;
}

/**
 * 为无法从公开 Creator 3.8.8 API 确认的文档字段生成明确缺口。
 * 调用方传入的资产 UUID 仅作为提示，不能当成 Creator 已确认的当前文档身份。
 *
 * @param document 当前调用方已知的文档资产信息。
 * @returns 不可确认字段的 unresolved 列表。
 */
function buildDocumentUnresolved(
  requestedDocument: NonNullable<DocumentScanRequest['document']>,
  document: NonNullable<DocumentScanRequest['document']>,
  documentIdentity: DocumentIdentityEvidence
): Array<{
  path: string;
  reason: string;
  details?: unknown;
}> {
  const unresolved: Array<{ path: string; reason: string; details?: unknown }> = [];
  if (
    documentIdentity.assetUuid
    && requestedDocument.assetUuid
    && documentIdentity.assetUuid !== requestedDocument.assetUuid
  ) {
    unresolved.push({
      path: 'document.assetUuid',
      reason: 'DOCUMENT_IDENTITY_MISMATCH',
      details: {
        requestedAssetUuid: requestedDocument.assetUuid,
        observedAssetUuid: documentIdentity.assetUuid,
        source: documentIdentity.source
      }
    });
  } else if (!documentIdentity.assetUuid && requestedDocument.assetUuid) {
    unresolved.push({
      path: 'document.assetUuid',
      reason: 'DOCUMENT_IDENTITY_UNCONFIRMED',
      details: { requestedAssetUuid: requestedDocument.assetUuid }
    });
  } else if (!documentIdentity.assetUuid) {
    unresolved.push({ path: 'document.assetUuid', reason: 'PUBLIC_API_NOT_CONFIRMED' });
  }
  if (!document.path) {
    unresolved.push({ path: 'document.path', reason: 'PUBLIC_API_NOT_CONFIRMED' });
  }
  if (!document.filePath) {
    unresolved.push({ path: 'document.filePath', reason: 'PUBLIC_API_NOT_CONFIRMED' });
  }
  if (!document.documentType) {
    unresolved.push({ path: 'document.documentType', reason: 'PUBLIC_API_NOT_CONFIRMED' });
  }
  return unresolved;
}

function mergeDocumentIdentity(
  requestedDocument: NonNullable<DocumentScanRequest['document']>,
  documentIdentity: DocumentIdentityEvidence
): NonNullable<DocumentScanRequest['document']> {
  if (!documentIdentity.assetUuid) return requestedDocument;
  const metadataMatches = requestedDocument.assetUuid === documentIdentity.assetUuid;
  return {
    assetUuid: documentIdentity.assetUuid,
    path: metadataMatches ? requestedDocument.path : null,
    filePath: metadataMatches ? requestedDocument.filePath : null,
    documentType: metadataMatches && requestedDocument.documentType
      ? requestedDocument.documentType
      : readDocumentTypeFromMode(documentIdentity.mode)
  };
}

function buildDocumentIdentityRaw(
  documentIdentity: DocumentIdentityEvidence
): Record<string, unknown> {
  if (!documentIdentity.assetUuid && !documentIdentity.source && documentIdentity.failures.length === 0) {
    return {};
  }
  return {
    identitySource: documentIdentity.source,
    mode: documentIdentity.mode,
    failures: documentIdentity.failures
  };
}

function readDocumentTypeFromMode(mode: string | null): 'scene' | 'prefab' | null {
  if (!mode) return null;
  const normalized = mode.toLowerCase();
  if (normalized.includes('prefab')) return 'prefab';
  if (normalized.includes('scene')) return 'scene';
  return null;
}

/**
 * 对稳定排序后的快照内容计算 SHA-256 Revision。
 *
 * @param value 已稳定序列化的文档内容。
 * @returns 小写十六进制 SHA-256。
 */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 对对象键排序后序列化，避免字段插入顺序影响 Revision。
 *
 * @param value 任意可序列化值。
 * @returns 稳定 JSON 字符串。
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * 递归排序对象键并保留数组顺序。
 *
 * @param value 任意可序列化值。
 * @returns 键顺序稳定的值。
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortValue(child)]));
}

/**
 * 读取非空字符串字段。
 *
 * @param value 待读取值。
 * @returns 非空字符串；其它值返回 null。
 */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 读取布尔字段。
 *
 * @param value 待读取值。
 * @returns 布尔值；其它值返回 null。
 */
function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * 读取数字字段。
 *
 * @param value 待读取值。
 * @returns 数字值；其它类型返回 null。
 */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
