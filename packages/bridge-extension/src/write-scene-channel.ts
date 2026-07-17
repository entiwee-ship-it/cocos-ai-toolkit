import { ProbeError } from './probe-errors';
import type { ComponentWriteOpResult } from './component-writer';
import type { NodeWriteOpResult } from './node-writer';
import type {
  WriteExecutionOutcome,
  WriteOperation,
  WriteVerificationReport
} from './transaction-manager';
import type { VerifiedOperation } from './write-verifier';

/**
 * Scene 写通道依赖。节点/组件原子写分别来自 node-writer 和 component-writer，
 * 保存、重开和重读验证由 scene.ts 接到 Creator 真实能力。
 */
export interface WriteSceneChannelDependencies {
  executeNodeOperation(operation: WriteOperation): Promise<NodeWriteOpResult>;
  executeComponentOperation(operation: WriteOperation): Promise<ComponentWriteOpResult>;
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
 * @param input 写操作序列、保存开关和 Undo 组名。
 * @param dependencies Scene 侧写通道依赖。
 * @returns 执行器契约结果 + 证据。
 */
export async function executeWriteSceneOperations(
  input: { operations: WriteOperation[]; save: boolean; undoGroup: string },
  dependencies: WriteSceneChannelDependencies
): Promise<WriteSceneExecutionOutcome> {
  const executed: VerifiedOperation[] = [];
  for (let index = 0; index < input.operations.length; index += 1) {
    const operation = input.operations[index];
    try {
      const result = operation.type.startsWith('node.')
        ? await dependencies.executeNodeOperation(operation)
        : await dependencies.executeComponentOperation(operation);
      executed.push({ operation, ...result } as VerifiedOperation);
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

  if (input.save) {
    await dependencies.saveDocument();
    await dependencies.reloadDocument();
  }
  const verification = await dependencies.verify(executed);
  return {
    kind: 'success',
    executedOps: executed.length,
    verification,
    evidence: executed
  };
}

/**
 * 按逆序应用已执行操作的逆操作（step-undo-with-inverse 回滚路径）。
 * 任一逆操作失败即停并报告失败位置，由事务管理器转入 manual-recovery-required。
 *
 * @param executed 已执行操作及其证据。
 * @param dependencies Scene 侧写通道依赖。
 * @returns 是否全部逆操作成功，以及失败位置（成功时为 null）。
 */
export async function rollbackWriteSceneOperations(
  executed: VerifiedOperation[],
  dependencies: WriteSceneChannelDependencies
): Promise<{ succeeded: boolean; failedAt: number | null }> {
  for (let index = executed.length - 1; index >= 0; index -= 1) {
    for (const inverse of executed[index].inverse) {
      try {
        if (inverse.type.startsWith('node.')) {
          await dependencies.executeNodeOperation(inverse);
        } else {
          await dependencies.executeComponentOperation(inverse);
        }
      } catch {
        return { succeeded: false, failedAt: index };
      }
    }
  }
  return { succeeded: true, failedAt: null };
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
  return unwrapDumpValue(current);
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
