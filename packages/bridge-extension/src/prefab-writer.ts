import { ProbeError } from './probe-errors';
import { createHash } from 'node:crypto';
import type { WriteOperation } from './write-types';

/** 预制体实例节点的可序列化证据快照（对齐 Phase 1 只读模型的 __prefab__ 结构）。 */
export interface PrefabInstanceInfo {
  nodeUuid: string;
  name: string;
  /** 保存重载后会话 UUID 会变化；稳定层级路径用于重新定位实例根。 */
  stablePath?: string;
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
  /** 覆盖目标清单：path 与 targetFileId（targetInfo.localID 首段），根挂载点覆盖的 targetFileId 等于 sourceObjectFileId。 */
  overrideTargets: Array<{
    path: string;
    targetFileId: string | null;
    targetLocalIds?: string[];
  }>;
}

export interface PrefabSubtreeSnapshot {
  rootStablePath: string;
  nodes: Array<{
    nodeUuid: string;
    relativePath: string;
    name: string;
    componentTypes: string[];
    prefabAssetUuid: string | null;
    instanceFileId: string | null;
    isNested: boolean | null;
    state: number | null;
  }>;
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
  getPrefabSubtreeSnapshot(nodeUuid: string): Promise<PrefabSubtreeSnapshot | null>;
  /** 按资产 UUID 或 db:// URL 预检资产；不存在返回 null。 */
  queryAssetInfo(uuidOrUrl: string): Promise<PrefabAssetInfo | null>;
  /** 经 scene/create-node 消息实例化（type='cc.Prefab'），返回新节点 UUID。 */
  instantiatePrefab(parentNodeUuid: string, prefabAssetUuid: string, name?: string): Promise<string>;
  /** 经门面 createPrefab 从场景节点生成预制体资产，返回资产 UUID。 */
  createPrefabFromNode(nodeUuid: string, assetUrl: string): Promise<string>;
  createAsset(assetUrl: string, assetKind: 'folder' | 'component-script', content: string | null): Promise<PrefabAssetInfo>;
  moveAsset(sourceUrl: string, targetUrl: string): Promise<void>;
  readAssetMeta(assetUrl: string): Promise<Record<string, unknown>>;
  writeAssetMeta(assetUrl: string, meta: Record<string, unknown>): Promise<void>;
  readAssetContent(assetUrl: string): Promise<string>;
  saveAssetContent(assetUrl: string, content: string): Promise<void>;
  deleteAsset(assetUrl: string): Promise<void>;
  revertPrefabInstance(instanceRootUuid: string): Promise<void>;
  applyPrefabInstance(instanceRootUuid: string): Promise<void>;
  unlinkPrefabInstance(instanceRootUuid: string, removeNested: boolean): Promise<void>;
  linkPrefabInstance(nodeUuid: string, prefabAssetUuid: string): Promise<void>;
  /** 按属性路径重置实例节点属性为源值（Inspector 单属性还原同款路径）。 */
  resetNodeProperty(nodeUuid: string, propertyPath: string): Promise<void>;
  setPrefabInstanceOverride(
    instanceRootUuid: string,
    targetObjectUuid: string,
    propertyPath: string,
    value: unknown
  ): Promise<{ targetLocalIds: string[]; previous: { value: unknown } | null }>;
  removePrefabInstanceOverride(
    instanceRootUuid: string,
    targetObjectUuid: string,
    propertyPath: string
  ): Promise<{ targetLocalIds: string[]; previous: { value: unknown } | null }>;
  /** 当前编辑文档的资产 UUID（替换源时防自嵌套循环）。 */
  getCurrentDocumentAssetUuid(): Promise<string | null>;
  /**
   * createPrefab 会重建节点（会话 UUID 变更）：按父节点 + 名称 + 源资产重定位新实例根。
   * 找不到时返回 null（调用方按稳定错误码处理）。
   */
  findPrefabInstanceRoot(parentUuid: string | null, name: string, prefabAssetUuid: string): Promise<string | null>;
  /** 实例根重定位的轮询预算毫秒数；缺省 5000（节点树刷新晚于资产创建返回）。 */
  relocatePollBudgetMs?: number;
}

