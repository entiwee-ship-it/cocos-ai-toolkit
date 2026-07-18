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
    default:
      throw new ProbeError('INVALID_WRITE_OPERATION', { type: operation.type });
  }
}

type PrefabInstantiateOperation = WriteOperation & { prefabAssetUuid: string; parentNodeUuid: string; name?: string };
type PrefabCreateFromNodeOperation = WriteOperation & { nodeUuid: string; assetUrl: string };
type PrefabDeleteAssetOperation = WriteOperation & { assetUrl: string };

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
