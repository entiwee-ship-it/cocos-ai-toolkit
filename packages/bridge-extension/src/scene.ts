import {
  clearDefaultDocumentScanSessions,
  scanCurrentDocument,
  type DocumentScanRequest
} from './document-scan';
import { ProbeError } from './probe-errors';
import { normalizeComponentDump, normalizeHierarchyTree, normalizeNodeDump, normalizePrefabDump, resolvePrefabOverrideValues } from './scene-probe';
import { normalizeProbeProjectPath } from './probe-operation';
import { executeProbeSceneOperation } from './probe-scene-operation';
import { resolveCreatorDocumentIdentity } from './creator-document-identity';
import { executeNodeWriteOperation } from './node-writer';
import { executeComponentWriteOperation } from './component-writer';
import { saveAndVerifyWriteTransaction, type VerifiedOperation } from './write-verifier';
import {
  executeWriteSceneOperations,
  rollbackWriteSceneOperations,
  type WriteSceneChannelDependencies
} from './write-scene-channel';
import {
  buildComponentWriterDependencies,
  buildNodeWriterDependencies,
  buildWriteVerifierDependencies,
  captureCurrentDocumentIdentity
} from './write-creator-deps';
import type { WriteOperation } from './transaction-manager';

const { director } = require('cc') as { director: { getScene(): unknown } };

function notImplemented(): never {
  throw new ProbeError('NOT_IMPLEMENTED');
}

async function probeHierarchy(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const rootUuid = typeof input.rootUuid === 'string' ? input.rootUuid : undefined;
  const depth = typeof input.depth === 'number' ? input.depth : 4;
  const raw = await Editor.Message.request('scene', 'query-node-tree', ...(rootUuid ? [rootUuid] : []));
  return { data: normalizeHierarchyTree(raw, depth), raw, source: 'message-api' };
}

async function probeNode(request: unknown): Promise<unknown> {
  const uuid = requireUuid(unwrapRequest(request));
  const raw = await Editor.Message.request('scene', 'query-node', uuid);
  return { data: normalizeNodeDump(raw), raw, source: 'message-api' };
}

async function probeComponent(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const componentRequest = 'request' in input ? input.request : input;
  const uuid = requireUuid(componentRequest);
  const scriptPathsByUuid = readScriptPathsByUuid(input.scriptPathsByUuid);
  const raw = await Editor.Message.request('scene', 'query-component', uuid);
  return {
    data: normalizeComponentDump(raw, scriptPathsByUuid),
    raw,
    source: 'message-api'
  };
}

/**
 * 读取当前 Creator 文档的摘要或完整分页快照。
 *
 * @param request 主进程传入的扫描请求和脚本 UUID 路径元组。
 * @returns 当前文档只读快照。
 */
async function probeDocumentSnapshot(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const scanRequest = readObject(input.request) as unknown as DocumentScanRequest;
  const scriptPathsByUuid = readScriptPathsByUuid(input.scriptPathsByUuid);
  const documentIdentity = await resolveCreatorDocumentIdentity(globalThis);
  return scanCurrentDocument(scanRequest, {
    queryNodeTree: () => Editor.Message.request('scene', 'query-node-tree'),
    queryNode: (nodeUuid) => Editor.Message.request('scene', 'query-node', nodeUuid),
    queryComponent: (componentUuid) => Editor.Message.request(
      'scene',
      'query-component',
      componentUuid
    )
  }, scriptPathsByUuid, documentIdentity);
}

/**
 * 读取当前节点的 Prefab 来源、实例链、FileID、Override 三值和宿主路径。
 *
 * @param request 包含目标节点运行时 UUID 的只读探针请求。
 * @returns Creator 当前文档中该 Prefab 实例的结构化数据和原始证据。
 */