export interface PrefabWriteOpResult {
  /** 操作产生或目标节点 UUID（实例化返回新节点）。 */
  nodeUuid: string | null;
  /** create_from_node 返回的新资产 UUID。 */
  assetUuid: string | null;
  before: Partial<PrefabInstanceInfo> | Record<string, unknown> | null;
  after: Partial<PrefabInstanceInfo> | Record<string, unknown> | null;
  beforeSubtree?: PrefabSubtreeSnapshot | null;
  afterSubtree?: PrefabSubtreeSnapshot | null;
  targetLocalIds?: string[];
  /** 精确覆盖写入/还原前的覆盖值；重载后验证源值恢复时使用。 */
  previousOverride?: { value: unknown } | null;
}

/**
 * 执行单个预制体或资产原子写操作并返回 before/after 证据。
 * 输入已由直写协议校验，本模块按操作类型收窄读取。
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
    case 'prefab.instance_override':
      return instanceOverride(operation as PrefabInstanceOverrideOperation, dependencies);
    case 'prefab.delete_asset':
      return deleteAsset(operation as PrefabDeleteAssetOperation, dependencies);
    case 'asset.create':
      return createAsset(operation as AssetCreateOperation, dependencies);
    case 'asset.move':
      return moveAsset(operation as AssetMoveOperation, dependencies);
    case 'asset.delete':
      return deleteGenericAsset(operation as AssetIdentityOperation, dependencies);
    case 'asset.write_meta':
      return writeAssetMeta(operation as AssetWriteMetaOperation, dependencies);
    case 'asset.update_text':
      return updateAssetText(operation as AssetUpdateTextOperation, dependencies);
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
type PrefabInstanceOverrideOperation = WriteOperation & {
  instanceRootUuid: string;
  targetObjectUuid: string;
  targetNodePath?: string;
  propertyPath: string;
  value: unknown;
};
type PrefabRevertOverrideOperation = WriteOperation & {
  instanceRootUuid: string;
  targetObjectUuid?: string;
  targetNodePath?: string;
  propertyPath?: string;
};
type PrefabApplyToSourceOperation = WriteOperation & { instanceRootUuid: string };
type PrefabInstanceOperation = WriteOperation & {
  instanceRootUuid: string;
  removeNested: boolean;
  expectedPrefabAssetUuid: string;
};
type PrefabLinkOperation = WriteOperation & { nodeUuid: string; prefabAssetUuid: string };
type PrefabReplaceOperation = WriteOperation & { instanceRootUuid: string; newPrefabAssetUuid: string };
type AssetCreateOperation = WriteOperation & {
  assetUrl: string;
  assetKind: 'folder' | 'component-script' | 'prefab';
  content?: string;
};
type AssetMoveOperation = WriteOperation & {
  sourceUrl: string;
  targetUrl: string;
  expectedAssetUuid: string;
};
type AssetIdentityOperation = WriteOperation & { assetUrl: string; expectedAssetUuid: string };
type AssetWriteMetaOperation = AssetIdentityOperation & { meta: Record<string, unknown> };
type AssetUpdateTextOperation = AssetIdentityOperation & {
  expectedCurrentSha256?: string;
  oldText: string;
  newText: string;
};

/** 解除实例关联：保留节点子树并返回关联前后证据。 */
async function unlinkInstance(
  operation: PrefabInstanceOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const before = requireInstance(
    await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid),
    operation.instanceRootUuid
  );
  if (before.prefabAssetUuid !== operation.expectedPrefabAssetUuid) {
    throw new ProbeError('PREFAB_IDENTITY_MISMATCH', {
      nodeUuid: operation.instanceRootUuid,
      expectedPrefabAssetUuid: operation.expectedPrefabAssetUuid,
      actualPrefabAssetUuid: before.prefabAssetUuid
    });
  }
  const beforeSubtree = await dependencies.getPrefabSubtreeSnapshot(operation.instanceRootUuid);
  if (!beforeSubtree) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: operation.instanceRootUuid });
  }
  await dependencies.unlinkPrefabInstance(operation.instanceRootUuid, false);
  let afterSubtree = await dependencies.getPrefabSubtreeSnapshot(operation.instanceRootUuid);
  if (operation.removeNested) {
    let previousNestedCount = countRemainingInstanceRoots(afterSubtree);
    while (afterSubtree && previousNestedCount > 0) {
      const nestedRoot = findDeepestRemainingInstanceRoot(afterSubtree);
      if (!nestedRoot) break;
      await dependencies.unlinkPrefabInstance(nestedRoot.nodeUuid, false);
      const next = await dependencies.getPrefabSubtreeSnapshot(operation.instanceRootUuid);
      const nextNestedCount = countRemainingInstanceRoots(next);
      if (!next || nextNestedCount >= previousNestedCount) {
        throw new ProbeError('PREFAB_COMPLETE_UNPACK_INCOMPLETE', {
          nodeUuid: operation.instanceRootUuid,
          previousNestedCount,
          nextNestedCount
        });
      }
      afterSubtree = next;
      previousNestedCount = nextNestedCount;
    }
  }
  const after = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid);
  return {
    nodeUuid: operation.instanceRootUuid,
    assetUuid: null,
    before,
    after,
    beforeSubtree,
    afterSubtree
  };
}

