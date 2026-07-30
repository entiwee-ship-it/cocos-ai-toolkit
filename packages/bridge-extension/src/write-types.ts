/**
 * 直写架构的共享写类型。事务管理器、回滚、Revision 前置已移除，
 * 写路径为：MCP/CLI → probe.directWrite → Scene writeExecute → 原子写 + 保存 + 逐项重读。
 */

/** 桥内写操作的最小结构，字段语义与协议包 WriteOperationSchema 保持一致。 */
export interface WriteOperation {
  type: string;
  [field: string]: unknown;
}

export interface WriteVerificationItem {
  operationIndex: number;
  description: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export interface WriteVerificationReport {
  passed: boolean;
  verifiedAt: string;
  items: WriteVerificationItem[];
}

export interface WriteConflict {
  scope: string;
  expected: unknown;
  actual: unknown;
}

export interface WriteFailure {
  code: string;
  message: string;
  operationIndex?: number | null;
  conflicts?: WriteConflict[];
  details?: unknown;
  stage?: 'plan' | 'prepare' | 'apply' | 'save' | 'verify' | 'unknown';
  inputSummary?: Record<string, unknown>;
  originalError?: { code: string; message?: string; details?: unknown };
  nextAction?: string;
}

/**
 * 写执行器的确定性结果。操作级失败以数据形式返回；
 * 抛出异常一律视为结局未知，不做任何乐观假设。
 * evidence 为逐操作执行证据，随响应带回供调用方核对。
 */
export type WriteExecutionOutcome =
  | { kind: 'success'; executedOps: number; verification: WriteVerificationReport | null; undoGroupId?: string | null; evidence?: unknown }
  | { kind: 'operation-failed'; executedOps: number; failure: WriteFailure; undoGroupId?: string | null; evidence?: unknown };
