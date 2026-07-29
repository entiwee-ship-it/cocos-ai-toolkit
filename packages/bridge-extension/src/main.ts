import { readFile } from 'node:fs/promises';
import { BridgeClient, type BridgeLifecycleEvent } from './bridge-client';
import { buildBridgeHello, probeEditorState } from './editor-state';
import type { CreatorDocumentIdentity } from './creator-document-identity';
import { debugEditorMessage } from './debug-editor-message';
import { editorPreviewMessageSource, nodeHttpPreviewProbe, openPreviewServer, readPreviewStatus, reloadPreviewPages } from './preview';
import { ProbeError } from './probe-errors';
import { probeAssets } from './asset-probe';
import { probeAssetIndex } from './asset-index';
import {
  executeMainAssetWrite,
  rollbackMainAssetWrite,
  type MainAssetWriteDependencies
} from './main-asset-write';
import { executeBridgeWrite } from './main-write-router';
import type { VerifiedOperation } from './write-verifier';
import {
  InMemoryWriteTransactionStore,
  WriteTransactionManager,
  captureWriteRevisionFromDocument,
  type RevisionFingerprint,
  type WriteRevisionCapture,
  type WriteRollbackEvidence,
  type WriteTransactionRecord
} from './transaction-manager';

const BRIDGE_VERSION = '0.2.5';
const DEFAULT_SERVER_URL = 'ws://127.0.0.1:32188';

const BRIDGE_LIFECYCLE_LOG_NAMES: Record<BridgeLifecycleEvent['type'], string> = {
  connecting: '正在连接探针服务',
  'socket-open': '探针连接已建立',
  'hello-sent': '已发送身份握手',
  ready: '扩展初始化完成',
  disconnected: '探针连接已断开',
  'retry-scheduled': '已安排重新连接',
  disposed: '扩展已卸载'
};

let client: BridgeClient | null = null;
let cachedScriptPathsByUuid: Array<[string, string]> | null = null;

type JsonObject = Record<string, unknown>;

const sceneMethods = {
  'probe.hierarchy': 'probeHierarchy',
  'probe.node': 'probeNode',
  'probe.prefab': 'probePrefab'
} as const;

// 阶段二通用写事务管理器：Revision 采集经 Scene 文档身份 + 资产文件哈希；
// 执行和回滚经 Scene 写通道（node-writer / component-writer / write-verifier）。
const writeTransactionManager = new WriteTransactionManager({
  store: new InMemoryWriteTransactionStore(),
  logger: (message) => {
    try {
      const editorGlobal = Editor as unknown as Record<string, unknown>;
      if (typeof editorGlobal.log === 'function') {
        (editorGlobal.log as (text: string) => void)(`[CocosAI] ${message}`);
      }
    } catch {
      // 日志失败不影响事务
    }
  },
  captureRevision: async () => captureWriteRevision(),
  execute: async (transaction) => executeBridgeWrite({
    operations: transaction.request.operations,
    save: transaction.request.save,
    undoGroup: transaction.request.undoGroup
  }, {
    executeMainAssetWrite: (input) => executeMainAssetWrite(input, buildMainAssetWriteDependencies()),
    executeSceneWrite: (input) => forwardToScene('writeExecute', input) as never
  }),
  rollback: async (transaction) => rollbackWriteTransaction(transaction)
});

