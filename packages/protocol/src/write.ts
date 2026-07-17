import { z } from 'zod';
import { RevisionPreconditionSchema, TransactionStateSchema, WriteOperationSchema } from './transaction.js';

/**
 * 阶段二写事务请求。
 * scope 固定为 current-document；source-prefab、apply-to-source 属阶段三，
 * 在协议层直接拒绝，避免 Bridge 收到语义未定义的作用域。
 */
export const WriteTransactionRequestSchema = z.object({
  transactionId: z.string().min(1),
  // 幂等键：相同键重试必须返回原事务状态，不重复执行。
  idempotencyKey: z.string().min(1),
  scope: z.literal('current-document'),
  revision: RevisionPreconditionSchema,
  operations: z.array(WriteOperationSchema).min(1),
  save: z.boolean(),
  undoGroup: z.string().min(1)
});

/**
 * 重读验证的逐项明细。
 * 每个写操作对应至少一项，记录期望值与保存后重读到的实际值。
 */
export const WriteVerificationItemSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  description: z.string().min(1),
  expected: z.unknown(),
  actual: z.unknown(),
  passed: z.boolean()
});

/**
 * 保存后重读验证报告。任一项不通过则 passed 必须为 false。
 */
export const WriteVerificationReportSchema = z.object({
  passed: z.boolean(),
  verifiedAt: z.string().datetime(),
  items: z.array(WriteVerificationItemSchema)
});

/**
 * Revision 前置或 expectedOldValue 冲突的明细。
 * scope 标识冲突范围（document / hierarchy / 属性路径等），expected 与 actual 保留冲突双方取值。
 */
export const WriteConflictSchema = z.object({
  scope: z.string().min(1),
  expected: z.unknown(),
  actual: z.unknown()
});

/**
 * 写事务失败信息。operationIndex 为 null 表示失败发生在事务级（前置校验、保存等）而非某个操作。
 */
export const WriteFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  operationIndex: z.number().int().nonnegative().nullable().optional(),
  conflicts: z.array(WriteConflictSchema).optional(),
  details: z.unknown().optional()
});

/**
 * 回滚证据。verifiedClean 表示回滚后重读验证是否确认干净，是回滚收口的核心依据。
 */
export const WriteRollbackEvidenceSchema = z.object({
  attempted: z.boolean(),
  succeeded: z.boolean().nullable(),
  undoGroupId: z.string().min(1).nullable().optional(),
  verifiedClean: z.boolean().nullable()
});

/**
 * 写事务结果。
 * 不变式：status 为 committed 时 verification 必须存在且 passed 为 true，
 * 防止"未重读验证就宣称提交成功"的假阳性结果流出 Bridge。
 */
export const WriteTransactionResultSchema = z.object({
  transactionId: z.string().min(1),
  status: TransactionStateSchema,
  // 幂等重试命中时标记原始事务 id，调用方据此识别本次为重复请求。
  duplicateOf: z.string().min(1).optional(),
  executedOps: z.number().int().nonnegative(),
  verification: WriteVerificationReportSchema.nullable(),
  failure: WriteFailureSchema.nullable(),
  rollbackEvidence: WriteRollbackEvidenceSchema.nullable()
}).superRefine((result, context) => {
  if (result.status === 'committed' && (!result.verification || !result.verification.passed)) {
    context.addIssue({
      code: 'custom',
      message: 'committed 状态必须携带 passed 为 true 的重读验证报告'
    });
  }
});

export type WriteTransactionRequest = z.infer<typeof WriteTransactionRequestSchema>;
export type WriteVerificationItem = z.infer<typeof WriteVerificationItemSchema>;
export type WriteVerificationReport = z.infer<typeof WriteVerificationReportSchema>;
export type WriteConflict = z.infer<typeof WriteConflictSchema>;
export type WriteFailure = z.infer<typeof WriteFailureSchema>;
export type WriteRollbackEvidence = z.infer<typeof WriteRollbackEvidenceSchema>;
export type WriteTransactionResult = z.infer<typeof WriteTransactionResultSchema>;
