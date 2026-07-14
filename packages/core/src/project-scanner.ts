import { randomUUID } from 'node:crypto';
import {
  AssetRecordSchema,
  DiagnosticSchema,
  DocumentAssetRecordSchema,
  DocumentSnapshotSchema,
  PROTOCOL_VERSION,
  ProjectScanReportSchema,
  ScriptAssetRecordSchema,
  UnresolvedItemSchema,
  type AssetRecord,
  type Diagnostic,
  type DocumentAssetRecord,
  type DocumentSnapshot,
  type ProjectScanReport,
  type ScriptAssetRecord,
  type UnresolvedItem
} from '@cocos-ai/protocol';
import { collectProjectCoverage } from './coverage-collector.js';
import {
  buildPrefabGraphFromSnapshots,
  type PrefabDocumentSnapshotInput
} from './prefab-graph.js';
import {
  assertCheckpointCompatible,
  createAssetManifestHash,
  createScanCheckpoint,
  parseScanCheckpoint,
  type ScanCheckpoint,
  type ScanCheckpointContext,
  type ScanCheckpointFailure,
  type ScanParameters
} from './scan-checkpoint.js';
import {
  NoopScanReportWriter,
  type ScanReportWriter
} from './report-writer.js';

export const PROJECT_SCAN_READONLY_METHODS = [
  'server.editors',
  'probe.editorState',
  'probe.assetIndex',
  'probe.openAsset',
  'probe.documentSnapshot'
] as const;

type ProjectScanReadonlyMethod = typeof PROJECT_SCAN_READONLY_METHODS[number];

const PROJECT_SCAN_READONLY_METHOD_SET = new Set<string>(
  PROJECT_SCAN_READONLY_METHODS
);

const REQUIRED_SCAN_CAPABILITIES = PROJECT_SCAN_READONLY_METHODS.filter(
  (method) => method !== 'server.editors'
);

export interface ReadonlyProbeClient {
  request(method: string, payload: unknown): Promise<unknown>;
}

export interface ProjectScanOptions {
  projectId: string;
  editorInstanceId?: string;
  pageSize?: number;
  includeRaw?: boolean;
  concurrency?: number;
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
  checkpoint?: ScanCheckpoint;
}

export interface ProjectScanResult extends ProjectScanReport {
  checkpoint: ScanCheckpoint;
}

interface EditorSession {
  editorInstanceId: string;
  projectId: string;
  projectPath: string;
  creatorVersion: string;
  bridgeVersion: string;
  capabilities: string[];
}

interface AssetIndexResponse {
  assets: AssetRecord[];
  scripts: ScriptAssetRecord[];
  documents: DocumentAssetRecord[];
  unresolved: UnresolvedItem[];
}

export class ProjectScanner {
  constructor(
    private readonly client: ReadonlyProbeClient,
    private readonly writer: ScanReportWriter = new NoopScanReportWriter()
  ) {}

