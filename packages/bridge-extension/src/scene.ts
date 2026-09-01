import { Buffer } from 'node:buffer';
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
import { readNodeBounds } from './scene-bounds';
import { buildNodeWriteCapabilities, type NodeWriteCapabilities } from './write-applicability';
import { readDumpValue } from './raw-reflection';

const { director, Vec3 } = require('cc') as {
  director: { getScene(): unknown };
  Vec3: new (x?: number, y?: number, z?: number) => { x: number; y: number; z: number };
};

const DEFAULT_PROBE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MIN_PROBE_OUTPUT_BYTES = 16 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

function notImplemented(): never {
  throw new ProbeError('NOT_IMPLEMENTED');
}

async function probeHierarchy(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const rootUuid = typeof input.rootUuid === 'string' ? input.rootUuid : undefined;
  const depth = typeof input.depth === 'number' ? input.depth : 4;
  const includeRaw = input.compact !== true;
  const raw = await Editor.Message.request('scene', 'query-node-tree', ...(rootUuid ? [rootUuid] : []));
  return assertProbeOutputBudget('probe.hierarchy', {
    data: normalizeHierarchyTree(raw, depth, includeRaw),
    ...(includeRaw ? { raw } : {}),
    source: 'message-api'
  }, input);
}

async function probeNode(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const uuid = requireUuid(input);
  const includeRaw = input.compact !== true;
  const [raw, documentIdentity] = await Promise.all([
    Editor.Message.request('scene', 'query-node', uuid),
    resolveCreatorDocumentIdentity(globalThis)
  ]);
  const normalized = normalizeNodeDump(raw, null, includeRaw);
  const sourceUrl = normalized.prefabInstance.prefabAssetUuid
    ? await readPrefabSourceUrl(normalized.prefabInstance.prefabAssetUuid)
    : null;
  let data: Record<string, unknown> = {
    ...normalized,
    prefabInstance: { ...normalized.prefabInstance, sourceUrl },
    writeCapabilities: buildNodeWriteCapabilities({
      documentAssetUuid: documentIdentity.assetUuid,
      documentMode: documentIdentity.mode,
      nodeFileId: normalized.identity.fileId,
      prefabAssetUuid: normalized.prefabInstance.prefabAssetUuid,
      sourceUrl,
      isInstanceRoot: normalized.prefabInstance.isInstanceRoot
    })
  };
  if (input.includeBounds === true) {
    const scene = readObject(director.getScene());
    const runtimeNode = findRuntimeNodeByUuid(scene, uuid);
    if (!runtimeNode) throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: uuid });
    const relativeToUuid = typeof input.relativeToUuid === 'string' ? input.relativeToUuid : null;
    const relativeNode = relativeToUuid ? findRuntimeNodeByUuid(scene, relativeToUuid) : null;
    if (relativeToUuid && !relativeNode) {
      throw new ProbeError('RELATIVE_NODE_NOT_FOUND', { nodeUuid: relativeToUuid });
    }
    data = {
      ...data,
      bounds: readNodeBounds(runtimeNode, {
        includeDescendantVisualUnion: input.includeDescendantVisualUnion === true,
        relativeNode,
        relativeToPath: typeof input.relativeToPath === 'string' ? input.relativeToPath : undefined
      }, (x, y, z) => new Vec3(x, y, z))
    };
  }
  return assertProbeOutputBudget(
    'probe.node',
    { data, ...(includeRaw ? { raw } : {}), source: 'message-api' },
    input
  );
}

/**
 * 在 Bridge 把读取结果送入 WebSocket 前限制序列化字节数，避免完整 raw 意外放大传输。
 *
 * @param method 当前内部探针方法名。
 * @param response 即将返回给 Probe Server 的结果。
 * @param input 调用参数；maxOutputBytes 未提供时使用安全默认值。
 * @returns 未超出预算的原始响应。
 */
