import { ProbeError } from './probe-errors';
import { normalizeComponentDump, normalizeHierarchyTree, normalizeNodeDump, normalizePrefabDump, resolvePrefabOverrideValues } from './scene-probe';
import { resolveCreatorDocumentIdentity } from './creator-document-identity';
import { executeNodeWriteOperation } from './node-writer';
import { executeComponentWriteOperation } from './component-writer';
import { executePrefabWriteOperation } from './prefab-writer';
import { saveAndVerifyWriteTransaction } from './write-verifier';
import {
  executeWriteSceneOperations,
  type WriteSceneChannelDependencies
} from './write-scene-channel';
import {
  buildComponentWriterDependencies,
  buildNodeWriterDependencies,
  buildPrefabWriterDependencies,
  buildWriteVerifierDependencies,
  captureCurrentDocumentIdentity
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
    verify: (executed) => saveAndVerifyWriteTransaction(
      { save },
      executed,
      verifierDependencies
    )
  };
}

/** 当前文档身份与层级指纹。 */
async function writeDocumentIdentity(): Promise<unknown> {
  return captureCurrentDocumentIdentity();
}

/** 直写入口：按序执行混合写操作，保存后逐项重读验证，返回执行结果和逐操作证据。 */
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
  return { deleted: Boolean(deleted), assetUrl };
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
 * 描述门面单个属性的类型信息；函数附形参个数和源码签名头部。
 *
 * @param value 待描述属性值。
 * @returns 类型描述对象。
 */
function describeFacadeValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'function') return { kind: typeof value };
  const fn = value as (...args: unknown[]) => unknown;
  let signature = '';
  try {
    signature = Function.prototype.toString.call(fn).replace(/\s+/g, ' ').slice(0, 3000);
  } catch {
    signature = '';
  }
  return { kind: 'function', arity: fn.length, signature };
}

/**
 * 生成未知返回值的 JSON 安全预览：对象默认只展开两层，循环引用截断，防止巨型 Dump。
 *
 * @param value 待预览值。
 * @param depth 当前展开深度。
 * @param seen 循环检测集合。
 * @param maxDepth 最大展开深度。
 * @returns 可 JSON 序列化的预览结构。
 */
function previewFacadeValue(value: unknown, depth: number, seen?: WeakSet<object>, maxDepth = 2): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'undefined') return null;
  if (typeof value === 'function') return '[function]';
  if (depth >= maxDepth) return '[truncated]';
  const seenSet = seen ?? new WeakSet<object>();
  if (typeof value === 'object') {
    if (seenSet.has(value)) return '[circular]';
    seenSet.add(value);
  }
  if (Array.isArray(value)) {
    return { __type: 'array', length: value.length, items: value.slice(0, 3).map((item) => previewFacadeValue(item, depth + 1, seenSet, maxDepth)) };
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const ctor = typeof record.constructor === 'function'
      ? (record.constructor as { name?: string }).name ?? 'Object'
      : 'Object';
    const preview: Record<string, unknown> = { __type: ctor };
    for (const key of Object.keys(record).slice(0, 20)) {
      try {
        preview[key] = previewFacadeValue(record[key], depth + 1, seenSet, maxDepth);
      } catch {
        preview[key] = '[unreadable]';
      }
    }
    return preview;
  }
  return String(value);
}

/** 门面调用独立限时：内部 API 不可用时不报错而挂起，超时按失败留证。 */
function withFacadeTimeout<T>(pending: Promise<T>): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('ATTEMPT_TIMEOUT')), 5000);
    })
  ]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

/** 经 assetManager.loadAny 加载资产对象（探测用，含预制体资产）。 */
function loadCcAssetForProbe(assetUuid: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { assetManager } = require('cc') as {
      assetManager?: { loadAny?: (request: { uuid: string }, callback: (error: unknown, asset: unknown) => void) => void }
    };
    if (!assetManager || typeof assetManager.loadAny !== 'function') {
      reject(new ProbeError('ASSET_PIPELINE_UNAVAILABLE'));
      return;
    }
    assetManager.loadAny({ uuid: assetUuid }, (error, asset) => {
      if (error || !asset) {
        reject(new ProbeError('ASSET_LOAD_FAILED', { assetUuid, reason: error ? String(error) : 'ASSET_LOAD_EMPTY' }));
        return;
      }
      resolve(asset);
    });
  });
}

