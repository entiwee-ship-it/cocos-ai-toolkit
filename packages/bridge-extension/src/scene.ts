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
  probeUndoSaveConfirm
};
