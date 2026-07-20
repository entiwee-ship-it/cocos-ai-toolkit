import { z } from 'zod';
import { ReferenceSchema } from './reference.js';
import { PrefabImpactAnalysisSchema } from './write.js';

/**
 * 声明式构建目标文档与计划协议（阶段四）。
 * AI 用临时逻辑 ID 描述目标状态，系统对比当前状态生成最小差异并按依赖执行。
 */

/** 临时逻辑 ID：`$` 前缀，供目标文档内部引用接线。 */
export const DesignLogicalIdSchema = z.string().regex(/^\$[A-Za-z][\w-]*$/, '逻辑 ID 必须以 $ 开头');

/** 引用值：逻辑 ID 引用（执行期物化回填）或既有资产/节点引用。 */
export const DesignReferenceValueSchema = z.union([
  DesignLogicalIdSchema,
  ReferenceSchema
]);

/** 目标组件声明：类型、可选脚本 UUID、属性与引用。 */
export const DesignTargetComponentSchema = z.object({
  type: z.string().min(1),
  scriptUuid: z.string().min(1).nullable().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  references: z.record(z.string(), DesignReferenceValueSchema).optional()
});

/** 目标预制体实例声明。 */
export const DesignPrefabInstanceSchema = z.object({
  assetUuid: z.string().min(1),
  name: z.string().min(1).optional()
});

export interface DesignTargetNodeInput {
  id: string;
  fileId?: string;
  path?: string;
  name?: string;
  prefabInstance?: z.infer<typeof DesignPrefabInstanceSchema>;
  components?: Array<z.infer<typeof DesignTargetComponentSchema>>;
  references?: Record<string, z.infer<typeof DesignReferenceValueSchema>>;
  children?: DesignTargetNodeInput[];
  match?: 'fileId' | 'name-path';
}

/** 目标节点（递归）：逻辑 ID、名称、组件、引用、子节点与匹配策略提示。 */
export const DesignTargetNodeSchema: z.ZodType<DesignTargetNodeInput> = z.lazy(() =>
  z.object({
    id: DesignLogicalIdSchema,
    fileId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    prefabInstance: DesignPrefabInstanceSchema.optional(),
    components: z.array(DesignTargetComponentSchema).optional(),
    references: z.record(z.string(), DesignReferenceValueSchema).optional(),
    children: z.array(DesignTargetNodeSchema).optional(),
    match: z.enum(['fileId', 'name-path']).optional()
  })
);

/** 目标文档：scope、目标树与可选 prune（显式允许删除多余节点/组件）。 */
export const DesignTargetDocumentSchema = z.object({
  document: z.object({
    scope: z.enum(['current-document', 'source-prefab', 'apply-to-source']).default('current-document'),
    assetUuid: z.string().min(1).optional()
  }),
  tree: z.array(DesignTargetNodeSchema),
  prune: z.boolean().optional()
}).superRefine((target, context) => {
  // 逻辑 ID 全文唯一、自引用拒绝、悬空引用拒绝（引用必须指向文档内已声明的 ID）。
  const ids = new Set<string>();
  const referencedIds = new Set<string>();
  const collectIds = (nodes: DesignTargetNodeInput[]): void => {
    for (const node of nodes) {
      if (ids.has(node.id)) {
        context.addIssue({ code: 'custom', message: `逻辑 ID 重复: ${node.id}` });
      }
      ids.add(node.id);
      if (node.references) {
        for (const value of Object.values(node.references)) {
          if (typeof value === 'string' && value === node.id) {
            context.addIssue({ code: 'custom', message: `逻辑 ID 自引用: ${node.id}` });
          }
          if (typeof value === 'string' && value.startsWith('$')) {
            referencedIds.add(value);
          }
        }
      }
      for (const component of node.components ?? []) {
        for (const value of Object.values(component.references ?? {})) {
          if (typeof value === 'string' && value === node.id) {
            context.addIssue({ code: 'custom', message: `逻辑 ID 自引用: ${node.id}` });
          }
          if (typeof value === 'string' && value.startsWith('$')) {
            referencedIds.add(value);
          }
        }
      }
      collectIds(node.children ?? []);
    }
  };
  collectIds(target.tree);
  for (const referencedId of referencedIds) {
    if (!ids.has(referencedId)) {
      context.addIssue({ code: 'custom', message: `引用指向不存在的逻辑 ID: ${referencedId}` });
    }
  }
});

/** 计划项：映射原子操作的人类可读形态，含 Override 标注与依赖。 */
export const DesignPlanItemSchema = z.object({
  kind: z.string().min(1),
  target: z.string().min(1),
  propertyPath: z.string().min(1).optional(),
  value: z.unknown().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  producesOverride: z.boolean().optional(),
  overrideLayer: z.string().optional(),
  dependsOn: z.array(z.string()).optional()
});

/** 声明式计划：有序计划项、影响分析、风险与不可表达差异。 */
export const DesignPlanSchema = z.object({
  items: z.array(DesignPlanItemSchema),
  impactAnalysis: PrefabImpactAnalysisSchema.optional(),
  risks: z.array(z.string()),
  unresolved: z.array(z.object({
    path: z.string().min(1),
    reason: z.string().min(1)
  }))
});

/** 逐项验证报告（design_verify）。 */
export const DesignVerifyReportSchema = z.object({
  passed: z.boolean(),
  verifiedAt: z.string().datetime(),
  items: z.array(z.object({
    target: z.string().min(1),
    description: z.string().min(1),
    expected: z.unknown(),
    actual: z.unknown(),
    passed: z.boolean()
  }))
});

export type DesignTargetDocument = z.infer<typeof DesignTargetDocumentSchema>;
export type DesignTargetNode = z.infer<typeof DesignTargetNodeSchema>;
export type DesignReferenceValue = z.infer<typeof DesignReferenceValueSchema>;
export type DesignPlanItem = z.infer<typeof DesignPlanItemSchema>;
export type DesignPlan = z.infer<typeof DesignPlanSchema>;
export type DesignVerifyReport = z.infer<typeof DesignVerifyReportSchema>;