function assertProbeOutputBudget(
  method: 'probe.hierarchy' | 'probe.node',
  response: unknown,
  input: Record<string, unknown>
): unknown {
  const maxOutputBytes = readMaxOutputBytes(input.maxOutputBytes);
  const estimatedBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
  if (estimatedBytes <= maxOutputBytes) return response;
  throw new ProbeError('PROBE_OUTPUT_TOO_LARGE', {
    method,
    tooLarge: true,
    estimatedBytes,
    maxOutputBytes,
    nextAction: '请改用 summary、fields、query、rootPath 或 propertyPaths 紧凑投影；确认必须读取完整 raw 时可提高 maxOutputBytes。'
  });
}

/** 读取并校验单次 hierarchy/node 的 Bridge 输出预算。 */
function readMaxOutputBytes(value: unknown): number {
  if (value === undefined) return DEFAULT_PROBE_OUTPUT_BYTES;
  if (!Number.isInteger(value) || (value as number) < MIN_PROBE_OUTPUT_BYTES || (value as number) > MAX_PROBE_OUTPUT_BYTES) {
    throw new ProbeError('MAX_OUTPUT_BYTES_INVALID', {
      maxOutputBytes: value,
      minBytes: MIN_PROBE_OUTPUT_BYTES,
      maxBytes: MAX_PROBE_OUTPUT_BYTES
    });
  }
  return value as number;
}

async function readPrefabSourceUrl(prefabAssetUuid: string): Promise<string | null> {
  try {
    const asset = readObject(await Editor.Message.request('asset-db', 'query-asset-info', prefabAssetUuid));
    return typeof asset.url === 'string' && asset.url ? asset.url : null;
  } catch {
    return null;
  }
}

type NodeWriteCapability = Extract<keyof NodeWriteCapabilities, `can${string}`>;

/**
 * 在进入 writer 之前拒绝 Creator 已确认会静默不生效的嵌套 Prefab 内容写入。
 *
 * @param operations 本次直写请求中的有序操作。
 */
