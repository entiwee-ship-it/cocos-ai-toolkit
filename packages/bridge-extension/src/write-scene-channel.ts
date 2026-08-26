import { ProbeError } from './probe-errors';
import type { ComponentWriteOpResult } from './component-writer';
import type { NodeWriteOpResult } from './node-writer';
import type { PrefabWriteOpResult } from './prefab-writer';
import type {
  WriteExecutionOutcome,
  WriteOperation,
  WriteVerificationReport
} from './write-types';
import type { VerifiedOperation } from './write-verifier';

/**
 * Scene 写通道依赖。节点/组件/预制体原子写分别来自 node-writer、component-writer 和 prefab-writer，
 * 保存、重开和重读验证由 scene.ts 接到 Creator 真实能力。
 */
export interface WriteSceneChannelDependencies {
  executeNodeOperation(operation: WriteOperation): Promise<NodeWriteOpResult>;
  executeComponentOperation(operation: WriteOperation): Promise<ComponentWriteOpResult>;
  executePrefabOperation(operation: WriteOperation): Promise<PrefabWriteOpResult>;
  saveDocument(): Promise<void>;
  reloadDocument(): Promise<void>;
  verify(executed: VerifiedOperation[]): Promise<WriteVerificationReport>;
}

export type WriteSceneExecutionOutcome = WriteExecutionOutcome & {
  evidence?: VerifiedOperation[];
};

/**
 * 在事务上下文内按序执行混合写操作，并保留逐操作证据（含逆操作）。
 * 失败即停：返回 operation-failed，已执行操作的证据照常带回，供回滚编排。
 *
 * @param input 写操作序列和保存开关。
 * @param dependencies Scene 侧写通道依赖。
 * @returns 执行器契约结果 + 证据。
 */
export async function executeWriteSceneOperations(
  input: { operations: WriteOperation[]; save: boolean },
  dependencies: WriteSceneChannelDependencies
): Promise<WriteSceneExecutionOutcome> {
  const executed: VerifiedOperation[] = [];
  for (let index = 0; index < input.operations.length; index += 1) {
    const operation = input.operations[index];
    try {
      const result = operation.type.startsWith('node.')
        ? await dependencies.executeNodeOperation(operation)
        : operation.type.startsWith('prefab.') || operation.type.startsWith('asset.')
          ? await dependencies.executePrefabOperation(operation)
          : await dependencies.executeComponentOperation(operation);
      // 回填执行结果产生的目标 UUID，重读验证据此定位新建节点/组件；
      // create_from_node 等操作会重建节点（UUID 变更），必须以结果 UUID 覆盖原操作值。
      const resultNodeUuid = 'nodeUuid' in result ? result.nodeUuid : null;
      const resultComponentUuid = 'componentUuid' in result ? result.componentUuid : null;
      const resultAssetUuid = 'assetUuid' in result ? result.assetUuid : null;
      const resultTargetLocalIds = 'targetLocalIds' in result ? result.targetLocalIds : null;
      const resultAfter = result.after && typeof result.after === 'object' && !Array.isArray(result.after)
        ? result.after as Record<string, unknown>
        : null;
      const resultBefore = result.before && typeof result.before === 'object' && !Array.isArray(result.before)
        ? result.before as Record<string, unknown>
        : null;
      const stableResult = resultAfter ?? resultBefore;
      const resultNodeStablePath = typeof stableResult?.stablePath === 'string' && stableResult.stablePath
        ? stableResult.stablePath
        : null;
      const resultComponentNodeStablePath = typeof stableResult?.nodeStablePath === 'string'
        && stableResult.nodeStablePath
        ? stableResult.nodeStablePath
        : null;
      const resultComponentType = typeof stableResult?.type === 'string' && stableResult.type
        ? stableResult.type
        : null;
      const resultComponentSameTypeIndex = typeof stableResult?.sameTypeIndex === 'number'
        && Number.isInteger(stableResult.sameTypeIndex)
        && stableResult.sameTypeIndex >= 0
        ? stableResult.sameTypeIndex
        : null;
      const resultTargetSha256 = typeof resultAfter?.sha256 === 'string' && resultAfter.sha256
        ? resultAfter.sha256
        : null;
      const resultPrefabAssetUuid = typeof stableResult?.prefabAssetUuid === 'string' && stableResult.prefabAssetUuid
        ? stableResult.prefabAssetUuid
        : null;
      const resultPrefabInstanceFileId = typeof stableResult?.instanceFileId === 'string' && stableResult.instanceFileId
        ? stableResult.instanceFileId
        : null;
      const resultPreviousOverride = 'previousOverride' in result ? result.previousOverride : undefined;
      const resultHadPreviousOverride = resultPreviousOverride === undefined
        ? null
        : resultPreviousOverride !== null;
      const enrichedOperation = {
        ...operation,
        ...(resultNodeUuid ? { resultNodeUuid } : {}),
        ...(resultNodeStablePath ? { resultNodeStablePath } : {}),
        ...(resultComponentUuid ? { resultComponentUuid } : {}),
        ...(resultComponentNodeStablePath ? { resultComponentNodeStablePath } : {}),
        ...(resultComponentType ? { resultComponentType } : {}),
        ...(resultComponentSameTypeIndex === null ? {} : { resultComponentSameTypeIndex }),
        ...(resultAssetUuid ? { resultAssetUuid } : {}),
        ...(resultTargetSha256 ? { resultTargetSha256 } : {}),
        ...(resultTargetLocalIds ? { resultTargetLocalIds } : {}),
        ...(resultPrefabAssetUuid ? { resultPrefabAssetUuid } : {}),
        ...(resultPrefabInstanceFileId ? { resultPrefabInstanceFileId } : {}),
        ...(resultHadPreviousOverride === null ? {} : { resultHadPreviousOverride }),
        ...(resultPreviousOverride && 'value' in resultPreviousOverride
          ? { resultPreviousOverrideValue: resultPreviousOverride.value }
          : {})
      };
      executed.push({ operation: enrichedOperation, ...result } as VerifiedOperation);
    } catch (error) {
      const probeError = error instanceof ProbeError
        ? error
        : new ProbeError(error instanceof Error ? error.message : 'WRITE_OPERATION_FAILED');
      return {
        kind: 'operation-failed',
        executedOps: executed.length,
        failure: {
          code: probeError.code,
          message: probeError.code,
          operationIndex: index,
          details: probeError.details
        },
        evidence: executed
      };
    }
  }

  // 保存、软重载与重读由 verifier 统一执行。异常时写入可能已经落地，必须保留证据并禁止乐观重试。
  let verification: WriteVerificationReport;
  try {
    verification = await dependencies.verify(executed);
  } catch (error) {
    const original = error instanceof ProbeError
      ? { code: error.code, message: error.message, details: error.details }
      : {
          code: 'WRITE_VERIFICATION_FAILED',
          message: error instanceof Error ? error.message : 'WRITE_VERIFICATION_FAILED'
        };
    return {
      kind: 'unknown',
      executedOps: executed.length,
      failure: {
        code: 'DIRECT_WRITE_VERIFICATION_UNKNOWN',
        message: 'DIRECT_WRITE_VERIFICATION_UNKNOWN',
        operationIndex: null,
        stage: 'unknown',
        originalError: original,
        nextAction: '写入可能已生效；先重读当前文档状态，确认前不要重试。'
      },
      evidence: executed
    };
  }
  return {
    kind: 'success',
    executedOps: executed.length,
    verification,
    evidence: executed
  };
}

