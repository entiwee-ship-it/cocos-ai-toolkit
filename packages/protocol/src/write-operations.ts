import { z } from 'zod';
import { ReferenceSchema } from './reference.js';

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

const NodeCreateOperationSchema = z.object({
    type: z.literal('node.create'),
    parentNodeUuid: z.string().min(1),
    name: z.string().min(1),
    layer: z.number().optional(),
    active: z.boolean().optional()
  });
const NodeDeleteOperationSchema = z.object({
    type: z.literal('node.delete'),
    nodeUuid: z.string().min(1)
  });
const NodeRenameOperationSchema = z.object({
    type: z.literal('node.rename'),
    nodeUuid: z.string().min(1),
    name: z.string().min(1)
  });
const NodeReparentOperationSchema = z.object({
    type: z.literal('node.reparent'),
    nodeUuid: z.string().min(1),
    newParentUuid: z.string().min(1),
    siblingIndex: z.number().int().optional()
  });
const NodeDuplicateOperationSchema = z.object({
    type: z.literal('node.duplicate'),
    nodeUuid: z.string().min(1),
    parentUuid: z.string().min(1).optional(),
    name: z.string().min(1).optional()
  });
const NodeSetActiveOperationSchema = z.object({
    type: z.literal('node.set_active'),
    nodeUuid: z.string().min(1),
    active: z.boolean()
  });
const NodeSetLayerOperationSchema = z.object({
    type: z.literal('node.set_layer'),
    nodeUuid: z.string().min(1),
    layer: z.number()
  });
const NodeSetTransformOperationSchema = z.object({
    type: z.literal('node.set_transform'),
    nodeUuid: z.string().min(1),
    localTransform: LocalTransformSchema
  });
const ComponentAddOperationSchema = z.object({
    type: z.literal('component.add'),
    nodeUuid: z.string().min(1),
    componentType: z.string().min(1),
    // 内置组件为 null；自定义脚本组件必须携带脚本资产 uuid，供挂载守卫核对。
    scriptUuid: z.string().min(1).nullable()
  });
const ComponentRemoveOperationSchema = z.object({
    type: z.literal('component.remove'),
    componentUuid: z.string().min(1)
  });
const ComponentEnableOperationSchema = z.object({
    type: z.literal('component.enable'),
    componentUuid: z.string().min(1),
    enabled: z.boolean()
  });
const ComponentSetPropertyOperationSchema = z.object({
    type: z.literal('component.set_property'),
    componentUuid: z.string().min(1),
    // 支持 items[2]、settings.colors[0] 这类嵌套路径。
    propertyPath: z.string().min(1),
    value: z.unknown(),
    // 提供时作为乐观锁：写入前实际旧值不一致则拒绝执行。
    expectedOldValue: z.unknown().optional()
  });
const ComponentSetReferenceOperationSchema = z.object({
    type: z.literal('component.set_reference'),
    componentUuid: z.string().min(1),
    propertyPath: z.string().min(1),
    reference: z.union([ReferenceSchema, z.array(ReferenceSchema)])
  });
const ComponentClearReferenceOperationSchema = z.object({
    type: z.literal('component.clear_reference'),
    componentUuid: z.string().min(1),
    propertyPath: z.string().min(1)
  });
const ComponentResizeArrayOperationSchema = z.object({
    type: z.literal('component.resize_array'),
    componentUuid: z.string().min(1),
    propertyPath: z.string().min(1),
    length: z.number().int().nonnegative()
  });

/**
 * 当前文档内可由公开批量工具直接发送的节点/组件原子写操作。
 * 资产和 Prefab 语义操作必须走各自的专用入口，不能借 batch 绕过身份校验。
 */
export const DocumentWriteOperationSchema = z.discriminatedUnion('type', [
  NodeCreateOperationSchema,
  NodeDeleteOperationSchema,
  NodeRenameOperationSchema,
  NodeReparentOperationSchema,
  NodeDuplicateOperationSchema,
  NodeSetActiveOperationSchema,
  NodeSetLayerOperationSchema,
  NodeSetTransformOperationSchema,
  ComponentAddOperationSchema,
  ComponentRemoveOperationSchema,
  ComponentEnableOperationSchema,
  ComponentSetPropertyOperationSchema,
  ComponentSetReferenceOperationSchema,
  ComponentClearReferenceOperationSchema,
  ComponentResizeArrayOperationSchema
]);