function countRemainingInstanceRoots(snapshot: PrefabSubtreeSnapshot | null): number {
  return snapshot?.nodes.filter((node) => node.state === 2 && Boolean(node.prefabAssetUuid)).length ?? 0;
}

function findDeepestRemainingInstanceRoot(snapshot: PrefabSubtreeSnapshot) {
  return snapshot.nodes
    .filter((node) => node.state === 2 && Boolean(node.prefabAssetUuid))
    .sort((left, right) => right.relativePath.split('/').length - left.relativePath.split('/').length)[0]
    ?? null;
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
    after
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
    after
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
  if (operation.targetObjectUuid && operation.propertyPath) {
    const removed = await dependencies.removePrefabInstanceOverride(
      operation.instanceRootUuid,
      operation.targetObjectUuid,
      operation.propertyPath
    );
    const after = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid);
    return {
      nodeUuid: operation.instanceRootUuid,
      assetUuid: null,
      before,
      after,
      targetLocalIds: removed.targetLocalIds,
      previousOverride: removed.previous
    };
  }
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
    // 实例关系未建立时立即失败；调用方必须先重读当前文档，不能把半实例状态当成成功。
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
    after
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
  // createPrefab 会重建节点（实测：原会话 UUID 失效，且节点树刷新晚于资产创建返回），
  // 按父节点 + 名称 + 新源资产有界轮询重定位实例根（预算可注入，默认 5 秒）。
  let resolvedRootUuid: string | null = null;
  const deadline = Date.now() + (dependencies.relocatePollBudgetMs ?? 5_000);
  do {
    resolvedRootUuid = await dependencies.findPrefabInstanceRoot(before.parentUuid, before.name, assetUuid).catch(() => null);
    if (!resolvedRootUuid && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  } while (!resolvedRootUuid && Date.now() < deadline);
  if (!resolvedRootUuid) {
    // 资产已创建但实例根定位失败：尽力清理新建资产，避免失败路径留下磁盘残留。
    await dependencies.deleteAsset(operation.assetUrl).catch(() => undefined);
    throw new ProbeError('PREFAB_INSTANCE_NOT_ESTABLISHED', {
      nodeUuid: operation.nodeUuid,
      assetUuid,
      reason: 'createPrefab 后 5 秒内无法重定位实例根（原 UUID 已失效），已尽力清理新建资产'
    });
  }
  const after = await dependencies.getPrefabInstanceInfo(resolvedRootUuid);
  return {
    nodeUuid: resolvedRootUuid,
    assetUuid,
    before,
    after
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
  };
}

async function instanceOverride(
  operation: PrefabInstanceOverrideOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const before = requireInstance(
    await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid),
    operation.instanceRootUuid
  );
  const written = await dependencies.setPrefabInstanceOverride(
    operation.instanceRootUuid,
    operation.targetObjectUuid,
    operation.propertyPath,
    operation.value
  );
  const after = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid);
  return {
    nodeUuid: operation.instanceRootUuid,
    assetUuid: null,
    before,
    after,
    targetLocalIds: written.targetLocalIds,
    previousOverride: written.previous
  };
}

