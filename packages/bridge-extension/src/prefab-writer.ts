import { ProbeError } from './probe-errors';
import type { WriteOperation } from './transaction-manager';

/** 预制体实例节点的可序列化证据快照（对齐 Phase 1 只读模型的 __prefab__ 结构）。 */
export interface PrefabInstanceInfo {
  nodeUuid: string;
  name: string;
  /** 源预制体资产 UUID（__prefab__.uuid）。 */
  prefabAssetUuid: string | null;
  /** 源对象 FileID（__prefab__.fileId）。 */
  sourceObjectFileId: string | null;
  /** 实例 FileID（__prefab__.instance.fileId），实例身份的核心证据。 */
  instanceFileId: string | null;
  /** prefabStateInfo.state：2 为完整实例。 */
  state: number | null;
  isApplicable: boolean;
  isRevertable: boolean;
  isUnwrappable: boolean;
  parentUuid: string | null;
  childCount: number;
  /** 属性覆盖数量（propertyOverrides 长度）。 */
  overrideCount: number;
  /** 覆盖属性路径清单（点拼字符串，如 '_name'、'_lpos'）。 */
  overridePaths: string[];
}

/** 资产预检结果（query-asset-info 的最小必要字段）。 */
export interface PrefabAssetInfo {
  uuid: string;
  type: string | null;
}

/**
 * 预制体写依赖。全部由 Scene 进程真实能力注入（消息 API 或门面方法），
 * 本模块只做编排与校验，不直接触碰 Editor 全局对象或磁盘文件。
 */
export interface PrefabWriterDependencies {
  getPrefabInstanceInfo(nodeUuid: string): Promise<PrefabInstanceInfo | null>;
  /** 按资产 UUID 或 db:// URL 预检资产；不存在返回 null。 */
  queryAssetInfo(uuidOrUrl: string): Promise<PrefabAssetInfo | null>;
  /** 经 scene/create-node 消息实例化（type='cc.Prefab'），返回新节点 UUID。 */
  instantiatePrefab(parentNodeUuid: string, prefabAssetUuid: string, name?: string): Promise<string>;
  /** 经门面 createPrefab 从场景节点生成预制体资产，返回资产 UUID。 */
  createPrefabFromNode(nodeUuid: string, assetUrl: string): Promise<string>;
  deleteAsset(assetUrl: string): Promise<void>;
  revertPrefabInstance(instanceRootUuid: string): Promise<void>;
  applyPrefabInstance(instanceRootUuid: string): Promise<void>;
  unlinkPrefabInstance(instanceRootUuid: string): Promise<void>;
  linkPrefabInstance(nodeUuid: string, prefabAssetUuid: string): Promise<void>;
  /** 按属性路径重置实例节点属性为源值（Inspector 单属性还原同款路径）。 */
  resetNodeProperty(nodeUuid: string, propertyPath: string): Promise<void>;
  /** 当前编辑文档的资产 UUID（替换源时防自嵌套循环）。 */
  getCurrentDocumentAssetUuid(): Promise<string | null>;
}

export interface PrefabWriteOpResult {
  /** 操作产生或目标节点 UUID（实例化返回新节点）。 */
  nodeUuid: string | null;
  /** create_from_node 返回的新资产 UUID。 */
  assetUuid: string | null;
  before: Partial<PrefabInstanceInfo> | null;
  after: Partial<PrefabInstanceInfo> | null;
  /** 显式逆操作序列，供 step-undo-with-inverse 回滚路径使用。 */
  inverse: WriteOperation[];
}

/**
 * 执行单个预制体原子写操作，返回 before/after 证据和显式逆操作。
 * 只允许在事务上下文内由写执行器调用；非法输入抛稳定错误码，不留下半成品。
 * 桥内 WriteOperation 为松散结构（必填字段已由 validateWriteTransactionRequest 校验），
 * 本模块按操作类型收窄读取。
 *
 * @param operation 预制体写操作（prefab.*）。
 * @param dependencies Scene 侧真实能力。
 * @returns 写操作证据。
 */
