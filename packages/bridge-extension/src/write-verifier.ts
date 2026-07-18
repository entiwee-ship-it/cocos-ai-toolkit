import { deepEqual } from './component-writer';
import type { ComponentWriteOpResult } from './component-writer';
import type { NodeWriteOpResult } from './node-writer';
import type { PrefabWriteOpResult } from './prefab-writer';
import type {
  WriteOperation,
  WriteTransactionRequest,
  WriteVerificationItem,
  WriteVerificationReport
} from './transaction-manager';

import type { PrefabAssetInfo, PrefabInstanceInfo } from './prefab-writer';

/** 已执行完成、等待重读验证的写操作（原始操作 + 执行证据）。 */
export type VerifiedOperation = (NodeWriteOpResult | ComponentWriteOpResult | PrefabWriteOpResult) & {
  operation: WriteOperation;
};

/**
 * 重读验证依赖。saveDocument/reloadDocument 复用 Creator 保存与关闭重开（或等价刷新），
 * 读取依赖复用 Phase 1 文档快照链路（Scene query-node/query-component）。
 */
export interface WriteVerifierDependencies {
  saveDocument(): Promise<void>;
  reloadDocument(): Promise<void>;
  getNodeInfo(nodeUuid: string): Promise<Record<string, unknown> | null>;
  getComponentInfo(componentUuid: string): Promise<Record<string, unknown> | null>;
  getComponentProperty(componentUuid: string, propertyPath: string): Promise<unknown>;
  getPrefabInstanceInfo(nodeUuid: string): Promise<PrefabInstanceInfo | null>;
  queryAssetInfo(uuidOrUrl: string): Promise<PrefabAssetInfo | null>;
}

/**
 * 保存并按计划期望值逐项重读验证。save=true 时先保存文档、关闭重开（或等价刷新）再重读；
 * 任一项不符 passed 即为 false，由事务管理器转入失败回滚流程。
 *
 * @param request 原始写事务请求。
 * @param executed 已执行的写操作及其证据。
 * @param dependencies 保存与重读依赖。
 * @returns 重读验证报告，进入事务审计。
 */