/**
 * 直写协议内部支持的全部原子写操作。
 * 该联合类型供 Bridge/执行器使用，不等于每个公开 MCP 工具都允许全部成员。
 */
export const WriteOperationSchema = z.discriminatedUnion('type', [
  ...DocumentWriteOperationSchema.options,
  z.object({
    type: z.literal('asset.create'),
    assetUrl: z.string().min(1),
    assetKind: z.enum(['folder', 'component-script']),
    content: z.string().min(1).optional()
  }).superRefine((operation, context) => {
    if (operation.assetKind === 'component-script' && !operation.content) {
      context.addIssue({ code: 'custom', message: 'component-script 创建必须提供 content' });
    }
  }),
  z.object({
    type: z.literal('asset.move'),
    sourceUrl: z.string().min(1),
    targetUrl: z.string().min(1),
    expectedAssetUuid: z.string().min(1)
  }),
  z.object({
    type: z.literal('asset.delete'),
    assetUrl: z.string().min(1),
    expectedAssetUuid: z.string().min(1)
  }),
  z.object({
    type: z.literal('asset.write_meta'),
    assetUrl: z.string().min(1),
    expectedAssetUuid: z.string().min(1),
    meta: z.record(z.string(), z.unknown())
  }),
  z.object({
    type: z.literal('asset.update_text'),
    assetUrl: z.string().min(1),
    expectedAssetUuid: z.string().min(1),
    expectedCurrentSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    oldText: z.string().min(1),
    newText: z.string().min(1)
  }).superRefine((operation, context) => {
    if (operation.oldText === operation.newText) {
      context.addIssue({ code: 'custom', message: '文本替换的新旧内容不能相同' });
    }
  }),
  // 阶段三预制体语义操作：实例化、生成、还原覆盖、应用到源、替换源、解除与重新关联。
  z.object({
    type: z.literal('prefab.instantiate'),
    prefabAssetUuid: z.string().min(1),
    parentNodeUuid: z.string().min(1),
    name: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal('prefab.create_from_node'),
    nodeUuid: z.string().min(1),
    assetUrl: z.string().min(1)
  }),
  z.object({
    type: z.literal('prefab.instance_override'),
    instanceRootUuid: z.string().min(1),
    targetObjectUuid: z.string().min(1),
    targetNodePath: z.string().min(1).optional(),
    propertyPath: z.string().min(1),
    value: z.unknown()
  }),
  z.object({
    type: z.literal('prefab.revert_override'),
    instanceRootUuid: z.string().min(1),
    targetObjectUuid: z.string().min(1).optional(),
    targetNodePath: z.string().min(1).optional(),
    // 省略为整实例还原；提供时按属性路径细粒度还原。
    propertyPath: z.string().min(1).optional()
  }).superRefine((operation, context) => {
    if (operation.targetObjectUuid && !operation.propertyPath) {
      context.addIssue({ code: 'custom', message: '精确还原必须提供 propertyPath' });
    }
  }),
  z.object({
    type: z.literal('prefab.apply_to_source'),
    instanceRootUuid: z.string().min(1)
  }),
  z.object({
    type: z.literal('prefab.replace_source'),
    instanceRootUuid: z.string().min(1),
    newPrefabAssetUuid: z.string().min(1)
  }),
  z.object({
    type: z.literal('prefab.unlink_instance'),
    instanceRootUuid: z.string().min(1)
  }),
  z.object({
    type: z.literal('prefab.link_instance'),
    nodeUuid: z.string().min(1),
    prefabAssetUuid: z.string().min(1)
  }),
  // 预制体资产删除：独立清理入口。
  z.object({
    type: z.literal('prefab.delete_asset'),
    assetUrl: z.string().min(1)
  })
]);

export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quat = z.infer<typeof QuatSchema>;
export type LocalTransform = z.infer<typeof LocalTransformSchema>;
export type DocumentWriteOperation = z.infer<typeof DocumentWriteOperationSchema>;
export type WriteOperation = z.infer<typeof WriteOperationSchema>;