export async function executePrefabWriteOperation(
  operation: WriteOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  switch (operation.type) {
    case 'prefab.instantiate':
      return instantiatePrefab(operation as PrefabInstantiateOperation, dependencies);
    case 'prefab.create_from_node':
      return createFromNode(operation as PrefabCreateFromNodeOperation, dependencies);
    case 'prefab.delete_asset':
      return deleteAsset(operation as PrefabDeleteAssetOperation, dependencies);
    case 'prefab.revert_override':
      return revertOverride(operation as PrefabRevertOverrideOperation, dependencies);
    case 'prefab.apply_to_source':
      return applyToSource(operation as PrefabApplyToSourceOperation, dependencies);
    case 'prefab.unlink_instance':
      return unlinkInstance(operation as PrefabInstanceOperation, dependencies);
    case 'prefab.link_instance':
      return linkInstance(operation as PrefabLinkOperation, dependencies);
    case 'prefab.replace_source':
      return replaceSource(operation as PrefabReplaceOperation, dependencies);
    default:
      throw new ProbeError('INVALID_WRITE_OPERATION', { type: operation.type });
  }
}

type PrefabInstantiateOperation = WriteOperation & { prefabAssetUuid: string; parentNodeUuid: string; name?: string };
type PrefabCreateFromNodeOperation = WriteOperation & { nodeUuid: string; assetUrl: string };
type PrefabDeleteAssetOperation = WriteOperation & { assetUrl: string };
type PrefabRevertOverrideOperation = WriteOperation & { instanceRootUuid: string; propertyPath?: string };
type PrefabApplyToSourceOperation = WriteOperation & { instanceRootUuid: string };
type PrefabInstanceOperation = WriteOperation & { instanceRootUuid: string };
type PrefabLinkOperation = WriteOperation & { nodeUuid: string; prefabAssetUuid: string };
type PrefabReplaceOperation = WriteOperation & { instanceRootUuid: string; newPrefabAssetUuid: string };

/**
 * 解除实例关联：门面 unlinkPrefab（自带 Undo 录制，实测 undo 可恢复关联）。
 * 子树保留；逆操作为按原源资产重新关联。
 */
async function unlinkInstance(
  operation: PrefabInstanceOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const before = requireInstance(
    await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid),
    operation.instanceRootUuid
  );
  await dependencies.unlinkPrefabInstance(operation.instanceRootUuid);
  const after = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid);
  return {
    nodeUuid: operation.instanceRootUuid,
    assetUuid: null,
    before,
    after,
    inverse: [{ type: 'prefab.link_instance', nodeUuid: operation.instanceRootUuid, prefabAssetUuid: before.prefabAssetUuid }]
  };
}

/** 重新关联：把节点关联到指定预制体资产；关联后实例信息必须建立。 */
async function linkInstance(
  operation: PrefabLinkOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const asset = await dependencies.queryAssetInfo(operation.prefabAssetUuid);
  if (!asset) {
    throw new ProbeError('PREFAB_ASSET_NOT_FOUND', { prefabAssetUuid: operation.prefabAssetUuid });
  }
  if (asset.type !== 'cc.Prefab') {
    throw new ProbeError('PREFAB_ASSET_TYPE_MISMATCH', { prefabAssetUuid: operation.prefabAssetUuid, actualType: asset.type });
  }
  const before = await dependencies.getPrefabInstanceInfo(operation.nodeUuid);
  if (!before) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: operation.nodeUuid });
  }
  await dependencies.linkPrefabInstance(operation.nodeUuid, operation.prefabAssetUuid);
  const after = await dependencies.getPrefabInstanceInfo(operation.nodeUuid);
  if (!after || after.prefabAssetUuid !== operation.prefabAssetUuid || !after.instanceFileId) {
    throw new ProbeError('PREFAB_LINK_NOT_ESTABLISHED', {
      nodeUuid: operation.nodeUuid,
      expectedAssetUuid: operation.prefabAssetUuid,
      actualAssetUuid: after?.prefabAssetUuid ?? null,
      instanceFileId: after?.instanceFileId ?? null
    });
  }
  return {
    nodeUuid: operation.nodeUuid,
    assetUuid: null,
    before,
    after,
    inverse: [{ type: 'prefab.unlink_instance', instanceRootUuid: operation.nodeUuid }]
  };
}

