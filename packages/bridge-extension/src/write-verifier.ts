import { deepEqual } from './component-writer';
import { createHash } from 'node:crypto';
import type { ComponentWriteOpResult } from './component-writer';
import type { NodeWriteOpResult } from './node-writer';
import type { PrefabWriteOpResult } from './prefab-writer';
import type {
  WriteOperation,
  WriteVerificationItem,
  WriteVerificationReport
} from './write-types';

import type { PrefabAssetInfo, PrefabInstanceInfo } from './prefab-writer';

/** 已执行完成、等待重读验证的写操作（原始操作 + 执行证据）。 */
export type VerifiedOperation = (NodeWriteOpResult | ComponentWriteOpResult | PrefabWriteOpResult) & {
  operation: WriteOperation;
  /** false 表示执行阶段确认目标状态已满足，不应触发无语义保存。 */
  changed?: boolean;
};

/**
 * 重读验证依赖。saveDocument/reloadDocument 复用 Creator 保存与关闭重开（或等价刷新），
 * 读取依赖复用 Phase 1 文档快照链路（Scene query-node/query-component）。
 */
export interface WriteVerifierDependencies {
  saveDocument(): Promise<void>;
  reloadDocument(): Promise<void>;
  getNodeInfo(nodeUuid: string): Promise<Record<string, unknown> | null>;
  getNodeInfoByStablePath?(stablePath: string): Promise<Record<string, unknown> | null>;
  getComponentInfo(componentUuid: string): Promise<Record<string, unknown> | null>;
  getComponentInfoByStableLocator?(
    nodeStablePath: string,
    componentType: string,
    sameTypeIndex: number
  ): Promise<Record<string, unknown> | null>;
  getComponentProperty(componentUuid: string, propertyPath: string): Promise<unknown>;
  getPrefabInstanceInfo(nodeUuid: string): Promise<PrefabInstanceInfo | null>;
  getPrefabTargetProperty?(
    instanceRootUuid: string,
    targetLocalIds: string[],
    propertyPath: string
  ): Promise<unknown>;
  queryAssetInfo(uuidOrUrl: string): Promise<PrefabAssetInfo | null>;
  readAssetMeta(assetUrl: string): Promise<Record<string, unknown>>;
  readAssetContent(assetUrl: string): Promise<string>;
}

/**
 * 保存并按计划期望值逐项重读验证。save=true 时先保存文档、关闭重开（或等价刷新）再重读；
 * 任一项不符 passed 即为 false，由调用方按写失败处理。
 *
 * @param request 写请求（只取 save 开关）。
 * @param executed 已执行的写操作及其证据。
 * @param dependencies 保存与重读依赖。
 * @returns 重读验证报告，随写响应带回。
 */
export async function saveAndVerifyWriteTransaction(
  request: { save: boolean },
  executed: VerifiedOperation[],
  dependencies: WriteVerifierDependencies
): Promise<WriteVerificationReport> {
  const items: WriteVerificationItem[] = [];
  const preverified = new Map<number, WriteVerificationItem>();
  for (let index = 0; index < executed.length; index += 1) {
    if (executed[index].changed === false) {
      preverified.set(index, await verifyOperation(index, executed[index].operation, dependencies));
    }
  }
  const hasChanges = executed.some((operation) => operation.changed !== false);
  if (request.save && hasChanges) {
    await dependencies.saveDocument();
    await dependencies.reloadDocument();
  }

  for (let index = 0; index < executed.length; index += 1) {
    items.push(preverified.get(index)
      ?? await verifyOperation(index, executed[index].operation, dependencies));
  }
  return {
    passed: items.every((item) => item.passed),
    verifiedAt: new Date().toISOString(),
    items
  };
}