async function probePrefab(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const uuid = typeof input.nodeUuid === 'string' ? input.nodeUuid : null;
  if (!uuid) throw new ProbeError('NODE_UUID_REQUIRED');
  const [raw, rawTree] = await Promise.all([
    Editor.Message.request('scene', 'query-node', uuid),
    Editor.Message.request('scene', 'query-node-tree')
  ]);
  const chain = findPrefabInstanceChain(readObject(rawTree), uuid);
  const ownerDocumentAssetUuid = chain.length > 0 ? chain[0].assetUuid : null;
  const hierarchyNode = findHierarchyNodeByUuid(readObject(rawTree), uuid);
  const hostNodePath = typeof hierarchyNode?.path === 'string' ? hierarchyNode.path : null;
  const normalized = normalizePrefabDump(raw, ownerDocumentAssetUuid, hostNodePath);
  const runtimeNode = findRuntimeNodeByUuid(readObject(director.getScene()), uuid);
  const runtimePrefabInfo = readObject(runtimeNode?._prefab ?? runtimeNode?.__prefab__);
  const sourceAsset = readObject(runtimePrefabInfo.asset);
  const sourceRoot = sourceAsset.data ?? null;
  const data = resolvePrefabOverrideValues(normalized, sourceRoot, runtimeNode);
  return {
    document: { assetUuid: ownerDocumentAssetUuid, nodeUuid: uuid, source: 'message-api' },
    data: { ...data, instanceChain: chain },
    source: 'message-api',
    raw: { node: raw, tree: rawTree }
  };
}

/**
 * 按运行时 UUID 查找 query-node-tree 中的层级节点。
 *
 * @param root 当前文档的层级树根节点。
 * @param targetUuid 待查找节点的运行时 UUID。
 * @returns 命中的层级节点；不存在时返回 null。
 */
function findHierarchyNodeByUuid(
  root: Record<string, unknown>,
  targetUuid: string
): Record<string, unknown> | null {
  if (root.uuid === targetUuid) return root;
  for (const child of Array.isArray(root.children) ? root.children : []) {
    const found = findHierarchyNodeByUuid(readObject(child), targetUuid);
    if (found) return found;
  }
  return null;
}

function findRuntimeNodeByUuid(root: Record<string, unknown>, targetUuid: string): Record<string, unknown> | null {
  if (root.uuid === targetUuid || root._uuid === targetUuid) return root;
  const children = Array.isArray(root.children) ? root.children : Array.isArray(root._children) ? root._children : [];
  for (const child of children) {
    const found = findRuntimeNodeByUuid(readObject(child), targetUuid);
    if (found) return found;
  }
  return null;
}

function findPrefabInstanceChain(root: Record<string, unknown>, targetUuid: string): Array<{ depth: number; assetUuid: string; instanceNodeUuid: string; state: number | null; isNested: boolean | null }> {
  const path: Record<string, unknown>[] = [];
  if (!findNodePath(root, targetUuid, path)) return [];
  const chain: Array<{ depth: number; assetUuid: string; instanceNodeUuid: string; state: number | null; isNested: boolean | null }> = [];
  let lastAssetUuid = '';
  for (const node of path) {
    const prefab = readObject(node.prefab);
    const assetUuid = typeof prefab.assetUuid === 'string' ? prefab.assetUuid : '';
    if (!assetUuid || assetUuid === lastAssetUuid) continue;
    chain.push({
      depth: chain.length,
      assetUuid,
      instanceNodeUuid: typeof node.uuid === 'string' ? node.uuid : '',
      state: typeof prefab.state === 'number' ? prefab.state : null,
      isNested: typeof prefab.isNested === 'boolean' ? prefab.isNested : null
    });
    lastAssetUuid = assetUuid;
  }
  return chain;
}

function findNodePath(node: Record<string, unknown>, targetUuid: string, path: Record<string, unknown>[]): boolean {
  path.push(node);
  if (node.uuid === targetUuid) return true;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (findNodePath(readObject(child), targetUuid, path)) return true;
  }
  path.pop();
  return false;
}

