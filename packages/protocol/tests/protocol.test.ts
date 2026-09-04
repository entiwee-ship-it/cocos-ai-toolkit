import { describe, expect, it } from 'vitest';
import {
  ComponentTypeSchemaSchema,
  ComponentPropertyDescriptorSchema,
  PrefabProbeSchema,
  ReferenceSchema,
} from '../src/index.js';

describe('Prefab 协议', () => {

  it('保留 Prefab 探针中的完整实例来源链字段', () => {
    const result = PrefabProbeSchema.parse({
      ownerDocumentAssetUuid: 'owner-prefab',
      sourcePrefabAssetUuid: 'source-prefab',
      instanceRootObjectUuid: 'instance-root',
      sourceObjectFileId: 'source-file-id',
      instanceFileId: 'instance-file-id',
      prefabRootNodeUuid: 'root-node',
      sync: true,
      state: { state: 2 },
      instanceChain: [{
        depth: 1,
        assetUuid: 'source-prefab',
        instanceNodeUuid: 'instance-root',
        state: 2,
        isNested: true
      }],
      propertyOverrides: [],
      targetOverrides: [],
      mountedChildren: [],
      mountedComponents: [],
      removedComponents: [],
      unresolved: [],
      rawPrefabInfo: {}
    });

    expect(result.instanceChain[0]).toMatchObject({ state: 2, isNested: true });
  });
});

describe('阶段 1 只读协议', () => {
  it('接受包含脚本路径、Inspector 元数据和原始字段消费状态的组件 Schema', () => {
    const result = ComponentTypeSchemaSchema.parse({
      className: 'VScrollViewMode',
      qualifiedName: 'VScrollViewMode',
      typeId: 'b9a82SIRzRA64VTpoykHpqL',
      scriptUuid: 'b9a82488-4734-40eb-8553-a68ca41e9a8b',
      scriptPath: 'db://assets/script/components/VScrollViewMode.ts',
      inheritance: ['VirtualScrollView', 'cc.Component', 'cc.Object'],
      executionOrder: 0,
      properties: [{
        propertyPath: 'content',
        serializedName: 'content',
        displayName: '内容节点',
        declaredType: 'cc.Node',
        actualType: 'cc.Node',
        valueKind: 'node-reference',
        nullable: true,
        serializable: true,
        visible: true,
        readonly: false,
        defaultValue: null,
        currentValue: { uuid: 'content-node-uuid' },
        references: [{
          kind: 'node',
          objectUuid: 'content-node-uuid',
          fileId: null,
          nodePath: null,
          available: true
        }],
        inspectorMetadata: {
          tooltip: '滚动内容根节点'
        },
        rawClassAttributes: {
          type: 'cc.Node'
        },
        rawConsumedKeys: ['type', 'tooltip']
      }],
      rawClassAttributes: {},
      unresolved: []
    });

    expect(result.scriptPath).toBe('db://assets/script/components/VScrollViewMode.ts');
    expect(result.properties[0]).toMatchObject({
      valueKind: 'node-reference',
      inspectorMetadata: {
        tooltip: '滚动内容根节点'
      }
    });
  });

  it('组件属性 Schema 必须显式携带当前值和引用列表', () => {
    const descriptor = {
      propertyPath: 'content',
      serializedName: 'content',
      displayName: '内容节点',
      declaredType: 'cc.Node',
      actualType: 'cc.Node',
      valueKind: 'node-reference',
      nullable: true,
      serializable: true,
      visible: true,
      readonly: false,
      defaultValue: null,
      inspectorMetadata: {},
      rawClassAttributes: {},
      rawConsumedKeys: []
    };

    expect(() => ComponentPropertyDescriptorSchema.parse({
      ...descriptor,
      references: []
    })).toThrow();
    expect(() => ComponentPropertyDescriptorSchema.parse({
      ...descriptor,
      currentValue: null
    })).toThrow();
  });

  it('区分可用资产引用和缺失组件引用', () => {
    expect(ReferenceSchema.parse({
      kind: 'asset',
      assetUuid: 'sprite-frame-uuid',
      subAssetUuid: null,
      assetType: 'cc.SpriteFrame',
      path: 'db://assets/ui/button/spriteFrame',
      available: true
    }).kind).toBe('asset');

    expect(ReferenceSchema.parse({
      kind: 'missing',
      expectedKind: 'component',
      serializedUuid: 'removed-component-uuid',
      serializedFileId: 'removed-component-file-id',
      reason: 'target-component-removed'
    }).kind).toBe('missing');
  });
});