async function createAsset(
  operation: AssetCreateOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  assertAssetUrl(operation.assetUrl);
  if (operation.assetKind === 'prefab' || operation.assetUrl.toLowerCase().endsWith('.prefab')) {
    throw new ProbeError('PREFAB_CREATION_REQUIRES_NODE', {
      assetUrl: operation.assetUrl,
      nextAction: '请使用 prefab.create_from_node 或 document.extract_subtree'
    });
  }
  if (operation.assetKind === 'component-script') {
    if (!operation.assetUrl.toLowerCase().endsWith('.ts') || !operation.content) {
      throw new ProbeError('COMPONENT_SCRIPT_CONTENT_REQUIRED', { assetUrl: operation.assetUrl });
    }
  }
  if (await dependencies.queryAssetInfo(operation.assetUrl)) {
    throw new ProbeError('ASSET_ALREADY_EXISTS', { assetUrl: operation.assetUrl });
  }
  const created = await dependencies.createAsset(
    operation.assetUrl,
    operation.assetKind,
    operation.assetKind === 'component-script' ? operation.content ?? null : null
  );
  const actual = await dependencies.queryAssetInfo(operation.assetUrl);
  if (!actual) {
    throw new ProbeError('ASSET_CREATE_POSTVERIFY_FAILED', { assetUrl: operation.assetUrl });
  }
  if (created.uuid && actual.uuid !== created.uuid) {
    throw new ProbeError('ASSET_UUID_DRIFT', {
      assetUrl: operation.assetUrl,
      expectedAssetUuid: created.uuid,
      actualAssetUuid: actual.uuid
    });
  }
  return {
    nodeUuid: null,
    assetUuid: actual.uuid,
    before: null,
    after: { assetUrl: operation.assetUrl, assetUuid: actual.uuid, assetType: actual.type }
  };
}

async function moveAsset(
  operation: AssetMoveOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  assertAssetUrl(operation.sourceUrl);
  assertAssetUrl(operation.targetUrl);
  if (operation.sourceUrl === operation.targetUrl) {
    throw new ProbeError('ASSET_MOVE_NOOP', { assetUrl: operation.sourceUrl });
  }
  const source = await requireAssetIdentity(dependencies, operation.sourceUrl, operation.expectedAssetUuid);
  if (await dependencies.queryAssetInfo(operation.targetUrl)) {
    throw new ProbeError('ASSET_ALREADY_EXISTS', { assetUrl: operation.targetUrl });
  }
  await dependencies.moveAsset(operation.sourceUrl, operation.targetUrl);
  const [oldLocation, moved] = await Promise.all([
    dependencies.queryAssetInfo(operation.sourceUrl),
    dependencies.queryAssetInfo(operation.targetUrl)
  ]);
  if (oldLocation || !moved || moved.uuid !== operation.expectedAssetUuid) {
    await dependencies.moveAsset(operation.targetUrl, operation.sourceUrl).catch(() => undefined);
    throw new ProbeError('ASSET_UUID_DRIFT', {
      sourceUrl: operation.sourceUrl,
      targetUrl: operation.targetUrl,
      expectedAssetUuid: operation.expectedAssetUuid,
      actualAssetUuid: moved?.uuid ?? null,
      sourceStillExists: Boolean(oldLocation)
    });
  }
  return {
    nodeUuid: null,
    assetUuid: moved.uuid,
    before: { assetUrl: operation.sourceUrl, assetUuid: source.uuid, assetType: source.type },
    after: { assetUrl: operation.targetUrl, assetUuid: moved.uuid, assetType: moved.type }
  };
}

async function deleteGenericAsset(
  operation: AssetIdentityOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const existing = await requireAssetIdentity(dependencies, operation.assetUrl, operation.expectedAssetUuid);
  await dependencies.deleteAsset(operation.assetUrl);
  if (await dependencies.queryAssetInfo(operation.assetUrl)) {
    throw new ProbeError('ASSET_DELETE_POSTVERIFY_FAILED', { assetUrl: operation.assetUrl });
  }
  return {
    nodeUuid: null,
    assetUuid: existing.uuid,
    before: { assetUrl: operation.assetUrl, assetUuid: existing.uuid, assetType: existing.type },
    after: null,
  };
}

async function writeAssetMeta(
  operation: AssetWriteMetaOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  const existing = await requireAssetIdentity(dependencies, operation.assetUrl, operation.expectedAssetUuid);
  const requestedUuid = operation.meta.uuid;
  if (typeof requestedUuid === 'string' && requestedUuid !== operation.expectedAssetUuid) {
    throw new ProbeError('ASSET_META_UUID_MUTATION_FORBIDDEN', {
      assetUrl: operation.assetUrl,
      expectedAssetUuid: operation.expectedAssetUuid,
      requestedUuid
    });
  }
  const beforeMeta = await dependencies.readAssetMeta(operation.assetUrl);
  await dependencies.writeAssetMeta(operation.assetUrl, operation.meta);
  const after = await requireAssetIdentity(dependencies, operation.assetUrl, operation.expectedAssetUuid);
  return {
    nodeUuid: null,
    assetUuid: after.uuid,
    before: { assetUrl: operation.assetUrl, assetUuid: existing.uuid, meta: beforeMeta },
    after: { assetUrl: operation.assetUrl, assetUuid: after.uuid, meta: operation.meta }
  };
}