  /**
   * 严格按编辑器选择、资产索引、逐文档打开、快照、checkpoint、覆盖率和建图顺序执行只读扫描。
   *
   * @param options 项目选择、分页、Creator 等待和可选续扫 checkpoint。
   * @returns 最终项目报告和最新 checkpoint。
   */
  async scan(options: ProjectScanOptions): Promise<ProjectScanResult> {
    const resumeCheckpoint = options.checkpoint
      ? parseScanCheckpoint(options.checkpoint)
      : undefined;
    const startedAt = new Date().toISOString();
    const parameters = readScanParameters(options);
    const sessions = readEditorSessions(await this.requestReadonly('server.editors', {}));
    const session = selectEditorSession(sessions, options.projectId, options.editorInstanceId);
    assertScanCapabilities(session);
    const selector = {
      projectId: session.projectId,
      editorInstanceId: session.editorInstanceId
    };
    const assetIndex = readAssetIndex(await this.requestReadonly('probe.assetIndex', {
      selector,
      params: {}
    }));
    const assetUuids = assetIndex.documents.map((document) => document.assetUuid);
    const context: ScanCheckpointContext = {
      projectId: session.projectId,
      editorInstanceId: session.editorInstanceId,
      projectPath: session.projectPath,
      creatorVersion: session.creatorVersion,
      bridgeVersion: session.bridgeVersion,
      protocolVersion: PROTOCOL_VERSION,
      parameters,
      assetManifestHash: createAssetManifestHash(assetIndex.assets, assetIndex.documents),
      assetUuids
    };

    if (resumeCheckpoint) {
      assertCheckpointCompatible(resumeCheckpoint, context);
    }

    const scanId = resumeCheckpoint?.scanId ?? randomUUID();
    const snapshotsByAsset = new Map<string, DocumentSnapshot>();
    for (const snapshot of resumeCheckpoint?.documents ?? []) {
      const assetUuid = snapshot.document.assetUuid;
      if (assetUuid && assetUuids.includes(assetUuid)) snapshotsByAsset.set(assetUuid, snapshot);
    }
    const completedAssetUuids = [...(resumeCheckpoint?.completedAssetUuids ?? [])];
    const completedAssets = new Set(completedAssetUuids);
    const failures = [...(resumeCheckpoint?.failures ?? [])];
    const unresolved = resumeCheckpoint
      ? [...resumeCheckpoint.unresolved]
      : prefixUnresolved(assetIndex.unresolved, 'assetIndex');
    const diagnostics: Diagnostic[] = failures.map((failure) => ({
      code: failure.code,
      message: failure.message,
      severity: 'error',
      details: { assetUuid: failure.assetUuid, ...readDetails(failure.details) }
    }));
    let checkpoint = createScanCheckpoint({
      scanId,
      context,
      completedAssetUuids,
      failures,
      documents: sortSnapshots(assetIndex.documents, snapshotsByAsset),
      unresolved
    });
    for (const document of assetIndex.documents) {
      if (completedAssets.has(document.assetUuid)) continue;
      try {
        await this.requestReadonly('probe.openAsset', {
          selector,
          params: { uuid: document.assetUuid }
        });
        await this.waitUntilDocumentReadable(
          selector,
          options.readyTimeoutMs ?? 10_000,
          options.readyPollIntervalMs ?? 100
        );
        const snapshot = await this.readCompleteDocument(selector, document, parameters);
        snapshotsByAsset.set(document.assetUuid, snapshot);
        unresolved.push(...prefixUnresolved(
          snapshot.unresolved,
          `documents.${document.assetUuid}`
        ));
      } catch (error) {
        const code = readErrorCode(error);
        const failure: ScanCheckpointFailure = {
          assetUuid: document.assetUuid,
          code,
          message: `文档 ${document.assetUuid} 只读扫描失败`,
          details: { error: error instanceof Error ? error.message : String(error) }
        };
        failures.push(failure);
        unresolved.push({
          path: `documents.${document.assetUuid}`,
          reason: code,
          severity: 'error',
          details: failure.details
        });
        diagnostics.push({
          code,
          message: failure.message,
          severity: 'error',
          details: { assetUuid: document.assetUuid, ...readDetails(failure.details) }
        });
      }

      completedAssets.add(document.assetUuid);
      completedAssetUuids.push(document.assetUuid);
      checkpoint = createScanCheckpoint({
        scanId,
        context,
        completedAssetUuids,
        failures,
        documents: sortSnapshots(assetIndex.documents, snapshotsByAsset),
        unresolved
      });
      await this.writer.writeCheckpoint(checkpoint);
    }

    const documents = sortSnapshots(assetIndex.documents, snapshotsByAsset);
    const prefabGraph = buildPrefabGraphFromSnapshots(
      documents as unknown as PrefabDocumentSnapshotInput[]
    );
    diagnostics.push(...prefabGraph.diagnostics.map((diagnostic) =>
      DiagnosticSchema.parse(diagnostic)
    ));
    const coverage = collectProjectCoverage({
      assets: assetIndex.assets,
      scripts: assetIndex.scripts,
      documents: assetIndex.documents,
      snapshots: documents
    });
    const status = unresolved.length > 0
      || failures.length > 0
      || prefabGraph.blocked
      ? 'completed-with-gaps'
      : 'completed';
    const report = ProjectScanReportSchema.parse({
      scanId,
      status,
      project: {
        projectId: session.projectId,
        projectPath: session.projectPath,
        creatorVersion: session.creatorVersion
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      assets: assetIndex.assets,
      scripts: assetIndex.scripts,
      documents,
      prefabGraph,
      coverage,
      unresolved: dedupeUnresolved(unresolved),
      diagnostics
    });
    checkpoint = createScanCheckpoint({
      scanId,
      context,
      completedAssetUuids,
      failures,
      documents,
      unresolved: report.unresolved
    });
    await this.writer.writeReport(report);
    await this.writer.writeCheckpoint(checkpoint);
    return { ...report, checkpoint };
  }

  /**
   * 仅允许扫描器调用固定只读方法，阻止保存、Undo、创建、删除和属性写入入口混入扫描链路。
   *
   * @param method 项目扫描允许使用的 Server 或 Bridge 方法。
   * @param payload 发送给 Probe Server 的只读请求载荷。
   * @returns Probe Server 返回的原始载荷。
   */
  private async requestReadonly(
    method: ProjectScanReadonlyMethod,
    payload: unknown
  ): Promise<unknown> {
    if (!PROJECT_SCAN_READONLY_METHOD_SET.has(method)) {
      throw new Error(`PROJECT_SCAN_METHOD_NOT_READONLY:${method}`);
    }
    return this.client.request(method, payload);
  }

  /**
   * 等待 Creator Scene 和 AssetDB 同时进入可读状态。
   *
   * @param selector 已选中的唯一编辑器实例。
   * @param timeoutMs 最大等待毫秒数。
   * @param pollIntervalMs 轮询间隔毫秒数。
   */
  private async waitUntilDocumentReadable(
    selector: { projectId: string; editorInstanceId: string },
    timeoutMs: number,
    pollIntervalMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const state = readObject(await this.requestReadonly('probe.editorState', {
        selector,
        params: {}
      }));
      const ready = readObject(state.ready);
      if (ready.scene === true && ready.assetDatabase === true) return;
      if (Date.now() >= deadline) throw new Error('DOCUMENT_NOT_READY');
      await delay(pollIntervalMs);
    }
  }

