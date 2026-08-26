import { z } from 'zod';
import { WriteOperationSchema } from './write-operations.js';

/**
 * 重读验证的逐项明细。
 * 每个写操作对应至少一项，记录期望值与保存后重读到的实际值。
 * expected/actual 显式 optional：重读失败时对应侧可能缺省（Zod 4 的 z.unknown() 默认非可选，
 * 缺省会导致整个写结果无法通过协议校验，把真实失败掩盖为解析错误）。
 */
export const WriteVerificationItemSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  description: z.string().min(1),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
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
 * 属性值冲突的明细（expectedOldValue 乐观锁等场景）。
 * scope 标识冲突范围，expected 与 actual 保留冲突双方取值（显式 optional）。
 */
export const WriteConflictSchema = z.object({
  scope: z.string().min(1),
  expected: z.unknown().optional(),
  actual: z.unknown().optional()
});

/**
 * 直写失败信息。operationIndex 为 null 表示失败发生在操作序列之外（保存等）。
 */
export const WriteFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  operationIndex: z.number().int().nonnegative().nullable().optional(),
  conflicts: z.array(WriteConflictSchema).optional(),
  details: z.unknown().optional(),
  stage: z.enum(['plan', 'apply', 'save', 'verify', 'unknown']).optional(),
  inputSummary: z.record(z.string(), z.unknown()).optional(),
  originalError: z.object({
    code: z.string().min(1),
    message: z.string().min(1).optional(),
    details: z.unknown().optional()
  }).optional(),
  nextAction: z.string().min(1).optional()
});

/**
 * 直写请求（probe.directWrite 载荷）：一批原子写操作和保存开关。
 * 无事务身份、幂等键和 Revision 前置；失败即停，已执行操作保留在文档中。
 */
export const DirectWriteRequestSchema = z.object({
  operations: z.array(WriteOperationSchema).min(1),
  save: z.boolean()
});

/**
 * 直写执行结果（probe.directWrite 响应）。
 * kind 为 success 时 verification 必须存在且 passed 为 true 才算写入生效；
 * operation-failed 时 failure 指明失败操作位置；unknown 表示操作已执行但保存或验证结局无法确认。
 */
export const DirectWriteOutcomeSchema = z.object({
  kind: z.enum(['success', 'operation-failed', 'unknown']),
  executedOps: z.number().int().nonnegative(),
  verification: WriteVerificationReportSchema.nullable().optional(),
  failure: WriteFailureSchema.optional(),
  evidence: z.unknown().optional()
});

export type WriteVerificationItem = z.infer<typeof WriteVerificationItemSchema>;
export type WriteVerificationReport = z.infer<typeof WriteVerificationReportSchema>;
export type WriteConflict = z.infer<typeof WriteConflictSchema>;
export type WriteFailure = z.infer<typeof WriteFailureSchema>;
export type DirectWriteRequest = z.infer<typeof DirectWriteRequestSchema>;
export type DirectWriteOutcome = z.infer<typeof DirectWriteOutcomeSchema>;