export function load(): void {
  cachedScriptPathsByUuid = null;
  const project = Editor.Project as typeof Editor.Project & { uuid?: string };
  const app = Editor.App as typeof Editor.App & { version?: string };
  const projectPath = project.path;
  const projectId = process.env.COCOS_AI_PROJECT_ID ?? project.uuid ?? projectPath;
  const creatorVersion = process.env.COCOS_CREATOR_VERSION ?? app.version ?? '3.8.x-unknown';
  const probeUrl = process.env.COCOS_AI_PROBE_SERVER_URL ?? DEFAULT_SERVER_URL;

  const handlers: Readonly<Record<string, (payload: unknown) => Promise<unknown>>> = {
      'probe.editorState': () => probeEditorStateWithDocumentIdentity(),
      'probe.assets': (payload) => probeAssets(payload),
      'probe.assetIndex': () => probeAssetIndexWithScriptCache(),
      'probe.component': (payload) => probeComponent(payload),
      'probe.documentSnapshot': (payload) => probeDocumentSnapshot(payload),
      'probe.openAsset': async (payload) => {
        const request = payload as { uuid?: unknown };
        if (typeof request.uuid !== 'string' || !request.uuid) throw new ProbeError('UUID_REQUIRED');
        await Editor.Message.request('asset-db', 'open-asset', request.uuid);
        return { opened: true, uuid: request.uuid };
      },
      'probe.writeRevision': async () => {
        const capture = await captureWriteRevision();
        return { documentId: capture.documentId, revision: capture.fingerprint };
      },
      'probe.writePrepare': (payload) => writeTransactionManager.prepare(payload),
      'probe.writeConfirm': (payload) => writeTransactionManager.confirm(payload),
      'probe.transactionStatus': async (payload) => writeTransactionManager.status(payload),
      'probe.transactionList': async () => writeTransactionManager.list(),
      'probe.transactionRollback': (payload) => writeTransactionManager.rollback(payload),
      'probe.createPrefab': (payload) => forwardToScene('createPrefabFromNode', payload),
      'probe.deleteAsset': (payload) => forwardToScene('deleteAsset', payload),
      'probe.refreshAsset': (payload) => forwardToScene('refreshAsset', payload),
      'probe.debugPrefabLifecycle': (payload) => forwardToScene('debugPrefabLifecycle', payload),
      'probe.debugPrefabFacade': (payload) => forwardToScene('debugPrefabFacade', payload),
      'probe.debugEditorMessage': (payload) => debugEditorMessage(payload as Record<string, unknown>),
      'probe.previewOpen': () => openPreviewServer(editorPreviewMessageSource, nodeHttpPreviewProbe),
      'probe.previewStatus': () => readPreviewStatus(editorPreviewMessageSource),
      'probe.previewReload': () => reloadPreviewPages(editorPreviewMessageSource),
      ...Object.fromEntries(Object.entries(sceneMethods).map(([method, sceneMethod]) => [
        method,
        (payload: unknown) => forwardToScene(sceneMethod, payload)
      ]))
  };
  logBridgeLifecycle('扩展开始加载', {
    扩展版本: BRIDGE_VERSION,
    Creator版本: creatorVersion,
    项目ID: projectId,
    项目路径: projectPath,
    进程ID: process.pid,
    探针地址: probeUrl,
    能力数量: Object.keys(handlers).length
  });

  client = new BridgeClient({
    url: probeUrl,
    sessionToken: process.env.COCOS_AI_SESSION_TOKEN,
    hello: () => buildBridgeHello({
      processId: process.pid,
      projectPath,
      projectId,
      creatorVersion,
      bridgeVersion: BRIDGE_VERSION
    }),
    handlers,
    onLifecycleEvent: logBridgeClientLifecycle
  });
  client.connect();
}

export function unload(): void {
  client?.dispose();
  client = null;
  cachedScriptPathsByUuid = null;
}

function logBridgeClientLifecycle(event: BridgeLifecycleEvent): void {
  logBridgeLifecycle(
    BRIDGE_LIFECYCLE_LOG_NAMES[event.type],
    localizeBridgeLifecycleDetails(event)
  );
}

function localizeBridgeLifecycleDetails(event: BridgeLifecycleEvent): Record<string, unknown> {
  switch (event.type) {
    case 'connecting':
    case 'socket-open':
      return { 地址: event.url };
    case 'disconnected':
      return { 关闭码: event.code, 原因: event.reason };
    case 'retry-scheduled':
      return { 重试次数: event.attempt, 等待毫秒: event.delayMs };
    case 'hello-sent':
    case 'ready':
    case 'disposed':
      return {};
  }
}

function logBridgeLifecycle(eventName: string, details: Record<string, unknown>): void {
  const message = `[CocosAI][Bridge] ${eventName} ${JSON.stringify(details)}`;
  try {
    const editorGlobal = Editor as unknown as Record<string, unknown>;
    if (typeof editorGlobal.log === 'function') {
      (editorGlobal.log as (text: string) => void)(message);
      return;
    }
  } catch {
    // Creator 日志 API 不可用时继续回退到进程控制台。
  }
  console.log(message);
}

/**
 * 组合主进程公开状态探针与 Scene 进程当前文档身份。
 * 身份转发失败时按未解析保留证据（best-effort），不拖死整个编辑器状态探针。
 *
 * @returns 编辑器状态；document.assetUuid/mode/source 由 Scene 进程实测填充。
 */
async function probeEditorStateWithDocumentIdentity(): Promise<unknown> {
  const identity = await forwardToScene('editorStateDocumentIdentity', {})
    .catch((error: unknown): CreatorDocumentIdentity => ({
      assetUuid: null,
      mode: null,
      source: null,
      failures: [{
        source: 'scene.editorStateDocumentIdentity',
        reason: error instanceof Error ? error.message : String(error)
      }]
    })) as CreatorDocumentIdentity;
  return probeEditorState(identity);
}