/**
 * 替换实例源资产：关联到新预制体资产。
 * 安全规则：新源必须存在且为 cc.Prefab；与当前源相同视为无效操作；
 * 新源为当前文档自身时拒绝（防自嵌套循环，设计规格 8.4）。
 */
async function replaceSource(
  operation: PrefabReplaceOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const before = requireInstance(
    await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid),
    operation.instanceRootUuid
  );
  if (operation.newPrefabAssetUuid === before.prefabAssetUuid) {
    throw new ProbeError('PREFAB_REPLACE_NOOP', { instanceRootUuid: operation.instanceRootUuid, prefabAssetUuid: operation.newPrefabAssetUuid });
  }
  const asset = await dependencies.queryAssetInfo(operation.newPrefabAssetUuid);
  if (!asset) {
    throw new ProbeError('PREFAB_ASSET_NOT_FOUND', { prefabAssetUuid: operation.newPrefabAssetUuid });
  }
  if (asset.type !== 'cc.Prefab') {
    throw new ProbeError('PREFAB_ASSET_TYPE_MISMATCH', { prefabAssetUuid: operation.newPrefabAssetUuid, actualType: asset.type });
  }
  const documentAssetUuid = await dependencies.getCurrentDocumentAssetUuid();
  if (documentAssetUuid && operation.newPrefabAssetUuid === documentAssetUuid) {
    throw new ProbeError('PREFAB_CYCLE', { instanceRootUuid: operation.instanceRootUuid, newPrefabAssetUuid: operation.newPrefabAssetUuid });
  }
  await dependencies.linkPrefabInstance(operation.instanceRootUuid, operation.newPrefabAssetUuid);
  const after = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid);
  if (!after || after.prefabAssetUuid !== operation.newPrefabAssetUuid || !after.instanceFileId) {
    throw new ProbeError('PREFAB_LINK_NOT_ESTABLISHED', {
      instanceRootUuid: operation.instanceRootUuid,
      expectedAssetUuid: operation.newPrefabAssetUuid,
      actualAssetUuid: after?.prefabAssetUuid ?? null
    });
  }
  return {
    nodeUuid: operation.instanceRootUuid,
    assetUuid: null,
    before,
    after,
    inverse: [{ type: 'prefab.replace_source', instanceRootUuid: operation.instanceRootUuid, newPrefabAssetUuid: before.prefabAssetUuid }]
  };
}

/** 目标不是完整预制体实例时统一拒绝。 */
function requireInstance(info: PrefabInstanceInfo | null, instanceRootUuid: string): PrefabInstanceInfo {
  if (!info || !info.instanceFileId || !info.prefabAssetUuid) {
    throw new ProbeError('PREFAB_INSTANCE_REQUIRED', { instanceRootUuid });
  }
  return info;
}

/**
 * 还原实例覆盖。整实例走 restorePrefab（实测整粒度可用）；
 * 指定 propertyPath 时走 Inspector 同款 resetProperty（源值重置）。
 * 覆盖一经还原无法由逆操作无损恢复（原覆盖值已丢），逆操作为空并保留 before 证据供审计。
 */