  /**
   * 按 cursor 读取一个文档的全部分页并合并为单个快照。
   *
   * @param selector 已选中的唯一编辑器实例。
   * @param document 当前 Scene/Prefab 资产记录。
   * @param parameters 文档分页、原始数据和并发参数。
   * @returns 不含 nextCursor 的完整文档快照。
   */
  private async readCompleteDocument(
    selector: { projectId: string; editorInstanceId: string },
    document: DocumentAssetRecord,
    parameters: ScanParameters
  ): Promise<DocumentSnapshot> {
    const pages: DocumentSnapshot[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;

    while (true) {
      const page = DocumentSnapshotSchema.parse(await this.requestReadonly(
        'probe.documentSnapshot',
        {
          selector,
          params: {
            mode: 'full',
            cursor,
            pageSize: parameters.pageSize,
            includeRaw: parameters.includeRaw,
            concurrency: parameters.concurrency,
            document: {
              assetUuid: document.assetUuid,
              path: document.path,
              filePath: document.filePath,
              documentType: document.documentType
            }
          }
        }
      ));
      // Creator 尚未独立确认当前文档 UUID 时，不能把请求回显值当成资产身份。
      if (page.unresolved.some((item) =>
        item.path === 'document.assetUuid'
        && item.reason === 'DOCUMENT_IDENTITY_UNCONFIRMED'
      )) {
        throw new Error('DOCUMENT_IDENTITY_UNCONFIRMED');
      }
      if (page.document.assetUuid !== document.assetUuid) {
        throw new Error('DOCUMENT_IDENTITY_MISMATCH');
      }
      if (pages[0] && page.revision !== pages[0].revision) {
        throw new Error('DOCUMENT_REVISION_CHANGED_DURING_PAGING');
      }
      pages.push(page);
      cursor = page.page.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('DOCUMENT_CURSOR_LOOP');
      cursors.add(cursor);
    }

    return mergeDocumentPages(pages);
  }
}

/**
 * 合并同一 Revision 的文档分页，并把页内组件与 Prefab unresolved 索引改为全局索引。
 *
 * @param pages 同一文档按 cursor 顺序返回的分页。
 * @returns 可直接写入项目报告的单文档快照。
 */
export function mergeDocumentPages(pages: DocumentSnapshot[]): DocumentSnapshot {
  const first = pages[0];
  if (!first) throw new Error('DOCUMENT_SNAPSHOT_EMPTY');
  const nodes: DocumentSnapshot['nodes'] = [];
  const componentSchemas: DocumentSnapshot['componentSchemas'] = [];
  const prefabInstances: DocumentSnapshot['prefabInstances'] = [];
  const unresolved: UnresolvedItem[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const page of pages) {
    if (page.revision !== first.revision) {
      throw new Error('DOCUMENT_REVISION_CHANGED_DURING_PAGING');
    }
    const componentOffset = componentSchemas.length;
    const prefabOffset = prefabInstances.length;
    nodes.push(...page.nodes);
    componentSchemas.push(...page.componentSchemas);
    prefabInstances.push(...page.prefabInstances);
    unresolved.push(...page.unresolved.map((item) => ({
      ...item,
      path: rebaseSnapshotPath(item.path, componentOffset, prefabOffset)
    })));
    diagnostics.push(...page.diagnostics);
  }

  const last = pages[pages.length - 1];
  return DocumentSnapshotSchema.parse({
    ...first,
    page: {
      offset: 0,
      pageSize: first.page.pageSize,
      totalNodes: first.page.totalNodes,
      nextCursor: null
    },
    nodes,
    componentSchemas,
    prefabInstances,
    coverage: last.coverage,
    unresolved: dedupeUnresolved(unresolved),
    diagnostics
  });
}

function readScanParameters(options: ProjectScanOptions): ScanParameters {
  const pageSize = options.pageSize ?? 100;
  const concurrency = options.concurrency ?? 2;
  const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  const readyPollIntervalMs = options.readyPollIntervalMs ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error('INVALID_SCAN_PAGE_SIZE');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('INVALID_SCAN_CONCURRENCY');
  }
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 0) {
    throw new Error('INVALID_READY_TIMEOUT');
  }
  if (!Number.isInteger(readyPollIntervalMs) || readyPollIntervalMs < 0) {
    throw new Error('INVALID_READY_POLL_INTERVAL');
  }
  return {
    pageSize,
    includeRaw: options.includeRaw === true,
    concurrency
  };
}