/** 通过精确 UUID 与唯一旧文本锚点安全更新现有脚本文本资产。 */
async function updateAssetText(
  operation: AssetUpdateTextOperation,
  dependencies: PrefabWriterDependencies
): Promise<PrefabWriteOpResult> {
  assertTextAssetUrl(operation.assetUrl);
  const existing = await requireAssetIdentity(dependencies, operation.assetUrl, operation.expectedAssetUuid);
  const beforeContent = await dependencies.readAssetContent(operation.assetUrl);
  const beforeSha256 = sha256(beforeContent);
  if (operation.expectedCurrentSha256 && beforeSha256 !== operation.expectedCurrentSha256) {
    throw new ProbeError('ASSET_CONTENT_PRECONDITION_FAILED', {
      assetUrl: operation.assetUrl,
      expectedCurrentSha256: operation.expectedCurrentSha256,
      actualCurrentSha256: beforeSha256
    });
  }
  if (operation.oldText === operation.newText) {
    throw new ProbeError('ASSET_TEXT_REPLACEMENT_NOOP', { assetUrl: operation.assetUrl });
  }
  const matches = findTextMatches(beforeContent, operation.oldText);
  if (matches.length !== 1) {
    throw new ProbeError('ASSET_TEXT_MATCH_COUNT_INVALID', {
      assetUrl: operation.assetUrl,
      matchCount: matches.length,
      nextAction: '重新读取目标资产并提供只出现一次的精确 oldText'
    });
  }
  const matchIndex = matches[0];
  const targetContent = beforeContent.slice(0, matchIndex)
    + operation.newText
    + beforeContent.slice(matchIndex + operation.oldText.length);
  const targetSha256 = sha256(targetContent);
  await dependencies.saveAssetContent(operation.assetUrl, targetContent);
  const [afterAsset, afterContent] = await Promise.all([
    requireAssetIdentity(dependencies, operation.assetUrl, operation.expectedAssetUuid),
    dependencies.readAssetContent(operation.assetUrl)
  ]);
  const afterSha256 = sha256(afterContent);
  if (afterContent !== targetContent) {
    throw new ProbeError('ASSET_CONTENT_POSTVERIFY_FAILED', {
      assetUrl: operation.assetUrl,
      expectedTargetSha256: targetSha256,
      actualTargetSha256: afterSha256
    });
  }
  return {
    nodeUuid: null,
    assetUuid: afterAsset.uuid,
    before: { assetUrl: operation.assetUrl, assetUuid: existing.uuid, sha256: beforeSha256, matchCount: 1 },
    after: { assetUrl: operation.assetUrl, assetUuid: afterAsset.uuid, sha256: afterSha256, matchCount: 1 }
  };
}

async function requireAssetIdentity(
  dependencies: PrefabWriterDependencies,
  assetUrl: string,
  expectedAssetUuid: string
): Promise<PrefabAssetInfo> {
  assertAssetUrl(assetUrl);
  const asset = await dependencies.queryAssetInfo(assetUrl);
  if (!asset) throw new ProbeError('ASSET_NOT_FOUND', { assetUrl });
  if (asset.uuid !== expectedAssetUuid) {
    throw new ProbeError('ASSET_IDENTITY_MISMATCH', {
      assetUrl,
      expectedAssetUuid,
      actualAssetUuid: asset.uuid
    });
  }
  return asset;
}

function assertAssetUrl(assetUrl: string): void {
  if (!assetUrl.startsWith('db://assets/') || assetUrl.includes('\\') || assetUrl.split('/').includes('..')) {
    throw new ProbeError('ASSET_URL_INVALID', { assetUrl });
  }
}

function assertTextAssetUrl(assetUrl: string): void {
  assertAssetUrl(assetUrl);
  const lower = assetUrl.toLowerCase();
  if (!['.ts', '.js', '.json'].some((extension) => lower.endsWith(extension))) {
    throw new ProbeError('ASSET_TEXT_TYPE_REQUIRED', { assetUrl, allowedExtensions: ['.ts', '.js', '.json'] });
  }
}

function findTextMatches(content: string, search: string): number[] {
  const matches: number[] = [];
  let offset = 0;
  while (offset <= content.length - search.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) break;
    matches.push(index);
    offset = index + 1;
  }
  return matches;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
