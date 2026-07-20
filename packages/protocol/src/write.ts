import { z } from 'zod';
import { RevisionPreconditionSchema, TransactionStateSchema, WriteOperationSchema } from './transaction.js';

/**
 * 写事务作用域。
 * current-document：只写当前打开文档（阶段二行为）；
 * source-prefab：直接写源预制体资产；apply-to-source：把实例覆盖应用到源。
 * 后两者影响面跨文档，必须携带影响分析（设计规格 8.4）。
 */
export const WriteScopeSchema = z.enum(['current-document', 'source-prefab', 'apply-to-source']);

/** Creator 当前写文档身份与五维 revision 快照。 */
export const WriteRevisionSnapshotSchema = z.object({
  documentId: z.string().min(1),
  revision: RevisionPreconditionSchema
});

/** 影响分析中单个受影响文档（Scene 或 Prefab）。 */
export const PrefabImpactAffectedDocumentSchema = z.object({
  assetUuid: z.string().min(1),
  path: z.string().min(1),
  documentType: z.enum(['scene', 'prefab']),
  instanceCount: z.number().int().nonnegative()
});

/**
 * 源预制体影响分析报告：修改哪个资产、受影响文档与实例数、覆盖层标注、风险列表。
 * source-prefab / apply-to-source 事务必须在 Bridge 执行前生成并随请求携带。
 */
export const PrefabImpactAnalysisSchema = z.object({
  sourceAssetUuid: z.string().min(1),
  sourceAssetPath: z.string().min(1),
  affectedDocuments: z.array(PrefabImpactAffectedDocumentSchema),
  totalInstanceCount: z.number().int().nonnegative(),
  overrideLayers: z.array(z.string()),
  risks: z.array(z.string())
});

/**
 * 阶段三写事务请求。
 * scope 三值；source-prefab、apply-to-source 必须携带影响分析（协议层门禁，
 * Bridge 执行前再做一次双保险）；含 prefab.apply_to_source 操作时 revision.prefabGraph 必填。
 */
export const WriteTransactionRequestSchema = z.object({
  transactionId: z.string().min(1),
  // 幂等键：相同键重试必须返回原事务状态，不重复执行。
  idempotencyKey: z.string().min(1),
  scope: WriteScopeSchema,
  revision: RevisionPreconditionSchema,
  impactAnalysis: PrefabImpactAnalysisSchema.optional(),
  operations: z.array(WriteOperationSchema).min(1),
  save: z.boolean(),
  undoGroup: z.string().min(1)
}).superRefine((request, context) => {
  if ((request.scope === 'source-prefab' || request.scope === 'apply-to-source') && !request.impactAnalysis) {
    context.addIssue({
      code: 'custom',
      message: 'source-prefab / apply-to-source 作用域必须携带影响分析（impactAnalysis）'
    });
  }
  const needsPrefabGraph = request.operations.some((operation) => operation.type === 'prefab.apply_to_source');
  if (needsPrefabGraph && request.scope !== 'apply-to-source') {
    context.addIssue({
      code: 'custom',
      message: 'prefab.apply_to_source 操作只能使用 apply-to-source 作用域'
    });
  }
  if (needsPrefabGraph && !request.revision.prefabGraph) {
    context.addIssue({
      code: 'custom',
      message: 'prefab.apply_to_source 操作要求 revision.prefabGraph 前置指纹'
    });
  }
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
export type WriteScope = z.infer<typeof WriteScopeSchema>;
export type WriteRevisionSnapshot = z.infer<typeof WriteRevisionSnapshotSchema>;
export type PrefabImpactAffectedDocument = z.infer<typeof PrefabImpactAffectedDocumentSchema>;
export type PrefabImpactAnalysis = z.infer<typeof PrefabImpactAnalysisSchema>;
export type WriteVerificationItem = z.infer<typeof WriteVerificationItemSchema>;
export type WriteVerificationReport = z.infer<typeof WriteVerificationReportSchema>;
export type WriteConflict = z.infer<typeof WriteConflictSchema>;
export type WriteFailure = z.infer<typeof WriteFailureSchema>;
export type WriteRollbackEvidence = z.infer<typeof WriteRollbackEvidenceSchema>;
export type WriteTransactionResult = z.infer<typeof WriteTransactionResultSchema>;