async function readDocumentAsset(documentAssetUuid: string): Promise<Buffer> {
  const value = await Editor.Message.request('asset-db', 'query-asset-info', documentAssetUuid);
  const assetInfo = value && typeof value === 'object' ? value as { file?: unknown } : {};
  if (typeof assetInfo.file !== 'string' || !assetInfo.file) {
    throw new ProbeError('ASSET_FILE_PATH_UNAVAILABLE');
  }
  return readFile(assetInfo.file);
}

/**
 * 采集写事务 Revision 前置：Scene 侧文档身份 + 层级指纹，主进程补文档磁盘哈希。
 *
 * @returns 当前文档标识和五维指纹（assetDatabase/scriptCompilation 暂不采集）。
 */
async function captureWriteRevision(): Promise<WriteRevisionCapture> {
  const identity = await forwardToScene('writeDocumentIdentity', {}) as {
    documentId: string;
    hierarchySha256: string;
    prefabGraphSha256: string | null;
    dirty: boolean | null;
  };
  return captureWriteRevisionFromDocument(identity, readDocumentAsset);
}

/**
 * 回滚事务：经 Scene 写通道逆序应用逆操作，保存后重采指纹验证还原干净。
 *
 * @param transaction 待回滚的事务记录（携带执行证据）。
 * @returns 回滚证据。
 */
async function rollbackWriteTransaction(
  transaction: WriteTransactionRecord
): Promise<WriteRollbackEvidence> {
  const executed = Array.isArray(transaction.executionEvidence)
    ? transaction.executionEvidence as VerifiedOperation[]
    : [];
  const assetOnly = executed.length > 0
    && executed.every((entry) => entry.operation.type.startsWith('asset.'));
  const result = assetOnly
    ? await rollbackMainAssetWrite(executed, buildMainAssetWriteDependencies())
    : await forwardToScene('writeRollback', {
        executed,
        save: transaction.request.save
      }) as { succeeded: boolean; failedAt: number | null };
  if (!result.succeeded) {
    return { attempted: true, succeeded: false, undoGroupId: null, verifiedClean: false };
  }
  try {
    const capture = await captureWriteRevision();
    return {
      attempted: true,
      succeeded: true,
      undoGroupId: null,
      verifiedClean: fingerprintMatchesPrecondition(transaction.request.revision, capture.fingerprint)
    };
  } catch {
    return { attempted: true, succeeded: true, undoGroupId: null, verifiedClean: null };
  }
}

function buildMainAssetWriteDependencies(): MainAssetWriteDependencies {
  return {
    queryAssetInfo: async (uuidOrUrl) => {
      const value = await Editor.Message.request('asset-db', 'query-asset-info', uuidOrUrl).catch(() => null);
      const record = readObject(value);
      return typeof record.uuid === 'string' && record.uuid
        ? { uuid: record.uuid, type: typeof record.type === 'string' ? record.type : null }
        : null;
    },
    createAsset: async (assetUrl, _assetKind, content) => {
      const value = await Editor.Message.request('asset-db', 'create-asset', assetUrl, content as never);
      const record = readObject(value);
      if (typeof record.uuid !== 'string' || !record.uuid) {
        throw new ProbeError('ASSET_CREATE_FAILED', { assetUrl });
      }
      return { uuid: record.uuid, type: typeof record.type === 'string' ? record.type : null };
    },
    moveAsset: async (sourceUrl, targetUrl) => {
      await Editor.Message.request('asset-db', 'move-asset', sourceUrl, targetUrl);
    },
    readAssetMeta: async (assetUrl) => {
      const value = await Editor.Message.request('asset-db', 'query-asset-meta', assetUrl);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProbeError('ASSET_META_NOT_FOUND', { assetUrl });
      }
      return value as unknown as Record<string, unknown>;
    },
    writeAssetMeta: async (assetUrl, meta) => {
      await Editor.Message.request('asset-db', 'save-asset-meta', assetUrl, JSON.stringify(meta));
    },
    readAssetContent: async (assetUrl) => {
      const filePath = await Editor.Message.request('asset-db', 'query-path', assetUrl);
      if (typeof filePath !== 'string' || !filePath) {
        throw new ProbeError('ASSET_PATH_NOT_FOUND', { assetUrl });
      }
      return readFile(filePath, 'utf8');
    },
    saveAssetContent: async (assetUrl, content) => {
      const value = await Editor.Message.request('asset-db', 'save-asset', assetUrl, content);
      const record = readObject(value);
      if (typeof record.uuid !== 'string' || !record.uuid) {
        throw new ProbeError('ASSET_SAVE_FAILED', { assetUrl });
      }
    },
    deleteAsset: async (assetUrl) => {
      await Editor.Message.request('asset-db', 'delete-asset', assetUrl as never);
    }
  };
}