async function probeUndoSaveConfirm(request: unknown): Promise<unknown> {
  const transaction = readProbeTransaction(unwrapRequest(request));
  if (normalizeProbeProjectPath(Editor.Project.path) !== normalizeProbeProjectPath(transaction.projectPath)) {
    throw new ProbeError('PROJECT_PATH_MISMATCH');
  }
  const undoController = resolveCreatorUndo();
  return executeProbeSceneOperation(transaction, {
    createNode: (options) => Editor.Message.request('scene', 'create-node', options),
    createComponent: (options) => Editor.Message.request('scene', 'create-component', options),
    setProperty: (options) => Editor.Message.request('scene', 'set-property', options as never),
    queryNode: (uuid) => Editor.Message.request('scene', 'query-node', uuid),
    saveScene: () => Editor.Message.request('scene', 'save-scene'),
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    undoSource: undoController.source,
    undo: undoController.undo,
    removeNode: (options) => Editor.Message.request('scene', 'remove-node', options)
  });
}

function readProbeTransaction(value: unknown): {
  transactionId: string;
  projectPath: string;
  parentNodeUuid: string;
  probeName: string;
  operation: {
    type: 'create-save-rollback-probe';
    position: { x: 17; y: 23; z: 0 };
    component: 'cc.UITransform';
    verificationPauseMs: 2000;
  };
} {
  const transaction = readObject(value);
  const operation = readObject(transaction.operation);
  const position = readObject(operation.position);
  if (
    typeof transaction.transactionId !== 'string'
    || typeof transaction.projectPath !== 'string'
    || typeof transaction.parentNodeUuid !== 'string'
    || typeof transaction.probeName !== 'string'
    || !transaction.probeName.startsWith('CocosAiProbe_')
    || operation.type !== 'create-save-rollback-probe'
    || operation.component !== 'cc.UITransform'
    || operation.verificationPauseMs !== 2000
    || position.x !== 17
    || position.y !== 23
    || position.z !== 0
  ) {
    throw new ProbeError('INVALID_PROBE_TRANSACTION');
  }
  return transaction as unknown as ReturnType<typeof readProbeTransaction>;
}

function resolveCreatorUndo(): { source: string; undo: () => Promise<void> } {
  const scope = globalThis as typeof globalThis & { cce?: Record<string, unknown> };
  const cce = readObject(scope.cce);
  const candidates: Array<[string, unknown]> = [
    ['cce.SceneFacadeManager', cce.SceneFacadeManager],
    ['cce.sceneFacadeManager', cce.sceneFacadeManager],
    ['cce.SceneFacade', cce.SceneFacade],
    ['cce.sceneFacade', cce.sceneFacade],
    ['cce.History', cce.History],
    ['cce.history', cce.history]
  ];
  for (const [source, candidate] of candidates) {
    if ((typeof candidate === 'object' && candidate !== null) || typeof candidate === 'function') {
      const owner = candidate as { undo?: () => Promise<void> | void };
      if (typeof owner.undo === 'function') {
        return {
          source,
          undo: async () => {
            await owner.undo?.call(owner);
          }
        };
      }
    }
  }
  throw new ProbeError('CREATOR_UNDO_API_UNAVAILABLE', { cceKeys: Object.keys(cce).sort() });
}

function requireUuid(request: unknown): string {
  const input = readObject(request);
  if (typeof input.uuid !== 'string' || !input.uuid) {
    throw new ProbeError('UUID_REQUIRED');
  }
  return input.uuid;
}

/** 组装 Scene 写通道：节点/组件原子写 + 保存重开 + 重读验证。 */
function buildWriteChannelDependencies(save: boolean): WriteSceneChannelDependencies {
  const nodeDependencies = buildNodeWriterDependencies();
  const componentDependencies = buildComponentWriterDependencies();
  const verifierDependencies = buildWriteVerifierDependencies();
  return {
    executeNodeOperation: (operation) => executeNodeWriteOperation(operation, nodeDependencies),
    executeComponentOperation: (operation) => executeComponentWriteOperation(operation, componentDependencies),
    saveDocument: verifierDependencies.saveDocument,
    reloadDocument: verifierDependencies.reloadDocument,
    verify: (executed) => saveAndVerifyWriteTransaction(
      { save } as never,
      executed,
      verifierDependencies
    )
  };
}