/** 读取运行时节点关键信息：uuid、名称、父级和 _prefab 结构预览（循环安全）。 */
function readRuntimeNodeInfo(node: unknown): Record<string, unknown> {
  const record = readObject(node);
  const parent = readObject(record.parent);
  return {
    uuid: typeof record.uuid === 'string' ? record.uuid : null,
    name: typeof record.name === 'string' ? record.name : null,
    parentName: typeof parent.name === 'string' ? parent.name : null,
    active: typeof record.active === 'boolean' ? record.active : null,
    prefab: previewFacadeValue(record._prefab, 0, undefined, 4)
  };
}

/**
 * 探测预制体实例化策略：加载资产 → cce.Prefab.createNodeFromPrefabAsset 生成实例 → 按策略挂载。
 * strategy=runtime-attach 运行时直接挂父；paste 走 NodeManager.pasteNode；from-asset 走 NodeManager.createNodeFromAsset（资产拖拽路径）。
 */
async function debugInstantiateProbe(input: Record<string, unknown>): Promise<unknown> {
  const assetUuid = typeof input.assetUuid === 'string' && input.assetUuid ? input.assetUuid : null;
  const parentUuid = typeof input.parentUuid === 'string' && input.parentUuid ? input.parentUuid : null;
  const strategy = typeof input.strategy === 'string' && input.strategy ? input.strategy : 'runtime-attach';
  if (!assetUuid) throw new ProbeError('ASSET_UUID_REQUIRED');
  const cce = readObject((globalThis as Record<string, unknown>).cce);
  const prefabManager = readObject(cce.Prefab);
  const nodeManager = readObject(cce.Node);
  const asset = await loadCcAssetForProbe(assetUuid);
  const result: Record<string, unknown> = {
    strategy,
    assetType: (asset as { constructor?: { name?: string } } | null)?.constructor?.name ?? null
  };

  if (strategy === 'from-asset') {
    if (typeof nodeManager.createNodeFromAsset !== 'function') {
      throw new ProbeError('FACADE_METHOD_NOT_FOUND', { target: 'Node', method: 'createNodeFromAsset' });
    }
    // 源码确认签名 createNodeFromAsset(parentUuid, assetUuid, {name,type})：type='cc.Prefab' 且不带 unlinkPrefab 时保留实例信息。
    // 函数内部吞错只打控制台，改为多组参数形态批量尝试并分别留证。
    const variants: Array<Record<string, unknown>> = [
      { label: 'full', parent: parentUuid, options: { name: readObject(asset).name ?? 'ProbeInstance', type: 'cc.Prefab' } },
      { label: 'no-canvas-adapt', parent: parentUuid, options: { name: readObject(asset).name ?? 'ProbeInstance', type: 'cc.Prefab', canvasRequired: false, autoAdaptToCreate: false } },
      { label: 'root-parent', parent: null, options: { name: readObject(asset).name ?? 'ProbeInstance', type: 'cc.Prefab' } }
    ];
    const attempts: Array<Record<string, unknown>> = [];
    for (const variant of variants) {
      try {
        const createdUuid = await withFacadeTimeout(
          Promise.resolve((nodeManager.createNodeFromAsset as (...args: unknown[]) => unknown)
            .call(nodeManager, variant.parent, assetUuid, variant.options))
        );
        const created = typeof createdUuid === 'string' && typeof nodeManager.query === 'function'
          ? (nodeManager.query as (uuid: string) => unknown).call(nodeManager, createdUuid)
          : null;
        attempts.push({ label: variant.label, createdUuid: typeof createdUuid === 'string' ? createdUuid : null, node: readRuntimeNodeInfo(created) });
        if (typeof createdUuid === 'string') break;
      } catch (error) {
        attempts.push({ label: variant.label, error: error instanceof Error ? error.message : String(error) });
      }
    }
    result.attempts = attempts;
    return result;
  }

  if (typeof prefabManager.createNodeFromPrefabAsset !== 'function') {
    throw new ProbeError('FACADE_METHOD_NOT_FOUND', { target: 'Prefab', method: 'createNodeFromPrefabAsset' });
  }
  const node = (prefabManager.createNodeFromPrefabAsset as (asset: unknown) => unknown).call(prefabManager, asset);
  result.instantiated = readRuntimeNodeInfo(node);
  if (strategy === 'runtime-attach') {
    const parent = parentUuid
      ? (nodeManager.query as (uuid: string) => unknown).call(nodeManager, parentUuid)
      : director.getScene();
    if (!parent) throw new ProbeError('PARENT_NODE_NOT_FOUND', { parentUuid });
    (node as Record<string, unknown>).parent = parent;
    result.attached = readRuntimeNodeInfo(node);
    return result;
  }
  if (strategy === 'paste') {
    const pasted = await withFacadeTimeout(
      Promise.resolve((nodeManager.pasteNode as (...args: unknown[]) => unknown).call(nodeManager, parentUuid, [node]))
    );
    result.pasted = previewFacadeValue(pasted, 0);
    result.attached = readRuntimeNodeInfo(node);
    return result;
  }
  throw new ProbeError('INSTANTIATE_STRATEGY_UNKNOWN', { strategy });
}