/**
 * 沿属性路径段读取 Creator Dump 包装结构中的值。
 * Dump 属性为 { name/type/value } 包装；数组元素同样逐个包装。
 *
 * @param dump query-node/query-component 返回的 Dump。
 * @param segments parsePropertyPath 解析出的段序列。
 * @returns 解包后的当前值。
 */
export function readDumpValueAtPath(dump: unknown, segments: Array<string | number>): unknown {
  let current = dump;
  for (const segment of segments) {
    const unwrapped = unwrapDumpValue(current);
    if (unwrapped === null || unwrapped === undefined) return unwrapped;
    current = (unwrapped as Record<string | number, unknown>)[segment];
  }
  return unwrapDumpValueDeep(current);
}

/**
 * 沿属性路径段写入 Dump 值并返回新 Dump（不可变更新，原对象保持不变）。
 * 写值时保留 Dump 包装结构，只替换 value 字段。
 *
 * @param dump 原始 Dump。
 * @param segments parsePropertyPath 解析出的段序列。
 * @param value 待写入的值。
 * @returns 写入后的新 Dump。
 */
export function writeDumpValueAtPath(
  dump: unknown,
  segments: Array<string | number>,
  value: unknown
): unknown {
  const writeAt = (current: unknown, rest: Array<string | number>): unknown => {
    if (rest.length === 0) {
      // 写值时保留 Dump 包装结构，只替换 value 字段。
      return isWrappedDump(current)
        ? { ...(current as Record<string, unknown>), value }
        : value;
    }
    const [segment, ...tail] = rest;
    const unwrapped = unwrapDumpValue(current);
    if (Array.isArray(unwrapped) && typeof segment === 'number') {
      const next = unwrapped.slice();
      next[segment] = writeAt(next[segment], tail);
      return isWrappedDump(current)
        ? { ...(current as Record<string, unknown>), value: next }
        : next;
    }
    const object = { ...(unwrapped as Record<string, unknown>) };
    object[segment] = writeAt(object[segment], tail);
    return isWrappedDump(current)
      ? { ...(current as Record<string, unknown>), value: object }
      : object;
  };
  return writeAt(dump, segments);
}

/** 判断是否为 { name/type/value } 形式的 Dump 包装；Vec3/Quat 这类纯值对象不算。 */
function isWrappedDump(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.includes('value') && (keys.includes('type') || keys.includes('name'));
}

function unwrapDumpValue(value: unknown): unknown {
  return isWrappedDump(value) ? (value as Record<string, unknown>).value : value;
}

function unwrapDumpValueDeep(value: unknown): unknown {
  const unwrapped = unwrapDumpValue(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(unwrapDumpValueDeep);
  if (!unwrapped || typeof unwrapped !== 'object') return unwrapped;
  return Object.fromEntries(
    Object.entries(unwrapped as Record<string, unknown>)
      .map(([key, item]) => [key, unwrapDumpValueDeep(item)])
  );
}