/** 当前文档身份与层级指纹，供主进程 Revision 前置采集。 */
async function writeDocumentIdentity(): Promise<unknown> {
  return captureCurrentDocumentIdentity();
}

/** 在事务上下文内执行混合写操作，返回执行器契约结果和逐操作证据。 */
async function writeExecute(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const operations = Array.isArray(input.operations) ? input.operations as WriteOperation[] : [];
  if (operations.length === 0) throw new ProbeError('INVALID_WRITE_OPERATIONS');
  const undoGroup = typeof input.undoGroup === 'string' && input.undoGroup ? input.undoGroup : '';
  if (!undoGroup) throw new ProbeError('UNDO_GROUP_REQUIRED');
  const save = input.save === true;
  return executeWriteSceneOperations(
    { operations, save, undoGroup },
    buildWriteChannelDependencies(save)
  );
}

/** 按逆序应用已执行操作的逆操作（step-undo-with-inverse 回滚路径）；save=true 时回滚后再保存。 */
async function writeRollback(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const executed = Array.isArray(input.executed) ? input.executed as VerifiedOperation[] : [];
  const result = await rollbackWriteSceneOperations(executed, buildWriteChannelDependencies(false));
  if (result.succeeded && input.save === true) {
    await buildWriteVerifierDependencies().saveDocument();
  }
  return result;
}

/**
 * 删除资产库中的资产（asset-db/delete-asset）。
 * 目标不存在时直接拒绝，不静默成功。
 */
async function deleteAsset(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const assetUrl = typeof input.assetUrl === 'string' && input.assetUrl ? input.assetUrl : null;
  if (!assetUrl) throw new ProbeError('ASSET_URL_REQUIRED');
  const existing = await Editor.Message.request('asset-db', 'query-asset-info', assetUrl);
  if (!existing) {
    throw new ProbeError('ASSET_NOT_FOUND', { assetUrl });
  }
  const deleted = await Editor.Message.request('asset-db', 'delete-asset', assetUrl as never);
  return { deleted: Boolean(deleted), assetUrl };
}

/**
 * 在资产库创建空 Node Prefab（内容与 Creator 3.8.8 内置模板 default_file_content/prefab/default.prefab 一致）。
 * 对既有路径先拒绝，避免触发 Creator"文件已存在"模态框无限阻塞。
 */
async function createAssetEmpty(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const assetUrl = typeof input.assetUrl === 'string' && input.assetUrl ? input.assetUrl : null;
  if (!assetUrl) throw new ProbeError('ASSET_URL_REQUIRED');
  if (!assetUrl.endsWith('.prefab')) throw new ProbeError('ASSET_URL_NOT_PREFAB', { assetUrl });
  const existing = await Editor.Message.request('asset-db', 'query-asset-info', assetUrl);
  if (existing) {
    throw new ProbeError('ASSET_ALREADY_EXISTS', { assetUrl });
  }
  const assetName = assetUrl.slice(assetUrl.lastIndexOf('/') + 1, -'.prefab'.length);
  const content = JSON.stringify(buildEmptyPrefabTemplate(assetName));
  const created = await Editor.Message.request('asset-db', 'create-asset', assetUrl, content);
  const info = readObject(created);
  return {
    assetUuid: typeof info.uuid === 'string' ? info.uuid : null,
    assetUrl,
    type: info.type ?? null
  };
}