async function verifyOperation(
  operationIndex: number,
  operation: WriteOperation,
  dependencies: WriteVerifierDependencies
): Promise<WriteVerificationItem> {
  try {
    return await verifyOperationUnsafe(operationIndex, operation, dependencies);
  } catch (error) {
    // 重读本身失败不能放过：按不通过处理，保留失败原因作 actual。
    return {
      operationIndex,
      description: describeOperation(operation),
      expected: expectationSummary(operation),
      actual: `READ_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      passed: false
    };
  }
}

async function verifyOperationUnsafe(
  operationIndex: number,
  operation: WriteOperation,
  dependencies: WriteVerifierDependencies
): Promise<WriteVerificationItem> {
  const description = describeOperation(operation);
  const build = (expected: unknown, actual: unknown, passed: boolean): WriteVerificationItem => ({
    operationIndex,
    description,
    expected,
    actual,
    passed
  });

  switch (operation.type) {
    case 'node.create':
    case 'node.duplicate': {
      const nodeUuid = operation.type === 'node.create' || operation.type === 'node.duplicate'
        ? readResultNodeUuid(operation)
        : null;
      const actual = nodeUuid ? await resolveNodeInfo(operation, nodeUuid, dependencies) : null;
      return build('节点存在', actual === null ? null : '节点存在', actual !== null);
    }
    case 'node.delete': {
      const actual = await resolveNodeInfo(operation, operation.nodeUuid as string, dependencies);
      return build('节点不存在', actual === null ? '节点不存在' : '节点仍存在', actual === null);
    }
    case 'node.rename': {
      const actual = await resolveNodeInfo(operation, operation.nodeUuid as string, dependencies);
      const actualName = actual?.name ?? null;
      return build(operation.name, actualName, actualName === operation.name);
    }
    case 'node.reparent': {
      const actual = await resolveNodeInfo(operation, operation.nodeUuid as string, dependencies);
      const stablePath = readResultNodeStablePath(operation);
      if (stablePath) {
        return build(stablePath, actual?.stablePath ?? (actual ? stablePath : null), actual !== null);
      }
      const actualParent = actual?.parentUuid ?? null;
      return build(operation.newParentUuid, actualParent, actualParent === operation.newParentUuid);
    }
    case 'node.set_active': {
      const actual = await resolveNodeInfo(operation, operation.nodeUuid as string, dependencies);
      const actualActive = actual?.active ?? null;
      return build(operation.active, actualActive, actualActive === operation.active);
    }
    case 'node.set_layer': {
      const actual = await resolveNodeInfo(operation, operation.nodeUuid as string, dependencies);
      const actualLayer = actual?.layer ?? null;
      return build(operation.layer, actualLayer, actualLayer === operation.layer);
    }
    case 'node.set_transform': {
      const actual = await resolveNodeInfo(operation, operation.nodeUuid as string, dependencies);
      const transform = operation.localTransform as Record<string, unknown>;
      const mismatches = Object.entries(transform).filter(
        ([field, value]) => !deepEqual(actual?.[field], value)
      );
      return build(transform, pickTransform(actual), mismatches.length === 0);
    }
    case 'component.add': {
      const componentUuid = readResultComponentUuid(operation);
      const actual = componentUuid ? await resolveComponentInfo(operation, componentUuid, dependencies) : null;
      return build('组件存在', actual === null ? null : '组件存在', actual !== null);
    }
    case 'component.remove': {
      const actual = await resolveComponentInfo(operation, operation.componentUuid as string, dependencies);
      return build('组件不存在', actual === null ? '组件不存在' : '组件仍存在', actual === null);
    }
    case 'component.enable': {
      const actual = await resolveComponentInfo(operation, operation.componentUuid as string, dependencies);
      const actualEnabled = actual?.enabled ?? null;
      return build(operation.enabled, actualEnabled, actualEnabled === operation.enabled);
    }
    case 'component.set_property': {
      const component = await resolveComponentInfo(operation, operation.componentUuid as string, dependencies);
      const actual = await dependencies.getComponentProperty(
        typeof component?.uuid === 'string' ? component.uuid : operation.componentUuid as string,
        operation.propertyPath as string
      );
      return build(operation.value, actual, writeValueEqual(actual, operation.value));
    }
    case 'component.set_reference': {
      const component = await resolveComponentInfo(operation, operation.componentUuid as string, dependencies);
      const actual = await dependencies.getComponentProperty(
        typeof component?.uuid === 'string' ? component.uuid : operation.componentUuid as string,
        operation.propertyPath as string
      );
      // 引用按归一化 UUID 比对：写值为 ReferenceSchema，重读为 Dump {uuid} 形态。
      const expectedUuid = readReferenceIdentity(operation.reference);
      const actualUuid = readReferenceIdentity(actual);
      return build(expectedUuid, actualUuid, referenceIdentityIsResolved(expectedUuid) && deepEqual(expectedUuid, actualUuid));
    }
    case 'component.clear_reference': {
      const component = await resolveComponentInfo(operation, operation.componentUuid as string, dependencies);
      const actual = await dependencies.getComponentProperty(
        typeof component?.uuid === 'string' ? component.uuid : operation.componentUuid as string,
        operation.propertyPath as string
      );
      // Dump 形态的空引用为 {uuid:''}：按归一化 UUID 为空判定已清空。
      const cleared = actual === null || actual === undefined || readReferenceIdentity(actual) === null;
      return build(null, actual ?? null, cleared);
    }
    case 'component.resize_array': {
      const component = await resolveComponentInfo(operation, operation.componentUuid as string, dependencies);
      const actual = await dependencies.getComponentProperty(
        typeof component?.uuid === 'string' ? component.uuid : operation.componentUuid as string,
        operation.propertyPath as string
      );
      const actualLength = Array.isArray(actual) ? actual.length : null;
      return build(operation.length, actualLength, actualLength === operation.length);
    }
    case 'asset.create': {
      const actual = await dependencies.queryAssetInfo(operation.assetUrl as string);
      const expectedUuid = readResultAssetUuid(operation);
      return build(expectedUuid ?? '资产存在', actual?.uuid ?? null, actual !== null && (!expectedUuid || actual.uuid === expectedUuid));
    }
    case 'asset.move': {
      const [source, target] = await Promise.all([
        dependencies.queryAssetInfo(operation.sourceUrl as string),
        dependencies.queryAssetInfo(operation.targetUrl as string)
      ]);
      const actualUuid = target?.uuid ?? null;
      return build(operation.expectedAssetUuid, actualUuid, source === null && actualUuid === operation.expectedAssetUuid);
    }
    case 'asset.delete': {
      const actual = await dependencies.queryAssetInfo(operation.assetUrl as string);
      return build('资产不存在', actual === null ? '资产不存在' : actual.uuid, actual === null);
    }
    case 'asset.write_meta': {
      const asset = await dependencies.queryAssetInfo(operation.assetUrl as string);
      const actualMeta = await dependencies.readAssetMeta(operation.assetUrl as string);
      return build(
        operation.meta,
        actualMeta,
        asset?.uuid === operation.expectedAssetUuid && writeValueEqual(actualMeta, operation.meta)
      );
    }
    case 'asset.update_text': {
      const [asset, content] = await Promise.all([
        dependencies.queryAssetInfo(operation.assetUrl as string),
        dependencies.readAssetContent(operation.assetUrl as string)
      ]);
      const actual = {
        assetUuid: asset?.uuid ?? null,
        sha256: createHash('sha256').update(content).digest('hex')
      };
      const expected = {
        assetUuid: operation.expectedAssetUuid,
        sha256: operation.resultTargetSha256
      };
      return build(expected, actual, typeof expected.sha256 === 'string' && deepEqual(expected, actual));
    }
    case 'asset.restore_content': {
      const [asset, content] = await Promise.all([
        dependencies.queryAssetInfo(operation.assetUrl as string),
        dependencies.readAssetContent(operation.assetUrl as string)
      ]);
      const actual = {
        assetUuid: asset?.uuid ?? null,
        sha256: createHash('sha256').update(content).digest('hex')
      };
      const expected = {
        assetUuid: operation.expectedAssetUuid,
        sha256: operation.targetSha256
      };
      return build(expected, actual, deepEqual(expected, actual));
    }
    case 'prefab.instantiate': {
      const nodeUuid = readResultNodeUuid(operation);
      const resolved = nodeUuid ? await resolvePrefabInstance(operation, nodeUuid, dependencies) : null;
      const actual = resolved?.info ?? null;
      const matched = actual !== null
        && actual.prefabAssetUuid === operation.prefabAssetUuid
        && actual.instanceFileId !== null;
      return build('实例已建立且源资产一致', actual, matched);
    }
    case 'prefab.create_from_node': {
      // createPrefab 会重建节点：执行器已把重建后的实例根 UUID 回填到 resultNodeUuid。
      const nodeUuid = readResultNodeUuid(operation) ?? (operation.nodeUuid as string);
      const resolved = nodeUuid ? await resolvePrefabInstance(operation, nodeUuid, dependencies) : null;
      const actual = resolved?.info ?? null;
      const linked = actual !== null && actual.prefabAssetUuid !== null;
      return build('节点已关联预制体资产', actual?.prefabAssetUuid ?? null, linked);
    }
    case 'prefab.instance_override': {
      const resolved = await resolvePrefabInstance(
        operation,
        operation.instanceRootUuid as string,
        dependencies
      );
      const actualInstance = resolved?.info ?? null;
      const targetLocalIds = readStringArray(operation.resultTargetLocalIds);
      const actualValue = resolved && targetLocalIds && dependencies.getPrefabTargetProperty
        ? await dependencies.getPrefabTargetProperty(
            resolved.nodeUuid,
            targetLocalIds,
            operation.propertyPath as string
          )
        : await dependencies.getComponentProperty(
            operation.targetObjectUuid as string,
            operation.propertyPath as string
          );
      const overrideRecorded = Boolean(actualInstance && targetLocalIds && actualInstance.overrideTargets.some((target) => (
        target.path === operation.propertyPath
        && arraysEqual(target.targetLocalIds ?? [], targetLocalIds)
      )));
      return build(
        { value: operation.value, overrideRecorded: true, targetLocalIds },
        { value: actualValue, overrideRecorded, targetLocalIds },
        writeValueEqual(actualValue, operation.value) && overrideRecorded
      );
    }
    case 'prefab.delete_asset': {
      const actual = await dependencies.queryAssetInfo(operation.assetUrl as string);
      return build('资产不存在', actual === null ? '资产不存在' : '资产仍存在', actual === null);
    }
    case 'prefab.revert_override': {
      const resolved = await resolvePrefabInstance(
        operation,
        operation.instanceRootUuid as string,
        dependencies
      );
      const actual = resolved?.info ?? null;
      if (!actual) return build('实例存在', null, false);
      const targetLocalIds = readStringArray(operation.resultTargetLocalIds);
      if (operation.targetObjectUuid && operation.propertyPath && targetLocalIds) {
        const remaining = actual.overrideTargets.some((target) => (
          target.path === operation.propertyPath
          && arraysEqual(target.targetLocalIds ?? [], targetLocalIds)
        ));
        const restoredValue = resolved && dependencies.getPrefabTargetProperty
          ? await dependencies.getPrefabTargetProperty(
              resolved.nodeUuid,
              targetLocalIds,
              operation.propertyPath as string
            )
          : await dependencies.getComponentProperty(
              operation.targetObjectUuid as string,
              operation.propertyPath as string
            );
        const hadPreviousOverride = operation.resultHadPreviousOverride === true;
        const restoredFromPrevious = !hadPreviousOverride
          || !writeValueEqual(restoredValue, operation.resultPreviousOverrideValue);
        return build(
          {
            propertyPath: operation.propertyPath,
            targetLocalIds,
            overrideRemoved: true,
            sourceValueRestored: true
          },
          {
            propertyPath: operation.propertyPath,
            targetLocalIds,
            overrideRemoved: !remaining,
            restoredValue,
            sourceValueRestored: restoredFromPrevious
          },
          !remaining && restoredFromPrevious
        );
      }
      if (operation.propertyPath) {
        const remaining = actual.overridePaths.includes(operation.propertyPath as string);
        return build(`覆盖路径 ${String(operation.propertyPath)} 已还原`, actual.overridePaths, !remaining);
      }
      // 3.8.8 实测语义：整实例还原只清实例内部覆盖；根挂载点覆盖（targetFileId 等于根源 FileID）按设计保留。
      const nonRootRemaining = actual.overrideTargets.filter((target) => target.targetFileId !== actual.sourceObjectFileId);
      return build('实例内部覆盖已全部还原（根挂载点覆盖按设计保留）', actual.overrideTargets, nonRootRemaining.length === 0);
    }
    case 'prefab.apply_to_source': {
      // 设计规格 8.4：应用到源后必须验证实例关系未损坏（仍为同一源资产的完整实例）。
      const actual = (await resolvePrefabInstance(
        operation,
        operation.instanceRootUuid as string,
        dependencies
      ))?.info ?? null;
      const intact = actual !== null && actual.prefabAssetUuid !== null && actual.instanceFileId !== null;
      return build('实例关系未损坏', actual ? { prefabAssetUuid: actual.prefabAssetUuid, instanceFileId: actual.instanceFileId } : null, intact);
    }
    case 'prefab.unlink_instance': {
      const actual = (await resolvePrefabInstance(
        operation,
        operation.instanceRootUuid as string,
        dependencies
      ))?.info ?? null;
      const unlinked = actual !== null && actual.prefabAssetUuid === null;
      return build('关联已解除', actual?.prefabAssetUuid ?? null, unlinked);
    }
    case 'prefab.link_instance': {
      const actual = (await resolvePrefabInstance(
        operation,
        operation.nodeUuid as string,
        dependencies
      ))?.info ?? null;
      const linked = actual !== null && actual.prefabAssetUuid === operation.prefabAssetUuid && actual.instanceFileId !== null;
      return build(operation.prefabAssetUuid, actual?.prefabAssetUuid ?? null, linked);
    }
    case 'prefab.replace_source': {
      const actual = (await resolvePrefabInstance(
        operation,
        operation.instanceRootUuid as string,
        dependencies
      ))?.info ?? null;
      const replaced = actual !== null && actual.prefabAssetUuid === operation.newPrefabAssetUuid && actual.instanceFileId !== null;
      return build(operation.newPrefabAssetUuid, actual?.prefabAssetUuid ?? null, replaced);
    }
    default:
      return build(expectationSummary(operation), 'UNKNOWN_OPERATION_TYPE', false);
  }
}

/** node.create/node.duplicate 的目标 UUID 由执行结果产生，执行器回填到操作证据上。 */
function readResultNodeUuid(operation: WriteOperation): string | null {
  const resultNodeUuid = (operation as WriteOperation & { resultNodeUuid?: unknown }).resultNodeUuid;
  if (typeof resultNodeUuid === 'string' && resultNodeUuid) return resultNodeUuid;
  return typeof operation.nodeUuid === 'string' ? operation.nodeUuid : null;
}

function readResultComponentUuid(operation: WriteOperation): string | null {
  const resultComponentUuid = (operation as WriteOperation & { resultComponentUuid?: unknown }).resultComponentUuid;
  if (typeof resultComponentUuid === 'string' && resultComponentUuid) return resultComponentUuid;
  return typeof operation.componentUuid === 'string' ? operation.componentUuid : null;
}

function pickTransform(node: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!node) return null;
  return {
    position: node.position ?? null,
    rotation: node.rotation ?? null,
    scale: node.scale ?? null
  };
}

/** 归一化引用形态提取 UUID：写值（kind/assetUuid/objectUuid/serializedUuid）或 Dump（uuid/value.uuid）。 */
function readReferenceIdentity(value: unknown): string | string[] | null {
  if (Array.isArray(value)) return value.map((item) => readSingleReferenceUuid(item) ?? '');
  return readSingleReferenceUuid(value);
}

function readResultComponentStableLocator(operation: WriteOperation): {
  nodeStablePath: string;
  componentType: string;
  sameTypeIndex: number;
} | null {
  const enriched = operation as WriteOperation & {
    resultComponentNodeStablePath?: unknown;
    resultComponentType?: unknown;
    resultComponentSameTypeIndex?: unknown;
  };
  if (
    typeof enriched.resultComponentNodeStablePath !== 'string'
    || !enriched.resultComponentNodeStablePath
    || typeof enriched.resultComponentType !== 'string'
    || !enriched.resultComponentType
    || typeof enriched.resultComponentSameTypeIndex !== 'number'
    || !Number.isInteger(enriched.resultComponentSameTypeIndex)
    || enriched.resultComponentSameTypeIndex < 0
  ) return null;
  return {
    nodeStablePath: enriched.resultComponentNodeStablePath,
    componentType: enriched.resultComponentType,
    sameTypeIndex: enriched.resultComponentSameTypeIndex
  };
}

function readResultNodeStablePath(operation: WriteOperation): string | null {
  const stablePath = (operation as WriteOperation & { resultNodeStablePath?: unknown }).resultNodeStablePath;
  return typeof stablePath === 'string' && stablePath ? stablePath : null;
}

async function resolveNodeInfo(
  operation: WriteOperation,
  fallbackNodeUuid: string,
  dependencies: WriteVerifierDependencies
): Promise<Record<string, unknown> | null> {
  const byUuid = await dependencies.getNodeInfo(fallbackNodeUuid);
  if (byUuid) return byUuid;
  const stablePath = readResultNodeStablePath(operation);
  return stablePath && dependencies.getNodeInfoByStablePath
    ? dependencies.getNodeInfoByStablePath(stablePath)
    : null;
}

async function resolveComponentInfo(
  operation: WriteOperation,
  fallbackComponentUuid: string,
  dependencies: WriteVerifierDependencies
): Promise<Record<string, unknown> | null> {
  const byUuid = await dependencies.getComponentInfo(fallbackComponentUuid);
  if (byUuid) return byUuid;
  const stableLocator = readResultComponentStableLocator(operation);
  return stableLocator && dependencies.getComponentInfoByStableLocator
    ? dependencies.getComponentInfoByStableLocator(
        stableLocator.nodeStablePath,
        stableLocator.componentType,
        stableLocator.sameTypeIndex
      )
    : null;
}

async function resolvePrefabInstance(
  operation: WriteOperation,
  fallbackNodeUuid: string,
  dependencies: WriteVerifierDependencies
): Promise<{ nodeUuid: string; info: PrefabInstanceInfo } | null> {
  let nodeUuid = fallbackNodeUuid;
  let info = await dependencies.getPrefabInstanceInfo(nodeUuid);
  if (!info) {
    const stablePath = readResultNodeStablePath(operation);
    const stableNode = stablePath && dependencies.getNodeInfoByStablePath
      ? await dependencies.getNodeInfoByStablePath(stablePath)
      : null;
    if (typeof stableNode?.uuid !== 'string' || !stableNode.uuid) return null;
    nodeUuid = stableNode.uuid;
    info = await dependencies.getPrefabInstanceInfo(nodeUuid);
  }
  if (!info) return null;
  const expectedAssetUuid = readOptionalString(operation.resultPrefabAssetUuid);
  const expectedInstanceFileId = readOptionalString(operation.resultPrefabInstanceFileId);
  if (expectedAssetUuid && info.prefabAssetUuid !== expectedAssetUuid) return null;
  if (expectedInstanceFileId && info.instanceFileId !== expectedInstanceFileId) return null;
  return { nodeUuid, info };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function readResultAssetUuid(operation: WriteOperation): string | null {
  const resultAssetUuid = (operation as WriteOperation & { resultAssetUuid?: unknown }).resultAssetUuid;
  return typeof resultAssetUuid === 'string' && resultAssetUuid ? resultAssetUuid : null;
}

function readSingleReferenceUuid(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['subAssetUuid', 'assetUuid', 'objectUuid', 'serializedUuid', 'uuid']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  const nested = record.value;
  if (nested && typeof nested === 'object') {
    const nestedUuid = (nested as Record<string, unknown>).uuid;
    if (typeof nestedUuid === 'string' && nestedUuid) return nestedUuid;
  }
  return null;
}

function referenceIdentityIsResolved(value: string | string[] | null): boolean {
  return typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.every(Boolean);
}

function writeValueEqual(actual: unknown, expected: unknown): boolean {
  if (isReferenceValue(expected)) {
    const expectedUuid = readSingleReferenceUuid(expected);
    return expectedUuid !== null && expectedUuid === readSingleReferenceUuid(actual);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, index) => writeValueEqual(actual[index], item));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => (
      writeValueEqual((actual as Record<string, unknown>)[key], value)
    ));
  }
  return deepEqual(actual, expected);
}

function isReferenceValue(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && ['node', 'component', 'asset', 'missing'].includes(String((value as { kind?: unknown }).kind));
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
    ? value
    : null;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectationSummary(operation: WriteOperation): unknown {
  const { type, ...fields } = operation;
  return fields;
}

function describeOperation(operation: WriteOperation): string {
  switch (operation.type) {
    case 'node.create': return `创建节点 ${String(operation.name)}`;
    case 'node.delete': return `删除节点 ${String(operation.nodeUuid)}`;
    case 'node.rename': return `重命名节点为 ${String(operation.name)}`;
    case 'node.reparent': return `移动节点到 ${String(operation.newParentUuid)}`;
    case 'node.duplicate': return `复制节点 ${String(operation.nodeUuid)}`;
    case 'node.set_active': return `设置节点激活为 ${String(operation.active)}`;
    case 'node.set_layer': return `设置节点层级为 ${String(operation.layer)}`;
    case 'node.set_transform': return '设置节点局部变换';
    case 'component.add': return `挂载组件 ${String(operation.componentType)}`;
    case 'component.remove': return `移除组件 ${String(operation.componentUuid)}`;
    case 'component.enable': return `设置组件启用为 ${String(operation.enabled)}`;
    case 'component.set_property': return `设置属性 ${String(operation.propertyPath)}`;
    case 'component.set_reference': return `设置引用 ${String(operation.propertyPath)}`;
    case 'component.clear_reference': return `清空引用 ${String(operation.propertyPath)}`;
    case 'component.resize_array': return `调整数组 ${String(operation.propertyPath)} 长度为 ${String(operation.length)}`;
    case 'asset.create': return `创建资产 ${String(operation.assetUrl)}`;
    case 'asset.move': return `移动资产到 ${String(operation.targetUrl)}`;
    case 'asset.delete': return `删除资产 ${String(operation.assetUrl)}`;
    case 'asset.write_meta': return `写入资产元数据 ${String(operation.assetUrl)}`;
    case 'asset.update_text': return `安全更新文本资产 ${String(operation.assetUrl)}`;
    case 'asset.restore_content': return `恢复资产内容 ${String(operation.assetUrl)}`;
    case 'prefab.instantiate': return `实例化预制体 ${String(operation.prefabAssetUuid)}`;
    case 'prefab.create_from_node': return `从节点生成预制体 ${String(operation.assetUrl)}`;
    case 'prefab.instance_override': return `写入预制体实例覆盖 ${String(operation.propertyPath)}`;
    case 'prefab.revert_override': return `还原预制体覆盖 ${String(operation.instanceRootUuid)}`;
    case 'prefab.apply_to_source': return `应用覆盖到源 ${String(operation.instanceRootUuid)}`;
    case 'prefab.replace_source': return `替换预制体源 ${String(operation.instanceRootUuid)}`;
    case 'prefab.unlink_instance': return `解除预制体关联 ${String(operation.instanceRootUuid)}`;
    case 'prefab.link_instance': return `重新关联预制体 ${String(operation.nodeUuid)}`;
    case 'prefab.delete_asset': return `删除预制体资产 ${String(operation.assetUrl)}`;
    default: return String(operation.type);
  }
}
