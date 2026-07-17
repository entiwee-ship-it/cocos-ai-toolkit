import { z } from 'zod';
import { ReferenceSchema } from './reference.js';

/**
 * 事务状态机的全部状态。
 * connection-lost 及之后的状态用于断连恢复链路，正常执行路径不会进入。
 */
export const TransactionStateSchema = z.enum([
  'draft', 'planned', 'validated', 'locked', 'executing', 'saving', 'verifying', 'committed',
  'failed', 'rolling-back', 'rolled-back',
  'connection-lost', 'outcome-unknown', 'recovering', 'manual-recovery-required'
]);

/**
 * 写事务执行前的修订前置。
 * 四个维度分别对应文档内容、层级结构、资产数据库和脚本编译状态的指纹；
 * 为 null 表示该维度不参与前置校验。
 */
export const RevisionPreconditionSchema = z.object({
  document: z.string().nullable(),
  hierarchy: z.string().nullable(),
  assetDatabase: z.string().nullable(),
  scriptCompilation: z.string().nullable()
});

export const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

export const QuatSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  w: z.number()
});

/**
 * 节点局部变换写入值。三个分量至少提供一个，未提供的分量保持原值不变。
 */
export const LocalTransformSchema = z.object({
  position: Vec3Schema.optional(),
  rotation: QuatSchema.optional(),
  scale: Vec3Schema.optional()
}).superRefine((transform, context) => {
  if (!transform.position && !transform.rotation && !transform.scale) {
    context.addIssue({
      code: 'custom',
      message: '局部变换至少需要提供 position、rotation、scale 之一'
    });
  }
});

/**
 * 阶段二支持的全部原子写操作。
 * 节点八类、组件七类；每个操作都是事务内可单独回滚的最小单元。
 */
export const WriteOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('node.create'),
    parentNodeUuid: z.string().min(1),
    name: z.string().min(1),
    layer: z.number().optional(),
    active: z.boolean().optional()
  }),
  z.object({
    type: z.literal('node.delete'),
    nodeUuid: z.string().min(1)
  }),
  z.object({
    type: z.literal('node.rename'),
    nodeUuid: z.string().min(1),
    name: z.string().min(1)
  }),
  z.object({
    type: z.literal('node.reparent'),
    nodeUuid: z.string().min(1),
    newParentUuid: z.string().min(1),
    siblingIndex: z.number().int().optional()
  }),
  z.object({
    type: z.literal('node.duplicate'),
    nodeUuid: z.string().min(1),
    parentUuid: z.string().min(1).optional(),
    name: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal('node.set_active'),
    nodeUuid: z.string().min(1),
    active: z.boolean()
  }),
  z.object({
    type: z.literal('node.set_layer'),
    nodeUuid: z.string().min(1),
    layer: z.number()
  }),
  z.object({
    type: z.literal('node.set_transform'),
    nodeUuid: z.string().min(1),
    localTransform: LocalTransformSchema
  }),
  z.object({
    type: z.literal('component.add'),
    nodeUuid: z.string().min(1),
    componentType: z.string().min(1),
    // 内置组件为 null；自定义脚本组件必须携带脚本资产 uuid，供挂载守卫核对。
    scriptUuid: z.string().min(1).nullable()
  }),
  z.object({
    type: z.literal('component.remove'),
    componentUuid: z.string().min(1)
  }),
  z.object({
    type: z.literal('component.enable'),
    componentUuid: z.string().min(1),
    enabled: z.boolean()
  }),
  z.object({
    type: z.literal('component.set_property'),
    componentUuid: z.string().min(1),
    // 支持 items[2]、settings.colors[0] 这类嵌套路径。
    propertyPath: z.string().min(1),
    value: z.unknown(),
    // 提供时作为乐观锁：写入前实际旧值不一致则拒绝执行。
    expectedOldValue: z.unknown().optional()
  }),
  z.object({
    type: z.literal('component.set_reference'),
    componentUuid: z.string().min(1),
    propertyPath: z.string().min(1),
    reference: ReferenceSchema
  }),
  z.object({
    type: z.literal('component.clear_reference'),
    componentUuid: z.string().min(1),
    propertyPath: z.string().min(1)
  }),
  z.object({
    type: z.literal('component.resize_array'),
    componentUuid: z.string().min(1),
    propertyPath: z.string().min(1),
    length: z.number().int().nonnegative()
  })
]);

export type TransactionState = z.infer<typeof TransactionStateSchema>;
export type RevisionPrecondition = z.infer<typeof RevisionPreconditionSchema>;
export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quat = z.infer<typeof QuatSchema>;
export type LocalTransform = z.infer<typeof LocalTransformSchema>;
export type WriteOperation = z.infer<typeof WriteOperationSchema>;