/** Creator 3.8.8 内置 Node Prefab 模板（default_file_content/prefab/default.prefab），_name 按资产名填充。 */
function buildEmptyPrefabTemplate(assetName: string): unknown[] {
  return [
    {
      __type__: 'cc.Prefab',
      _name: assetName,
      _objFlags: 0,
      _native: '',
      data: { __id__: 1 },
      optimizationPolicy: 0,
      asyncLoadAssets: false,
      persistent: false
    },
    {
      __type__: 'cc.Node',
      _name: assetName,
      _objFlags: 0,
      _parent: null,
      _children: [],
      _active: true,
      _components: [],
      _prefab: { __id__: 2 },
      _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
      _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
      _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
      _layer: 1073741824,
      _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
      _id: ''
    },
    {
      __type__: 'cc.PrefabInfo',
      root: { __id__: 1 },
      asset: { __id__: 0 },
      fileId: 'c46/YsCPVOJYA4mWEpNYRx'
    }
  ];
}

/**
 * 从场景节点生成预制体资产（cce.SceneFacadeManager.createPrefab）。
 * 对既有路径先拒绝，避免触发 Creator"文件已存在"模态框无限阻塞。
 */
async function createPrefabFromNode(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const nodeUuid = typeof input.nodeUuid === 'string' && input.nodeUuid ? input.nodeUuid : null;
  const assetUrl = typeof input.assetUrl === 'string' && input.assetUrl ? input.assetUrl : null;
  if (!nodeUuid) throw new ProbeError('NODE_UUID_REQUIRED');
  if (!assetUrl) throw new ProbeError('ASSET_URL_REQUIRED');
  const existing = await Editor.Message.request('asset-db', 'query-asset-info', assetUrl);
  if (existing) {
    throw new ProbeError('ASSET_ALREADY_EXISTS', { assetUrl });
  }
  const cce = readObject((globalThis as Record<string, unknown>).cce);
  const facade = cce.SceneFacadeManager ?? cce.sceneFacadeManager ?? cce.SceneFacade ?? cce.sceneFacade;
  const owner = facade && (typeof facade === 'object' || typeof facade === 'function')
    ? facade as Record<string, unknown>
    : null;
  if (!owner || typeof owner.createPrefab !== 'function') {
    throw new ProbeError('CREATOR_CREATE_PREFAB_UNAVAILABLE');
  }
  const assetUuid = await (owner.createPrefab as (uuid: string, url: string) => Promise<unknown>)
    .call(owner, nodeUuid, assetUrl);
  if (typeof assetUuid !== 'string' || !assetUuid) {
    throw new ProbeError('CREATE_PREFAB_FAILED', { nodeUuid, assetUrl });
  }
  return { assetUuid, assetUrl };
}

/**
 * 临时能力探测：预制体生命周期的消息/API 可用性。
 * 依次尝试候选入口并保留每个入口的成功/失败证据，不做任何状态修改之外的兜底。
 */
