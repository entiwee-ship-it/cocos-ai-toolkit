import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BridgeClient } from './bridge-client';
import { buildBridgeHello, probeEditorState } from './editor-state';
import { ProbeError } from './probe-errors';
import { probeAssets } from './asset-probe';
import { probeAssetIndex } from './asset-index';
import { captureProbeRevision, restoreProbeAsset } from './probe-runtime';
import type { ProbePrepareRequest } from './probe-operation';
import {
  InMemoryProbeTransactionStore,
  ProbeTransactionCoordinator,
  type ProbeExecutionResult,
  type ProbeTransaction
} from './probe-transaction';
import {
  InMemoryWriteTransactionStore,
  WriteTransactionManager,
  type RevisionFingerprint,
  type WriteRevisionCapture,
  type WriteRollbackEvidence,
  type WriteTransactionRecord
} from './transaction-manager';

const BRIDGE_VERSION = '0.1.19';
const DEFAULT_SERVER_URL = 'ws://127.0.0.1:32188';

let client: BridgeClient | null = null;
let cachedScriptPathsByUuid: Array<[string, string]> | null = null;

type JsonObject = Record<string, unknown>;

const sceneMethods = {
  'probe.hierarchy': 'probeHierarchy',
  'probe.node': 'probeNode',
  'probe.prefab': 'probePrefab'
} as const;

const transactionStore = new InMemoryProbeTransactionStore();
const transactionCoordinator = new ProbeTransactionCoordinator({
  store: transactionStore,
  currentProjectPath: () => Editor.Project.path,
  captureRevision: (request) => captureCurrentRevision(request),
  execute: (transaction, recoveryContent) => executeTransaction(transaction, recoveryContent)
});

// 阶段二通用写事务管理器：Revision 采集经 Scene 文档身份 + 资产文件哈希；
// 执行和回滚经 Scene 写通道（node-writer / component-writer / write-verifier）。
const writeTransactionManager = new WriteTransactionManager({
  store: new InMemoryWriteTransactionStore(),
  captureRevision: async () => captureWriteRevision(),
  execute: async (transaction) => forwardToScene('writeExecute', {
    operations: transaction.request.operations,
    save: transaction.request.save,
    undoGroup: transaction.request.undoGroup
  }) as never,
  rollback: async (transaction) => rollbackWriteTransaction(transaction)
});

export function load(): void {
  cachedScriptPathsByUuid = null;
  const project = Editor.Project as typeof Editor.Project & { uuid?: string };
  const app = Editor.App as typeof Editor.App & { version?: string };
  const projectPath = project.path;
  const projectId = process.env.COCOS_AI_PROJECT_ID ?? project.uuid ?? projectPath;
  const creatorVersion = process.env.COCOS_CREATOR_VERSION ?? app.version ?? '3.8.x-unknown';

  client = new BridgeClient({
    url: process.env.COCOS_AI_PROBE_SERVER_URL ?? DEFAULT_SERVER_URL,
    sessionToken: process.env.COCOS_AI_SESSION_TOKEN,
    hello: () => buildBridgeHello({
      processId: process.pid,
      projectPath,
      projectId,
      creatorVersion,
      bridgeVersion: BRIDGE_VERSION
    }),
    handlers: {
      'probe.editorState': () => probeEditorState(),
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
      'probe.undoSavePrepare': (payload) => transactionCoordinator.prepare(payload),
      'probe.undoSaveConfirm': (payload) => transactionCoordinator.confirm(payload),
      'probe.undoSaveStatus': async (payload) => transactionCoordinator.status(payload),
      'probe.writePrepare': (payload) => writeTransactionManager.prepare(payload),
      'probe.writeConfirm': (payload) => writeTransactionManager.confirm(payload),
      'probe.transactionStatus': async (payload) => writeTransactionManager.status(payload),
      'probe.transactionList': async () => writeTransactionManager.list(),
      'probe.transactionRollback': (payload) => writeTransactionManager.rollback(payload),
      'probe.createPrefab': (payload) => forwardToScene('createPrefabFromNode', payload),
      'probe.createAsset': (payload) => forwardToScene('createAssetEmpty', payload),
      'probe.deleteAsset': (payload) => forwardToScene('deleteAsset', payload),
      'probe.refreshAsset': (payload) => forwardToScene('refreshAsset', payload),
      'probe.debugPrefabLifecycle': (payload) => forwardToScene('debugPrefabLifecycle', payload),
      ...Object.fromEntries(Object.entries(sceneMethods).map(([method, sceneMethod]) => [
        method,
        (payload: unknown) => forwardToScene(sceneMethod, payload)
      ]))
    }
  });
  client.connect();
}

