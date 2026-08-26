import { ProbeError } from './probe-errors';
import { normalizeComponentDump, normalizeHierarchyTree, normalizeNodeDump, normalizePrefabDump, resolvePrefabOverrideValues } from './scene-probe';
import { resolveCreatorDocumentIdentity } from './creator-document-identity';
import { executeNodeWriteOperation } from './node-writer';
import { executeComponentWriteOperation } from './component-writer';
import { executePrefabWriteOperation } from './prefab-writer';
import { saveAndVerifyDirectWrite } from './write-verifier';
import {
  executeWriteSceneOperations,
  type WriteSceneChannelDependencies
} from './write-scene-channel';
import {
  buildComponentWriterDependencies,
  buildNodeWriterDependencies,
  buildPrefabWriterDependencies,
  buildWriteVerifierDependencies
} from './write-creator-deps';
import type { WriteOperation } from './write-types';

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
 * 读取当前打开文档的身份（资产 UUID 与编辑模式），供主进程编辑器状态探针组合。
 *
 * @returns 当前文档身份；内部入口不可用时保留失败证据并返回空身份。
 */
async function editorStateDocumentIdentity(): Promise<unknown> {
  return resolveCreatorDocumentIdentity(globalThis);
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

function requireUuid(request: unknown): string {
  const input = readObject(request);
  if (typeof input.uuid !== 'string' || !input.uuid) {
    throw new ProbeError('UUID_REQUIRED');
  }
  return input.uuid;
}

/** 组装 Scene 写通道：节点/组件/预制体原子写 + 保存重开 + 重读验证。 */
function buildWriteChannelDependencies(save: boolean): WriteSceneChannelDependencies {
  const nodeDependencies = buildNodeWriterDependencies();
  const componentDependencies = buildComponentWriterDependencies();
  const prefabDependencies = buildPrefabWriterDependencies();
  const verifierDependencies = buildWriteVerifierDependencies();
  return {
    executeNodeOperation: (operation) => executeNodeWriteOperation(operation, nodeDependencies),
    executeComponentOperation: (operation) => executeComponentWriteOperation(operation, componentDependencies),
    executePrefabOperation: (operation) => executePrefabWriteOperation(operation, prefabDependencies),
    saveDocument: verifierDependencies.saveDocument,
    reloadDocument: verifierDependencies.reloadDocument,
    verify: (executed) => saveAndVerifyDirectWrite(
      { save },
      executed,
      verifierDependencies
    )
  };
}

/** 直写入口：按序执行混合写操作，保存后逐项重读验证，返回执行结果和逐操作证据。 */
async function writeExecute(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const operations = Array.isArray(input.operations) ? input.operations as WriteOperation[] : [];
  if (operations.length === 0) throw new ProbeError('INVALID_WRITE_OPERATIONS');
  const save = input.save === true;
  return executeWriteSceneOperations(
    { operations, save },
    buildWriteChannelDependencies(save)
  );
}

/** 保存当前文档（显式保存入口，与直写操作的自动保存共用 Creator 保存能力）。 */
async function saveDocument(): Promise<unknown> {
  await buildWriteVerifierDependencies().saveDocument();
  return { saved: true };
}

/**
 * 触发 asset-db 重新导入指定资产，并尝试驱动 TypeScript 编译（脚本变更后的刷新入口）。
 * 3.8.8 实测：refresh-asset 只重新导入，不触发编译；programming/execute-script 为候选编译入口。
 */
async function refreshAsset(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const assetUrl = typeof input.assetUrl === 'string' && input.assetUrl ? input.assetUrl : null;
  if (!assetUrl) throw new ProbeError('ASSET_URL_REQUIRED');
  await Editor.Message.request('asset-db', 'refresh-asset', assetUrl);
  let compileTriggered: boolean | null = null;
  try {
    await Editor.Message.request('programming' as never, 'execute-script' as never);
    compileTriggered = true;
  } catch {
    compileTriggered = false;
  }
  return { refreshed: true, assetUrl, compileTriggered };
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
  const remaining = await Editor.Message.request('asset-db', 'query-asset-info', assetUrl);
  if (remaining) {
    throw new ProbeError('PREFAB_DELETE_VERIFY_FAILED', { assetUrl, deleted: Boolean(deleted) });
  }
  return { deleted: true, assetUrl, verified: true };
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
 * 卸载 Creator 场景脚本（当前无需要释放的会话状态）。
 */
export function unload(): void {}

export const methods = {
  probeAssets: notImplemented,
  probeHierarchy,
  probeNode,
  probeComponent,
  editorStateDocumentIdentity,
  probePrefab,
  writeExecute,
  saveDocument,
  createPrefabFromNode,
  deleteAsset,
  refreshAsset
};