async function debugPrefabLifecycle(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const nodeUuid = typeof input.nodeUuid === 'string' ? input.nodeUuid : null;
  const assetUrl = typeof input.assetUrl === 'string' && input.assetUrl
    ? input.assetUrl
    : `db://assets/CocosAiDebugPrefab-${Date.now()}.prefab`;
  const attempts: Array<Record<string, unknown>> = [];

  // cce 门面自省：预制体相关候选方法
  const cce = readObject((globalThis as Record<string, unknown>).cce);
  const facade = cce.SceneFacadeManager ?? cce.sceneFacadeManager ?? cce.SceneFacade ?? cce.sceneFacade;
  const facadeKeys = facade && (typeof facade === 'object' || typeof facade === 'function')
    ? Object.getOwnPropertyNames(facade).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(facade) ?? {}))
      .filter((key, index, all) => all.indexOf(key) === index)
      .filter((key) => /prefab|undo|group/i.test(key))
      .sort()
    : [];

  const tryAttempt = async (name: string, run: () => Promise<unknown>) => {
    // 每个候选入口独立限时：消息不可用时可能挂起而非报错，超时按失败留证。
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('ATTEMPT_TIMEOUT')), 5000);
        })
      ]);
      attempts.push({ name, ok: true, result });
    } catch (error) {
      attempts.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  // 1. asset-db 模板创建空预制体
  await tryAttempt('asset-db.create-asset', async () => {
    const created = await Editor.Message.request('asset-db', 'create-asset', assetUrl, null);
    return { created };
  });
  // 2. 查询创建结果
  await tryAttempt('asset-db.query-asset-info', async () => {
    const info = await Editor.Message.request('asset-db', 'query-asset-info', assetUrl);
    return { uuid: readObject(info).uuid ?? null, type: readObject(info).type ?? null };
  });
  // 3. 场景节点生成预制体（候选消息入口）
  if (nodeUuid) {
    await tryAttempt('scene.create-prefab', async () => {
      const created = await Editor.Message.request('scene', 'create-prefab', nodeUuid, assetUrl);
      return { created };
    });
  }
  // 4. duplicate-node 消息可用性
  if (nodeUuid) {
    await tryAttempt('scene.duplicate-node', async () => {
      const duplicated = await Editor.Message.request('scene', 'duplicate-node', nodeUuid);
      return { duplicated };
    });
  }
  // 5. cce 门面 createPrefab（候选内部 API：从场景节点生成预制体）
  const facadeOwner = facade && (typeof facade === 'object' || typeof facade === 'function')
    ? facade as Record<string, unknown>
    : null;
  const facadeAssetUrl = assetUrl.replace('.prefab', '-facade.prefab');
  if (nodeUuid && facadeOwner && typeof facadeOwner.createPrefab === 'function') {
    await tryAttempt('facade.createPrefab(nodeUuid,url)', async () => {
      const created = await (facadeOwner.createPrefab as (uuid: string, url: string) => Promise<unknown>)
        .call(facadeOwner, nodeUuid, facadeAssetUrl);
      return { created: created === undefined ? null : created };
    });
    await tryAttempt('facade.createPrefab 结果查询', async () => {
      const info = await Editor.Message.request('asset-db', 'query-asset-info', facadeAssetUrl);
      return { uuid: readObject(info).uuid ?? null, type: readObject(info).type ?? null };
    });
    await tryAttempt('facade.createPrefab 结果删除', async () => {
      const deleted = await Editor.Message.request('asset-db', 'delete-asset', facadeAssetUrl as never);
      return { deleted: Boolean(deleted) };
    });
  }
  if (nodeUuid && facadeOwner && typeof facadeOwner.getPrefabData === 'function') {
    await tryAttempt('facade.getPrefabData(nodeUuid)', async () => {
      const data = await (facadeOwner.getPrefabData as (uuid: string) => Promise<unknown>)
        .call(facadeOwner, nodeUuid);
      const serialized = JSON.stringify(data) ?? 'null';
      return { bytes: serialized.length, head: serialized.slice(0, 200) };
    });
  }
  // 6. asset-db 删除预制体
  await tryAttempt('asset-db.delete-asset', async () => {
    const deleted = await Editor.Message.request('asset-db', 'delete-asset', assetUrl as never);
    return { deleted };
  });

  return { facadeKeys, attempts };
}

/**
 * 恢复主进程传入的脚本 UUID 路径 Map。
 *
 * @param value UUID、路径元组数组。
 * @returns 供组件 Schema 查询脚本路径的只读 Map。
 */
function readScriptPathsByUuid(value: unknown): Map<string, string> {
  const entries: Array<[string, string]> = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (
      Array.isArray(item)
      && typeof item[0] === 'string'
      && typeof item[1] === 'string'
    ) {
      entries.push([item[0], item[1]]);
    }
  }
  return new Map(entries);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unwrapRequest(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function load(): void {}

/**
 * 卸载 Creator 场景脚本时释放文档快照和清理计时器。
 */
export function unload(): void {
  clearDefaultDocumentScanSessions();
}

export const methods = {
  probeEditorState: notImplemented,
  probeAssets: notImplemented,
  probeHierarchy,
  probeNode,
  probeComponent,
  probeDocumentSnapshot,
  probePrefab,
  probeUndoSaveConfirm,
  writeDocumentIdentity,
  writeExecute,
  writeRollback,
  debugPrefabLifecycle,
  createPrefabFromNode,
  createAssetEmpty,
  deleteAsset
};