/**
 * 探测实例关联：候选入口逐一尝试（字符串 uuid 与运行时对象两种参数形态），成功/失败均留证。
 */
async function debugLinkProbe(input: Record<string, unknown>): Promise<unknown> {
  const nodeUuid = typeof input.nodeUuid === 'string' && input.nodeUuid ? input.nodeUuid : null;
  const assetUuid = typeof input.assetUuid === 'string' && input.assetUuid ? input.assetUuid : null;
  if (!nodeUuid || !assetUuid) throw new ProbeError('NODE_AND_ASSET_UUID_REQUIRED');
  const cce = readObject((globalThis as Record<string, unknown>).cce);
  const facade = readObject(cce.SceneFacadeManager ?? cce.sceneFacadeManager);
  const prefabManager = readObject(cce.Prefab);
  const nodeManager = readObject(cce.Node);
  const attempts: Array<Record<string, unknown>> = [];
  const tryAttempt = async (name: string, run: () => Promise<unknown>) => {
    try {
      const result = await withFacadeTimeout(run());
      attempts.push({ name, ok: true, result: previewFacadeValue(result, 0) });
    } catch (error) {
      attempts.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (typeof facade.linkPrefab === 'function') {
    await tryAttempt('facade.linkPrefab(nodeUuid,assetUuid)', async () =>
      (facade.linkPrefab as (...args: unknown[]) => unknown).call(facade, nodeUuid, assetUuid));
  }
  if (typeof prefabManager.linkNodeWithPrefabAsset === 'function') {
    await tryAttempt('prefab.linkNodeWithPrefabAsset(nodeUuid,assetUuid)', async () =>
      (prefabManager.linkNodeWithPrefabAsset as (...args: unknown[]) => unknown).call(prefabManager, nodeUuid, assetUuid));
    const node = typeof nodeManager.query === 'function'
      ? (nodeManager.query as (uuid: string) => unknown).call(nodeManager, nodeUuid)
      : null;
    if (node) {
      const asset = await loadCcAssetForProbe(assetUuid);
      await tryAttempt('prefab.linkNodeWithPrefabAsset(node,asset)', async () =>
        (prefabManager.linkNodeWithPrefabAsset as (...args: unknown[]) => unknown).call(prefabManager, node, asset));
    }
  }
  return { attempts, nodeAfter: readRuntimeNodeInfo(
    typeof nodeManager.query === 'function'
      ? (nodeManager.query as (uuid: string) => unknown).call(nodeManager, nodeUuid)
      : null
  ) };
}

/** 编译事件观察状态：跨调用保留广播监听与事件缓冲（阶段三探测用）。 */
const compileWatchState: {
  armedChannels: string[];
  events: Array<Record<string, unknown>>;
  listeners: Array<{ channel: string; listener: (...args: unknown[]) => void }>;
  classMarkerBefore: string | null;
} = { armedChannels: [], events: [], listeners: [], classMarkerBefore: null };

/** 读取脚本类注册标记：构造器源码长度与哈希，类重注册后变化。 */
function readScriptClassMarker(className: string): string | null {
  try {
    const { js } = require('cc') as { js: { getClassByName(name: string): unknown } };
    const cls = js.getClassByName(className);
    if (typeof cls !== 'function') return null;
    const source = Function.prototype.toString.call(cls as (...args: unknown[]) => unknown);
    let hash = 0;
    for (let index = 0; index < source.length; index += 1) {
      hash = (hash * 31 + source.charCodeAt(index)) | 0;
    }
    return `len=${source.length},hash=${hash}`;
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 广播监听武装：对候选频道逐个注册，成功/失败留证，缓冲清空。 */
function debugWatchArm(input: Record<string, unknown>): unknown {
  const channels = Array.isArray(input.channels) ? input.channels.filter((item): item is string => typeof item === 'string') : [];
  const className = typeof input.className === 'string' ? input.className : null;
  debugWatchCollect();
  compileWatchState.events = [];
  compileWatchState.armedChannels = [];
  compileWatchState.classMarkerBefore = className ? readScriptClassMarker(className) : null;
  const message = Editor.Message as unknown as Record<string, unknown>;
  const failures: Array<Record<string, unknown>> = [];
  for (const channel of channels) {
    try {
      const listener = (...args: unknown[]) => {
        compileWatchState.events.push({
          channel,
          at: new Date().toISOString(),
          args: previewFacadeValue(args, 0)
        });
      };
      (message.addBroadcastListener as (channel: string, listener: (...args: unknown[]) => void) => void)(channel, listener);
      compileWatchState.listeners.push({ channel, listener });
      compileWatchState.armedChannels.push(channel);
    } catch (error) {
      failures.push({ channel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { armed: compileWatchState.armedChannels, failures, classMarkerBefore: compileWatchState.classMarkerBefore };
}

/** 广播监听收集：卸监听、返回事件缓冲与类注册标记对比。 */
function debugWatchCollect(input?: Record<string, unknown>): unknown {
  const message = typeof Editor !== 'undefined' ? Editor.Message as unknown as Record<string, unknown> : null;
  for (const { channel, listener } of compileWatchState.listeners) {
    try {
      if (message && typeof message.removeBroadcastListener === 'function') {
        (message.removeBroadcastListener as (channel: string, listener: (...args: unknown[]) => void) => void)(channel, listener);
      }
    } catch {
      // 卸监听失败不影响收集
    }
  }
  compileWatchState.listeners = [];
  const className = input && typeof input.className === 'string' ? input.className : null;
  const classMarkerAfter = className ? readScriptClassMarker(className) : null;
  const events = compileWatchState.events;
  compileWatchState.events = [];
  return {
    events,
    classMarkerBefore: compileWatchState.classMarkerBefore,
    classMarkerAfter,
    classChanged: compileWatchState.classMarkerBefore !== null && classMarkerAfter !== null
      ? compileWatchState.classMarkerBefore !== classMarkerAfter
      : null
  };
}

/**
 * 探测场景消息层：白名单消息经 Editor.Message.request('scene', name, ...args) 调用。
 * 消息层与门面 JS 方法的差异（撤销录制/Dirty 标记）是阶段三实现路径的关键证据。
 */
async function debugSceneMessageProbe(input: Record<string, unknown>): Promise<unknown> {
  const name = typeof input.name === 'string' ? input.name : null;
  const args = Array.isArray(input.args) ? input.args : [];
  const whitelist = new Set(['create-node', 'remove-node', 'set-property', 'query-dirty', 'save-scene']);
  if (!name || !whitelist.has(name)) {
    throw new ProbeError('SCENE_MESSAGE_NOT_ALLOWED', { name, allowed: [...whitelist] });
  }
  const result = await withFacadeTimeout(Editor.Message.request('scene', name as never, ...args as []));
  return { ok: true, result: previewFacadeValue(result, 0) };
}

/**
 * 临时能力探测：cce.SceneFacadeManager 门面全量自省与受控方法调用。
 * op=enumerate 返回 cce 顶层键与目标对象全部方法（含原型链、形参签名）；
 * op=call 只允许调用目标对象自身方法，独立限时，成功/失败均留证。阶段三探测用，随阶段收口摘除或转正式能力。
 * op=instantiate 探测实例化策略（runtime-attach / paste / from-asset）；op=link 探测实例关联候选入口。
 * target 省略时为 SceneFacadeManager，否则限 cce 顶层直接属性（如 Prefab / Node / Operation）。
 */
async function debugPrefabFacade(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const op = typeof input.op === 'string' ? input.op : 'enumerate';
  const target = typeof input.target === 'string' && input.target ? input.target : null;
  const cce = readObject((globalThis as Record<string, unknown>).cce);
  const facade = cce.SceneFacadeManager ?? cce.sceneFacadeManager ?? cce.SceneFacade ?? cce.sceneFacade;
  // target 支持点路径（如 SceneFacadeManager._facadeFSM.currentState 或 Editor.Message），逐段取自有属性，不允许调用。
  const resolveTarget = (): Record<string, unknown> | null => {
    if (!target) {
      return facade && (typeof facade === 'object' || typeof facade === 'function') ? facade as Record<string, unknown> : null;
    }
    // Editor 在场景脚本模块作用域内可用但不在 globalThis 上，单独特判。
    if (target === 'Editor.Message') {
      return Editor.Message && (typeof Editor.Message === 'object' || typeof (Editor.Message as unknown) === 'function')
        ? Editor.Message as unknown as Record<string, unknown>
        : null;
    }
    let current: unknown = cce;
    for (const segment of target.split('.')) {
      if (!segment) return null;
      if (!current || (typeof current !== 'object' && typeof current !== 'function')) return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return current && (typeof current === 'object' || typeof current === 'function') ? current as Record<string, unknown> : null;
  };
  const probeOwner = resolveTarget();

  if (op === 'enumerate') {
    if (target === 'Editor.Message') {
      // 诊断：确认 Editor 全局在场景进程的真实形态
      return {
        target,
        typeofEditor: typeof Editor,
        typeofMessage: typeof Editor.Message,
        messageKeys: Editor.Message && typeof Editor.Message === 'object' ? Object.keys(Editor.Message as unknown as object).sort() : null
      };
    }
    const methods: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let current: unknown = probeOwner;
    let level = 0;
    while (current && (typeof current === 'object' || typeof current === 'function') && level < 4) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (seen.has(key) || key === 'constructor') continue;
        seen.add(key);
        let value: unknown;
        try {
          value = (current as Record<string, unknown>)[key];
        } catch {
          value = '[unreadable]';
        }
        const described = describeFacadeValue(value);
        // 非函数属性附浅层预览，便于读取 creatableAssetTypes 等配置内容。
        if (described.kind !== 'function') described.preview = previewFacadeValue(value, 0);
        methods.push({ name: key, level, ...described });
      }
      current = Object.getPrototypeOf(current);
      level += 1;
    }
    const ownerCtor = probeOwner
      ? (probeOwner as { constructor?: { name?: string } }).constructor?.name ?? null
      : null;
    return { target: target ?? 'SceneFacadeManager', ownerCtor, cceKeys: Object.keys(cce).sort(), methods };
  }

  if (op === 'instantiate') {
    return debugInstantiateProbe(input);
  }

  if (op === 'link') {
    return debugLinkProbe(input);
  }

  if (op === 'scene-message') {
    return debugSceneMessageProbe(input);
  }

  if (op === 'watch-arm') {
    return debugWatchArm(input);
  }

  if (op === 'watch-collect') {
    return debugWatchCollect(input);
  }

  if (op === 'call') {
    const method = typeof input.method === 'string' && input.method ? input.method : null;
    if (!method) throw new ProbeError('FACADE_METHOD_REQUIRED');
    const args = Array.isArray(input.args) ? input.args : [];
    if (!probeOwner || typeof probeOwner[method] !== 'function') {
      throw new ProbeError('FACADE_METHOD_NOT_FOUND', { target: target ?? 'SceneFacadeManager', method });
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        Promise.resolve((probeOwner[method] as (...callArgs: unknown[]) => unknown).apply(probeOwner, args)),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('ATTEMPT_TIMEOUT')), 5000);
        })
      ]);
      return { ok: true, result: previewFacadeValue(result, 0) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : null
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  throw new ProbeError('FACADE_PROBE_OP_UNKNOWN', { op });
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
  writeDocumentIdentity,
  writeExecute,
  saveDocument,
  debugPrefabLifecycle,
  debugPrefabFacade,
  createPrefabFromNode,
  deleteAsset,
  refreshAsset
};