export function unload(): void {
  client?.dispose();
  client = null;
  cachedScriptPathsByUuid = null;
}

async function captureCurrentRevision(request: ProbePrepareRequest) {
  return captureProbeRevision(request, {
    queryAssetInfo: (documentAssetUuid) => Editor.Message.request('asset-db', 'query-asset-info', documentAssetUuid),
    readFile,
    queryDirty: () => Editor.Message.request('scene', 'query-dirty'),
    queryNodeTree: () => Editor.Message.request('scene', 'query-node-tree')
  });
}

async function executeTransaction(
  transaction: ProbeTransaction,
  recoveryContent?: string
): Promise<ProbeExecutionResult> {
  const sceneResult = await forwardToScene('probeUndoSaveConfirm', transaction) as ProbeExecutionResult;
  if (recoveryContent === undefined) {
    throw new ProbeError('RECOVERY_CONTENT_UNAVAILABLE');
  }
  const recovery = await restoreProbeAsset({
    documentAssetUuid: transaction.documentAssetUuid,
    baselineSha256: transaction.baseline.assetSha256,
    recoveryContent
  }, {
    readCurrentContent: () => readDocumentAsset(transaction.documentAssetUuid),
    saveAsset: (documentAssetUuid, content) => Editor.Message.request(
      'asset-db',
      'save-asset',
      documentAssetUuid,
      content
    )
  });
  const finalSnapshot = await captureCurrentRevision(transaction);
  const diskHashRestored = recovery.diskHashRestored
    && finalSnapshot.assetSha256 === transaction.baseline.assetSha256;
  const editorStateRestored = finalSnapshot.hierarchySha256 === transaction.baseline.hierarchySha256
    && finalSnapshot.dirty === transaction.baseline.dirty
    && finalSnapshot.parentNodeUuid === transaction.baseline.parentNodeUuid
    && finalSnapshot.existingProbeNodeUuid === null;

  return {
    ...sceneResult,
    diskHashRestored,
    recoveryMethod: recovery.recoveryMethod,
    status: diskHashRestored && editorStateRestored ? 'rolled-back' : 'manual-recovery-required',
    rolledBack: {
      ...sceneResult.rolledBack,
      diskHashRestored,
      editorStateRestored,
      finalAssetSha256: recovery.finalAssetSha256,
      finalHierarchySha256: finalSnapshot.hierarchySha256
    }
  };
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
 * @returns 当前文档标识和四维指纹（assetDatabase/scriptCompilation 暂不采集）。
 */
async function captureWriteRevision(): Promise<WriteRevisionCapture> {
  const identity = await forwardToScene('writeDocumentIdentity', {}) as {
    documentId: string;
    hierarchySha256: string;
    dirty: boolean | null;
  };
  const content = await readDocumentAsset(identity.documentId);
  const documentSha256 = createHash('sha256').update(content).digest('hex');
  return {
    documentId: identity.documentId,
    fingerprint: {
      document: `sha256:${documentSha256}`,
      hierarchy: `sha256:${identity.hierarchySha256}`,
      assetDatabase: null,
      scriptCompilation: null
    }
  };
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
  const result = await forwardToScene('writeRollback', {
    executed: transaction.executionEvidence ?? [],
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

/** 指纹逐维比对：前置为 null 的维度不参与判定。 */
function fingerprintMatchesPrecondition(
  expected: RevisionFingerprint,
  actual: RevisionFingerprint
): boolean {
  return (['document', 'hierarchy', 'assetDatabase', 'scriptCompilation'] as const)
    .every((scope) => expected[scope] === null || expected[scope] === actual[scope]);
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
  'probe-editor-state': () => probeEditorState(),
  'probe-assets': (request) => probeAssets(request),
  'probe-asset-index': () => probeAssetIndexWithScriptCache(),
  'probe-document-snapshot': (request) => probeDocumentSnapshot(request),
  'probe-hierarchy': (request) => forwardToScene('probeHierarchy', request),
  'probe-node': (request) => forwardToScene('probeNode', request),
  'probe-component': (request) => probeComponent(request),
  'probe-prefab': (request) => forwardToScene('probePrefab', request),
  'probe-undo-save-prepare': (request) => transactionCoordinator.prepare(request),
  'probe-undo-save-confirm': (request) => transactionCoordinator.confirm(request),
  'probe-undo-save-status': async (request) => transactionCoordinator.status(request),
  'probe-write-prepare': (request) => writeTransactionManager.prepare(request),
  'probe-write-confirm': (request) => writeTransactionManager.confirm(request),
  'probe-transaction-status': async (request) => writeTransactionManager.status(request),
  'probe-transaction-list': async () => writeTransactionManager.list(),
  'probe-transaction-rollback': (request) => writeTransactionManager.rollback(request)
};