/** 指纹逐维比对：前置为 null 的维度不参与判定。 */
function fingerprintMatchesPrecondition(
  expected: RevisionFingerprint,
  actual: RevisionFingerprint
): boolean {
  return (['document', 'hierarchy', 'assetDatabase', 'scriptCompilation', 'prefabGraph'] as const)
    .every((scope) => expected[scope] === null || expected[scope] === undefined || expected[scope] === actual[scope]);
}

/**
 * 尽力读取资产索引中的脚本 UUID 路径，并转发当前文档快照请求到 Scene 进程。
 *
 * @param request 文档扫描模式、分页、原始数据和并发配置。
 * @returns Scene 进程生成的只读文档快照。
 */
async function probeDocumentSnapshot(request: unknown): Promise<unknown> {
  const scriptPathsByUuid = await readScriptPathsBestEffort();
  return forwardToScene('probeDocumentSnapshot', {
    request: readObject(request),
    scriptPathsByUuid
  });
}

/**
 * 尽力读取脚本资产索引，并转发单个组件的完整 Schema 请求到 Scene 进程。
 *
 * @param request 包含当前文档组件实例 UUID 的请求。
 * @returns 组件身份、属性、Inspector 元数据、脚本路径和原始 Dump。
 */
async function probeComponent(request: unknown): Promise<unknown> {
  const scriptPathsByUuid = await readScriptPathsBestEffort();
  return forwardToScene('probeComponent', {
    request: readObject(request),
    scriptPathsByUuid
  });
}

/**
 * 尽力读取脚本 UUID 路径，AssetDB 索引异常时保留组件和文档主查询能力。
 *
 * @returns 可跨 Creator 进程传输的 UUID、路径元组；索引不可用时返回空数组。
 */
async function readScriptPathsBestEffort(): Promise<Array<[string, string]>> {
  if (cachedScriptPathsByUuid !== null) {
    return cachedScriptPathsByUuid;
  }
  try {
    await probeAssetIndexWithScriptCache();
    return cachedScriptPathsByUuid ?? [];
  } catch {
    return [];
  }
}

async function probeAssetIndexWithScriptCache(): Promise<unknown> {
  const index = await probeAssetIndex();
  cachedScriptPathsByUuid = readScriptPathsByUuid(index);
  return index;
}

/**
 * 从可序列化资产索引中提取脚本 UUID 和稳定路径。
 *
 * @param value probeAssetIndex 返回的资产索引。
 * @returns 可跨 Creator 进程消息传输的 UUID、路径元组。
 */
function readScriptPathsByUuid(value: unknown): Array<[string, string]> {
  const index = readObject(value);
  const scripts = Array.isArray(index.scripts) ? index.scripts : [];
  const entries: Array<[string, string]> = [];
  for (const scriptValue of scripts) {
    const script = readObject(scriptValue);
    const assetUuid = typeof script.assetUuid === 'string' ? script.assetUuid : null;
    const scriptPath = typeof script.scriptPath === 'string'
      ? script.scriptPath
      : typeof script.filePath === 'string'
        ? script.filePath
        : null;
    if (assetUuid && scriptPath) entries.push([assetUuid, scriptPath]);
  }
  return entries;
}

async function forwardToScene(method: string, request: unknown): Promise<unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ProbeError('INVALID_REQUEST');
  }
  return Editor.Message.request('scene', 'execute-scene-script', {
    name: 'cocos-ai-bridge',
    method,
    args: [request]
  });
}

/**
 * 把未知输入收窄为普通对象。
 *
 * @param value 待解析输入。
 * @returns 普通对象；其它值返回空对象。
 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const methods: Record<string, (request: JsonObject) => Promise<unknown>> = {
  'probe-editor-state': () => probeEditorStateWithDocumentIdentity(),
  'probe-assets': (request) => probeAssets(request),
  'probe-asset-index': () => probeAssetIndexWithScriptCache(),
  'probe-document-snapshot': (request) => probeDocumentSnapshot(request),
  'probe-hierarchy': (request) => forwardToScene('probeHierarchy', request),
  'probe-node': (request) => forwardToScene('probeNode', request),
  'probe-component': (request) => probeComponent(request),
  'probe-prefab': (request) => forwardToScene('probePrefab', request),
  'probe-write-prepare': (request) => writeTransactionManager.prepare(request),
  'probe-write-confirm': (request) => writeTransactionManager.confirm(request),
  'probe-transaction-status': async (request) => writeTransactionManager.status(request),
  'probe-transaction-list': async () => writeTransactionManager.list(),
  'probe-transaction-rollback': (request) => writeTransactionManager.rollback(request)
};