function readEditorSessions(value: unknown): EditorSession[] {
  if (!Array.isArray(value)) throw new Error('EDITOR_SESSION_LIST_INVALID');
  return value.map((item) => {
    const session = readObject(item);
    if (
      typeof session.editorInstanceId !== 'string'
      || typeof session.projectId !== 'string'
      || typeof session.projectPath !== 'string'
      || typeof session.creatorVersion !== 'string'
      || typeof session.bridgeVersion !== 'string'
      || !Array.isArray(session.capabilities)
      || !session.capabilities.every((capability) => typeof capability === 'string')
    ) {
      throw new Error('EDITOR_SESSION_INVALID');
    }
    return session as unknown as EditorSession;
  });
}

function selectEditorSession(
  sessions: EditorSession[],
  projectId: string,
  editorInstanceId?: string
): EditorSession {
  const matches = sessions.filter((session) =>
    session.projectId === projectId
    && (!editorInstanceId || session.editorInstanceId === editorInstanceId)
  );
  if (matches.length === 0) throw new Error('EDITOR_INSTANCE_NOT_FOUND');
  if (matches.length > 1) throw new Error('MULTIPLE_EDITOR_INSTANCES');
  return matches[0];
}

function assertScanCapabilities(session: EditorSession): void {
  const missing = REQUIRED_SCAN_CAPABILITIES.filter((capability) =>
    !session.capabilities.includes(capability)
  );
  if (missing.length > 0) {
    throw new Error(`EDITOR_CAPABILITY_MISSING:${missing.join(',')}`);
  }
}

function readAssetIndex(value: unknown): AssetIndexResponse {
  const index = readObject(value);
  try {
    return {
      assets: AssetRecordSchema.array().parse(index.assets),
      scripts: ScriptAssetRecordSchema.array().parse(index.scripts),
      documents: DocumentAssetRecordSchema.array().parse(index.documents),
      unresolved: UnresolvedItemSchema.array().parse(index.unresolved)
    };
  } catch (error) {
    throw new Error(`ASSET_INDEX_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
}

function sortSnapshots(
  documents: DocumentAssetRecord[],
  snapshotsByAsset: Map<string, DocumentSnapshot>
): DocumentSnapshot[] {
  return documents.flatMap((document) => {
    const snapshot = snapshotsByAsset.get(document.assetUuid);
    return snapshot ? [snapshot] : [];
  });
}

function prefixUnresolved(items: UnresolvedItem[], prefix: string): UnresolvedItem[] {
  return items.map((item) => ({
    ...item,
    path: item.path ? `${prefix}.${item.path}` : prefix
  }));
}

function dedupeUnresolved(items: UnresolvedItem[]): UnresolvedItem[] {
  const unique = new Map<string, UnresolvedItem>();
  for (const item of items) unique.set(JSON.stringify(item), item);
  return [...unique.values()];
}

function rebaseSnapshotPath(
  path: string,
  componentOffset: number,
  prefabOffset: number
): string {
  const componentMatch = /^componentSchemas\.(\d+)(.*)$/.exec(path);
  if (componentMatch) {
    return `componentSchemas.${Number(componentMatch[1]) + componentOffset}${componentMatch[2]}`;
  }
  const prefabMatch = /^prefabInstances\.(\d+)(.*)$/.exec(path);
  if (prefabMatch) {
    return `prefabInstances.${Number(prefabMatch[1]) + prefabOffset}${prefabMatch[2]}`;
  }
  return path;
}

function readErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bridgePrefix = 'BRIDGE_REQUEST_FAILED: ';
  if (message.startsWith(bridgePrefix)) {
    try {
      const payload = JSON.parse(message.slice(bridgePrefix.length)) as { code?: unknown };
      if (typeof payload.code === 'string') return payload.code;
    } catch {
      return 'BRIDGE_REQUEST_FAILED';
    }
  }
  const match = /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(message);
  return match?.[1] ?? 'DOCUMENT_SCAN_FAILED';
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