async function revertOverride(
  operation: PrefabRevertOverrideOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const before = requireInstance(
    await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid),
    operation.instanceRootUuid
  );
  if (operation.propertyPath) {
    await dependencies.resetNodeProperty(operation.instanceRootUuid, operation.propertyPath);
  } else {
    await dependencies.revertPrefabInstance(operation.instanceRootUuid);
  }
  const after = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid);
  return {
    nodeUuid: operation.instanceRootUuid,
    assetUuid: null,
    before,
    after,
    inverse: []
  };
}

/**
 * 把实例覆盖应用到源预制体（门面 applyPrefab，直写源资产盘）。
 * 源资产已被改写，逆操作无法恢复旧源内容；逆操作为空并保留 before 证据供审计与人工恢复。
 */
async function applyToSource(
  operation: PrefabApplyToSourceOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const before = requireInstance(
    await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid),
    operation.instanceRootUuid
  );
  await dependencies.applyPrefabInstance(operation.instanceRootUuid);
  const after = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid);
  return {
    nodeUuid: operation.instanceRootUuid,
    assetUuid: null,
    before,
    after,
    inverse: []
  };
}

async function instantiatePrefab(
  operation: PrefabInstantiateOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const asset = await dependencies.queryAssetInfo(operation.prefabAssetUuid);
  if (!asset) {
    throw new ProbeError('PREFAB_ASSET_NOT_FOUND', { prefabAssetUuid: operation.prefabAssetUuid });
  }
  if (asset.type !== 'cc.Prefab') {
    throw new ProbeError('PREFAB_ASSET_TYPE_MISMATCH', { prefabAssetUuid: operation.prefabAssetUuid, actualType: asset.type });
  }
  const parent = await dependencies.getPrefabInstanceInfo(operation.parentNodeUuid);
  if (!parent) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: operation.parentNodeUuid });
  }
  const nodeUuid = await dependencies.instantiatePrefab(operation.parentNodeUuid, operation.prefabAssetUuid, operation.name);
  const after = await dependencies.getPrefabInstanceInfo(nodeUuid);
  if (!after || !after.instanceFileId || after.prefabAssetUuid !== operation.prefabAssetUuid) {
    // 实例信息未正确建立时必须报错，由事务回滚兜底，避免半实例状态外流。
    throw new ProbeError('PREFAB_INSTANCE_NOT_ESTABLISHED', {
      nodeUuid,
      expectedAssetUuid: operation.prefabAssetUuid,
      actualAssetUuid: after?.prefabAssetUuid ?? null,
      instanceFileId: after?.instanceFileId ?? null
    });
  }
  return {
    nodeUuid,
    assetUuid: null,
    before: null,
    after,
    inverse: [{ type: 'node.delete', nodeUuid }]
  };
}

async function createFromNode(
  operation: PrefabCreateFromNodeOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  // 路径预检：asset-db/create-asset 对既有路径会弹模态框无限阻塞（能力矩阵已记录）。
  const existing = await dependencies.queryAssetInfo(operation.assetUrl);
  if (existing) {
    throw new ProbeError('ASSET_ALREADY_EXISTS', { assetUrl: operation.assetUrl });
  }
  const before = await dependencies.getPrefabInstanceInfo(operation.nodeUuid);
  if (!before) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: operation.nodeUuid });
  }
  const assetUuid = await dependencies.createPrefabFromNode(operation.nodeUuid, operation.assetUrl);
  const after = await dependencies.getPrefabInstanceInfo(operation.nodeUuid);
  return {
    nodeUuid: operation.nodeUuid,
    assetUuid,
    before,
    after,
    inverse: [
      { type: 'prefab.unlink_instance', instanceRootUuid: operation.nodeUuid },
      { type: 'prefab.delete_asset', assetUrl: operation.assetUrl }
    ]
  };
}

async function deleteAsset(
  operation: PrefabDeleteAssetOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  await dependencies.deleteAsset(operation.assetUrl);
  return {
    nodeUuid: null,
    assetUuid: null,
    before: null,
    after: null,
    // 资产删除不可由逆操作还原（内容已丢失），回滚链路到此前为止。
    inverse: []
  };
}