export async function saveAndVerifyWriteTransaction(
  request: WriteTransactionRequest,
  executed: VerifiedOperation[],
  dependencies: WriteVerifierDependencies
): Promise<WriteVerificationReport> {
  if (request.save) {
    await dependencies.saveDocument();
    await dependencies.reloadDocument();
  }

  const items: WriteVerificationItem[] = [];
  for (let index = 0; index < executed.length; index += 1) {
    items.push(await verifyOperation(index, executed[index].operation, dependencies));
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
      const actual = nodeUuid ? await dependencies.getNodeInfo(nodeUuid) : null;
      return build('节点存在', actual === null ? null : '节点存在', actual !== null);
    }
    case 'node.delete': {
      const actual = await dependencies.getNodeInfo(operation.nodeUuid as string);
      return build('节点不存在', actual === null ? '节点不存在' : '节点仍存在', actual === null);
    }
    case 'node.rename': {
      const actual = await dependencies.getNodeInfo(operation.nodeUuid as string);
      const actualName = actual?.name ?? null;
      return build(operation.name, actualName, actualName === operation.name);
    }
    case 'node.reparent': {
      const actual = await dependencies.getNodeInfo(operation.nodeUuid as string);
      const actualParent = actual?.parentUuid ?? null;
      return build(operation.newParentUuid, actualParent, actualParent === operation.newParentUuid);
    }
    case 'node.set_active': {
      const actual = await dependencies.getNodeInfo(operation.nodeUuid as string);
      const actualActive = actual?.active ?? null;
      return build(operation.active, actualActive, actualActive === operation.active);
    }
    case 'node.set_layer': {
      const actual = await dependencies.getNodeInfo(operation.nodeUuid as string);
      const actualLayer = actual?.layer ?? null;
      return build(operation.layer, actualLayer, actualLayer === operation.layer);
    }
    case 'node.set_transform': {
      const actual = await dependencies.getNodeInfo(operation.nodeUuid as string);
      const transform = operation.localTransform as Record<string, unknown>;
      const mismatches = Object.entries(transform).filter(
        ([field, value]) => !deepEqual(actual?.[field], value)
      );
      return build(transform, pickTransform(actual), mismatches.length === 0);
    }
    case 'component.add': {
      const componentUuid = readResultComponentUuid(operation);
      const actual = componentUuid ? await dependencies.getComponentInfo(componentUuid) : null;
      return build('组件存在', actual === null ? null : '组件存在', actual !== null);
    }
    case 'component.remove': {
      const actual = await dependencies.getComponentInfo(operation.componentUuid as string);
      return build('组件不存在', actual === null ? '组件不存在' : '组件仍存在', actual === null);
    }
    case 'component.enable': {
      const actual = await dependencies.getComponentInfo(operation.componentUuid as string);
      const actualEnabled = actual?.enabled ?? null;
      return build(operation.enabled, actualEnabled, actualEnabled === operation.enabled);
    }
    case 'component.set_property': {
      const actual = await dependencies.getComponentProperty(
        operation.componentUuid as string,
        operation.propertyPath as string
      );
      return build(operation.value, actual, deepEqual(actual, operation.value));
    }
    case 'component.set_reference': {
      const actual = await dependencies.getComponentProperty(
        operation.componentUuid as string,
        operation.propertyPath as string
      );
      // 引用按归一化 UUID 比对：写值为 ReferenceSchema，重读为 Dump {uuid} 形态。
      const expectedUuid = readReferenceUuid(operation.reference);
      const actualUuid = readReferenceUuid(actual);
      return build(expectedUuid, actualUuid, expectedUuid !== null && expectedUuid === actualUuid);
    }
    case 'component.clear_reference': {
      const actual = await dependencies.getComponentProperty(
        operation.componentUuid as string,
        operation.propertyPath as string
      );
      // Dump 形态的空引用为 {uuid:''}：按归一化 UUID 为空判定已清空。
      const cleared = actual === null || actual === undefined || readReferenceUuid(actual) === null;
      return build(null, actual ?? null, cleared);
    }
    case 'component.resize_array': {
      const actual = await dependencies.getComponentProperty(
        operation.componentUuid as string,
        operation.propertyPath as string
      );
      const actualLength = Array.isArray(actual) ? actual.length : null;
      return build(operation.length, actualLength, actualLength === operation.length);
    }
    case 'prefab.instantiate': {
      const nodeUuid = readResultNodeUuid(operation);
      const actual = nodeUuid ? await dependencies.getPrefabInstanceInfo(nodeUuid) : null;
      const matched = actual !== null
        && actual.prefabAssetUuid === operation.prefabAssetUuid
        && actual.instanceFileId !== null;
      return build('实例已建立且源资产一致', actual, matched);
    }
    case 'prefab.create_from_node': {
      const actual = await dependencies.getPrefabInstanceInfo(operation.nodeUuid as string);
      const linked = actual !== null && actual.prefabAssetUuid !== null;
      return build('节点已关联预制体资产', actual?.prefabAssetUuid ?? null, linked);
    }
    case 'prefab.delete_asset': {
      const actual = await dependencies.queryAssetInfo(operation.assetUrl as string);
      return build('资产不存在', actual === null ? '资产不存在' : '资产仍存在', actual === null);
    }
    case 'prefab.revert_override': {
      const actual = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid as string);
      if (!actual) return build('实例存在', null, false);
      if (operation.propertyPath) {
        const remaining = actual.overridePaths.includes(operation.propertyPath as string);
        return build(`覆盖路径 ${String(operation.propertyPath)} 已还原`, actual.overridePaths, !remaining);
      }
      // 整实例还原：除根节点名（_name 与资产名绑定，实测为特例）外不应有残留覆盖。
      const remaining = actual.overridePaths.filter((path) => path !== '_name');
      return build('覆盖已全部还原', actual.overridePaths, remaining.length === 0);
    }
    case 'prefab.apply_to_source': {
      // 设计规格 8.4：应用到源后必须验证实例关系未损坏（仍为同一源资产的完整实例）。
      const actual = await dependencies.getPrefabInstanceInfo(operation.instanceRootUuid as string);
      const intact = actual !== null && actual.prefabAssetUuid !== null && actual.instanceFileId !== null;
      return build('实例关系未损坏', actual ? { prefabAssetUuid: actual.prefabAssetUuid, instanceFileId: actual.instanceFileId } : null, intact);
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
function readReferenceUuid(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['assetUuid', 'objectUuid', 'serializedUuid', 'uuid']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  const nested = record.value;
  if (nested && typeof nested === 'object') {
    const nestedUuid = (nested as Record<string, unknown>).uuid;
    if (typeof nestedUuid === 'string' && nestedUuid) return nestedUuid;
  }
  return null;
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
    case 'prefab.instantiate': return `实例化预制体 ${String(operation.prefabAssetUuid)}`;
    case 'prefab.create_from_node': return `从节点生成预制体 ${String(operation.assetUrl)}`;
    case 'prefab.revert_override': return `还原预制体覆盖 ${String(operation.instanceRootUuid)}`;
    case 'prefab.apply_to_source': return `应用覆盖到源 ${String(operation.instanceRootUuid)}`;
    case 'prefab.replace_source': return `替换预制体源 ${String(operation.instanceRootUuid)}`;
    case 'prefab.unlink_instance': return `解除预制体关联 ${String(operation.instanceRootUuid)}`;
    case 'prefab.link_instance': return `重新关联预制体 ${String(operation.nodeUuid)}`;
    case 'prefab.delete_asset': return `删除预制体资产 ${String(operation.assetUrl)}`;
    default: return String(operation.type);
  }
}
