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
  revision: string;
  offset: number;
  pageSize: number;
  mode: DocumentScanMode;
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

/**
 * 扫描 Creator 当前打开文档并返回可分页的只读快照。
 *
 * @param request 扫描模式、分页、原始数据和并发配置。
 * @param source Creator Scene 消息读取适配器。
 * @param scriptPathsByUuid 脚本 UUID 到 db 路径的资产索引。
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
  }
): Promise<DocumentSnapshotResult> {
  const cursor = request.cursor ? decodeCursor(request.cursor) : null;
  const requestedMode = readMode(request.mode);
  const mode = cursor?.mode ?? requestedMode;
  const pageSize = readPageSize(request.pageSize ?? cursor?.pageSize);
  const offset = cursor?.offset ?? 0;
  const concurrency = readConcurrency(request.concurrency);
  const includeRaw = request.includeRaw === true;
  const requestedDocument = request.document ?? cursor?.document ?? {
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
    assertCursorRevision(cursor, revision);
    return {
      document: {
        ...document,
        available: true,
        raw: buildDocumentIdentityRaw(documentIdentity)
      },
      revision,
      mode,
      page: {
        offset,
        pageSize,
        totalNodes: nodes.length,
        nextCursor: createNextCursor({
          revision,
          offset,
          pageSize,
          totalNodes: nodes.length,
          mode,
          document
        })
      },
      nodes: nodes.slice(offset, offset + pageSize),
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
    };
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
  assertCursorRevision(cursor, revision);
  const pageNodeUuids = new Set(
    hierarchyEntries
      .slice(offset, offset + pageSize)
      .map((entry) => entry.nodeUuid)
  );
  const pageComponentSchemas = componentSchemas.filter((schema) =>
    pageNodeUuids.has(schema.nodeUuid)
  );
  const pagePrefabInstances = prefabInstances.filter((instance) =>
    instance.instanceRootObjectUuid !== null
    && pageNodeUuids.has(instance.instanceRootObjectUuid)
  );
  const unresolved = buildDocumentUnresolved(requestedDocument, document, documentIdentity);
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
    document: {
      ...document,
      available: true,
      raw: buildDocumentIdentityRaw(documentIdentity)
    },
    revision,
    mode,
    page: {
      offset,
      pageSize,
      totalNodes: nodes.length,
      nextCursor: createNextCursor({
        revision,
        offset,
        pageSize,
        totalNodes: nodes.length,
        mode,
        document
      })
    },
    nodes: nodes.slice(offset, offset + pageSize),
    componentSchemas: pageComponentSchemas,
    prefabInstances: pagePrefabInstances,
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
    unresolved,
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
  };
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
      || typeof cursor.revision !== 'string'
      || cursor.revision.length === 0
      || !Number.isInteger(cursor.offset)
      || (cursor.offset as number) < 0
      || !Number.isInteger(cursor.pageSize)
      || (cursor.pageSize as number) < 1
      || (cursor.pageSize as number) > 500
      || (cursor.mode !== 'summary' && cursor.mode !== 'full')
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
      revision: cursor.revision as string,
      offset: cursor.offset as number,
      pageSize: cursor.pageSize as number,
      mode: cursor.mode as DocumentScanMode,
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
 * @param state 当前 Revision、分页位置、页大小、节点总数和扫描模式。
 * @param state.revision 当前文档内容 Revision。
 * @param state.offset 当前页起始节点下标。
 * @param state.pageSize 当前页大小。
 * @param state.totalNodes 当前文档节点总数。
 * @param state.mode 当前扫描模式。
 * @param state.document 当前扫描文档的稳定资产身份。
 * @returns 下一页 cursor；已经到末页时返回 null。
 */
function createNextCursor(state: {
  revision: string;
  offset: number;
  pageSize: number;
  totalNodes: number;
  mode: DocumentScanMode;
  document: DocumentScanDocument;
}): string | null {
  const nextOffset = state.offset + state.pageSize;
  if (nextOffset >= state.totalNodes) return null;
  const cursor: DocumentScanCursor = {
    version: 1,
    revision: state.revision,
    offset: nextOffset,
    pageSize: state.pageSize,
    mode: state.mode,
    document: state.document
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * 校验 cursor 绑定的 Revision 是否仍等于当前文档内容。
 *
 * @param cursor 当前分页 cursor；首屏请求为 null。
 * @param revision 本次重新读取后计算出的 Revision。
 */
function assertCursorRevision(
  cursor: DocumentScanCursor | null,
  revision: string
): void {
  if (cursor && cursor.revision !== revision) {
    throw new ProbeError('SCAN_CURSOR_STALE', {
      expectedRevision: cursor.revision,
      currentRevision: revision
    });
  }
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