export async function assertWriteOperationsApplicable(operations: WriteOperation[]): Promise<void> {
  const documentIdentity = await resolveCreatorDocumentIdentity(globalThis);
  if (documentIdentity.mode !== 'prefab' || !documentIdentity.assetUuid) return;
  const nodeCache = new Map<string, NodeWriteCapabilities>();
  const componentNodeCache = new Map<string, string>();
  const assertNode = async (
    nodeUuid: string,
    capability: NodeWriteCapability,
    operationIndex: number,
    operationType: WriteOperation['type'],
    targetRole: string
  ): Promise<void> => {
    let capabilities = nodeCache.get(nodeUuid);
    if (!capabilities) {
      const raw = await Editor.Message.request('scene', 'query-node', nodeUuid);
      const normalized = normalizeNodeDump(raw);
      const prefabAssetUuid = normalized.prefabInstance.prefabAssetUuid;
      const sourceUrl = prefabAssetUuid && prefabAssetUuid !== documentIdentity.assetUuid
        ? await readPrefabSourceUrl(prefabAssetUuid)
        : null;
      capabilities = buildNodeWriteCapabilities({
        documentAssetUuid: documentIdentity.assetUuid,
        documentMode: documentIdentity.mode,
        nodeFileId: normalized.identity.fileId,
        prefabAssetUuid,
        sourceUrl,
        isInstanceRoot: normalized.prefabInstance.isInstanceRoot
      });
      nodeCache.set(nodeUuid, capabilities);
    }
    if (capabilities[capability] === true) return;
    throw new ProbeError('NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT', {
      operationIndex,
      operationType,
      targetRole,
      nodeUuid,
      requiredCapability: capability,
      documentMode: capabilities.documentMode,
      ownerDocumentUuid: capabilities.ownerDocumentUuid,
      ownerPrefabUuid: capabilities.ownerPrefabUuid,
      ownerSourceUrl: capabilities.ownerSourceUrl,
      sourceFileId: capabilities.sourceFileId,
      isInstanceRoot: capabilities.isInstanceRoot,
      reasonCode: capabilities.reasonCode,
      route: capabilities.nextAction,
      nextAction: capabilities.ownerPrefabUuid
        ? '用 cocos_prefab_open 打开源 Prefab，重新读取节点后再写入'
        : '重新读取当前文档和节点身份后再写入'
    });
  };
  const resolveComponentNodeUuid = async (componentUuid: string): Promise<string> => {
    const cached = componentNodeCache.get(componentUuid);
    if (cached) return cached;
    const raw = readObject(await Editor.Message.request('scene', 'query-component', componentUuid));
    const values = readObject(raw.value);
    const node = readObject(readDumpValue(values.node));
    const nodeUuid = typeof node.uuid === 'string' && node.uuid ? node.uuid : null;
    if (!nodeUuid) throw new ProbeError('COMPONENT_NODE_NOT_FOUND', { componentUuid });
    componentNodeCache.set(componentUuid, nodeUuid);
    return nodeUuid;
  };
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex];
    switch (operation.type) {
      case 'node.create':
        await assertNode(readOperationString(operation, 'parentNodeUuid'), 'canCreateChild', operationIndex, operation.type, 'parent');
        break;
      case 'node.delete':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canDelete', operationIndex, operation.type, 'target');
        break;
      case 'node.rename':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canRename', operationIndex, operation.type, 'target');
        break;
      case 'node.reparent':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canReparent', operationIndex, operation.type, 'target');
        await assertNode(readOperationString(operation, 'newParentUuid'), 'canCreateChild', operationIndex, operation.type, 'newParent');
        break;
      case 'node.duplicate':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canDuplicate', operationIndex, operation.type, 'target');
        if (readOptionalOperationString(operation, 'parentUuid')) {
          await assertNode(readOperationString(operation, 'parentUuid'), 'canCreateChild', operationIndex, operation.type, 'parent');
        }
        break;
      case 'node.set_active':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canSetActive', operationIndex, operation.type, 'target');
        break;
      case 'node.set_layer':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canSetLayer', operationIndex, operation.type, 'target');
        break;
      case 'node.set_transform':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canSetTransform', operationIndex, operation.type, 'target');
        break;
      case 'component.add':
        await assertNode(readOperationString(operation, 'nodeUuid'), 'canAddComponent', operationIndex, operation.type, 'target');
        break;
      case 'component.remove':
        await assertNode(
          await resolveComponentNodeUuid(readOperationString(operation, 'componentUuid')),
          'canRemoveComponent',
          operationIndex,
          operation.type,
          'componentOwner'
        );
        break;
      case 'component.enable':
      case 'component.set_property':
      case 'component.set_reference':
      case 'component.clear_reference':
      case 'component.resize_array':
        await assertNode(
          await resolveComponentNodeUuid(readOperationString(operation, 'componentUuid')),
          'canSetComponentProperty',
          operationIndex,
          operation.type,
          'componentOwner'
        );
        break;
      case 'prefab.instantiate':
        await assertNode(readOperationString(operation, 'parentNodeUuid'), 'canCreateChild', operationIndex, operation.type, 'parent');
        break;
      default:
        break;
    }
  }
}

function readOperationString(operation: WriteOperation, field: string): string {
  const value = operation[field];
  if (typeof value !== 'string' || !value) {
    throw new ProbeError('INVALID_WRITE_OPERATION_FIELD', { operationType: operation.type, field });
  }
  return value;
}

function readOptionalOperationString(operation: WriteOperation, field: string): string | null {
  const value = operation[field];
  return typeof value === 'string' && value ? value : null;
}

async function probeComponent(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const componentRequest = readObject(input.request);
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
  await assertWriteOperationsApplicable(operations);
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
  deleteAsset,
  refreshAsset
};
