import { describe, expect, it } from 'vitest';
import {
  buildComponentTypeSchema,
  normalizeSerializedReferences,
  readComponentScriptUuid,
  readScriptPathFromAssetInfo
} from '../src/component-schema';

describe('buildComponentTypeSchema', () => {
  it('合并自定义组件脚本、继承链、Inspector 元数据和当前值', () => {
    const raw = {
      value: {
        uuid: { value: 'component-uuid', type: 'String' },
        __scriptAsset: {
          name: '__scriptAsset',
          value: { uuid: 'script-uuid' },
          type: 'cc.Script',
          readonly: true,
          visible: true,
          displayName: 'Script',
          tooltip: '脚本资源',
          extends: ['cc.Asset', 'cc.Object']
        },
        content: {
          name: 'content',
          value: { uuid: 'content-node-uuid' },
          default: null,
          type: 'cc.Node',
          readonly: false,
          visible: true,
          animatable: true,
          displayName: '容器节点',
          group: '基本配置',
          tooltip: 'content 容器节点',
          extends: ['cc.Object']
        },
        direction: {
          name: 'direction',
          value: 1,
          default: 0,
          type: 'Enum',
          readonly: false,
          visible: true,
          enumList: [
            { name: 'VERTICAL', value: 0 },
            { name: 'HORIZONTAL', value: 1 }
          ],
          displayName: '滚动方向',
          group: '基本配置',
          tooltip: '滚动方向',
          extends: []
        },
        gridCount: {
          name: 'gridCount',
          value: 2,
          default: 1,
          type: 'Number',
          readonly: false,
          visible: true,
          min: 1,
          max: 10,
          step: 1,
          displayName: '行列数',
          extends: []
        },
        materials: {
          name: 'materials',
          value: [{
            value: { uuid: 'material-uuid' },
            default: null,
            type: 'cc.Material',
            readonly: false,
            visible: true,
            extends: ['cc.Asset', 'cc.Object']
          }],
          default: [],
          type: 'cc.Material',
          readonly: false,
          visible: true,
          isArray: true,
          elementTypeData: {
            value: { uuid: '' },
            default: null,
            type: 'cc.Material',
            readonly: false,
            visible: true,
            extends: ['cc.Asset', 'cc.Object']
          },
          extends: ['cc.Asset', 'cc.Object']
        },
        emptyNodes: {
          name: 'emptyNodes',
          value: [],
          default: [],
          type: 'cc.Node',
          readonly: false,
          visible: true,
          isArray: true,
          elementTypeData: {
            value: { uuid: '' },
            default: null,
            type: 'cc.Node',
            readonly: false,
            visible: true,
            extends: ['cc.Object']
          },
          extends: ['cc.Object']
        }
      },
      type: 'VScrollViewMode',
      cid: 'custom-type-id',
      extends: ['VirtualScrollView', 'cc.Component', 'cc.Object']
    };
    const schema = buildComponentTypeSchema(raw, new Map([
      ['script-uuid', 'db://assets/script/components/VScrollViewMode.ts']
    ]));

    expect(readComponentScriptUuid(raw)).toBe('script-uuid');
    expect(schema).toMatchObject({
      className: 'VScrollViewMode',
      qualifiedName: 'VScrollViewMode',
      typeId: 'custom-type-id',
      scriptUuid: 'script-uuid',
      scriptPath: 'db://assets/script/components/VScrollViewMode.ts',
      inheritance: ['VirtualScrollView', 'cc.Component', 'cc.Object'],
      executionOrder: null,
      unresolved: []
    });
    expect(schema.properties.find((item) => item.propertyPath === 'content')).toMatchObject({
      serializedName: 'content',
      displayName: '容器节点',
      declaredType: 'cc.Node',
      actualType: 'cc.Node',
      valueKind: 'node-reference',
      nullable: true,
      serializable: true,
      visible: true,
      readonly: false,
      defaultValue: null,
      currentValue: { uuid: 'content-node-uuid' },
      inspectorMetadata: {
        group: '基本配置',
        tooltip: 'content 容器节点',
        animatable: true
      },
      references: [{
        kind: 'node',
        objectUuid: 'content-node-uuid',
        fileId: null,
        nodePath: null,
        available: true
      }]
    });
    expect(schema.properties.find((item) => item.propertyPath === 'direction')).toMatchObject({
      valueKind: 'enum',
      inspectorMetadata: {
        enumList: [
          { name: 'VERTICAL', value: 0 },
          { name: 'HORIZONTAL', value: 1 }
        ]
      }
    });
    expect(schema.properties.find((item) => item.propertyPath === 'gridCount')).toMatchObject({
      inspectorMetadata: { min: 1, max: 10, step: 1 }
    });
    expect(schema.properties.find((item) => item.propertyPath === 'materials')).toMatchObject({
      valueKind: 'array',
      references: [{
        kind: 'asset',
        assetUuid: 'material-uuid',
        subAssetUuid: null,
        assetType: 'cc.Material',
        path: null,
        available: true
      }]
    });
    expect(schema.properties.find((item) => item.propertyPath === 'emptyNodes')).toMatchObject({
      valueKind: 'array',
      references: []
    });
    expect(schema.properties.find((item) => item.propertyPath === 'content')?.rawConsumedKeys)
      .toEqual(expect.arrayContaining(['name', 'value', 'default', 'type', 'displayName', 'group', 'tooltip']));
  });

  it('MissingScript 保留脚本 UUID、原始字段和明确缺口', () => {
    const raw = {
      value: {
        uuid: { value: 'missing-component-uuid', type: 'String' },
        __scriptAsset: {
          value: { uuid: 'missing-script-uuid' },
          type: 'cc.Script',
          readonly: true,
          visible: true,
          extends: ['cc.Asset']
        },
        unknownValue: { value: 7 }
      },
      type: 'cc.MissingScript',
      cid: 'missing-type-id',
      extends: ['cc.Component', 'cc.Object']
    };
    const schema = buildComponentTypeSchema(raw, new Map());

    expect(schema).toMatchObject({
      className: 'cc.MissingScript',
      scriptUuid: 'missing-script-uuid',
      scriptPath: null
    });
    expect(schema.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'SCRIPT_CLASS_NOT_REGISTERED' }),
      expect.objectContaining({ reason: 'SCRIPT_ASSET_PATH_NOT_FOUND' }),
      expect.objectContaining({ path: 'properties.unknownValue', reason: 'DECLARED_TYPE_MISSING' })
    ]));
    expect(schema.rawClassAttributes).toMatchObject({ type: 'cc.MissingScript' });
  });

  it('递归解包 ccclass 数组的 Inspector 属性描述器', () => {
    const schema = buildComponentTypeSchema({
      value: {
        items: {
          name: 'items',
          type: 'CocosAiValidationItem',
          isArray: true,
          value: [{
            type: 'CocosAiValidationItem',
            value: {
              label: { name: 'label', type: 'String', value: 'First' },
              mode: { name: 'mode', type: 'Enum', value: 1 },
              weight: { name: 'weight', type: 'Number', value: 10 }
            }
          }]
        }
      },
      type: 'CocosAiValidationComponent',
      cid: 'validation-component',
      extends: ['cc.Component', 'cc.Object']
    });

    expect(schema.properties.find((item) => item.propertyPath === 'items')?.currentValue).toEqual([
      { label: 'First', mode: 1, weight: 10 }
    ]);
  });

  it('内建扩展组件不伪造脚本 UUID 缺口，同时保留未注册自定义组件诊断', () => {
    for (const className of ['sp.Skeleton', 'dragonBones.ArmatureDisplay']) {
      const schema = buildComponentTypeSchema({
        value: {
          uuid: { value: `${className}-component`, type: 'String' }
        },
        type: className,
        cid: `${className}-type-id`,
        extends: ['cc.Component', 'cc.Object']
      });

      expect(schema.unresolved).not.toContainEqual(expect.objectContaining({
        reason: 'SCRIPT_UUID_MISSING'
      }));
    }

    const customSchema = buildComponentTypeSchema({
      value: {
        uuid: { value: 'custom-component', type: 'String' }
      },
      type: 'UnregisteredCustomComponent',
      cid: 'custom-type-id',
      extends: ['cc.Component', 'cc.Object']
    });
    expect(customSchema.unresolved).toContainEqual(expect.objectContaining({
      path: 'scriptUuid',
      reason: 'SCRIPT_UUID_MISSING'
    }));
  });
});

describe('normalizeSerializedReferences', () => {
  it('区分 Node、Component、Asset 和失效引用', () => {
    expect(normalizeSerializedReferences({
      type: 'cc.Node',
      value: { uuid: 'node-uuid', fileId: 'node-file-id' }
    })).toEqual([{
      kind: 'node',
      objectUuid: 'node-uuid',
      fileId: 'node-file-id',
      nodePath: null,
      available: true
    }]);

    expect(normalizeSerializedReferences({
      type: 'cc.Button',
      value: { uuid: '' },
      extends: ['cc.Component']
    })).toEqual([{
      kind: 'missing',
      expectedKind: 'component',
      serializedUuid: null,
      serializedFileId: null,
      reason: 'serialized-target-empty'
    }]);

    expect(normalizeSerializedReferences({
      type: 'cc.SpriteFrame',
      value: { uuid: 'sprite-frame-uuid' },
      extends: ['cc.Asset']
    })).toEqual([{
      kind: 'asset',
      assetUuid: 'sprite-frame-uuid',
      subAssetUuid: null,
      assetType: 'cc.SpriteFrame',
      path: null,
      available: true
    }]);
  });

  it('递归保留数组元素引用，空数组不伪造失效引用', () => {
    expect(normalizeSerializedReferences({
      type: 'cc.Node',
      value: [
        {
          type: 'cc.Node',
          value: { uuid: 'node-a', fileId: 'node-file-a' },
          extends: ['cc.Object']
        },
        {
          type: 'cc.Node',
          value: { uuid: 'node-b' },
          extends: ['cc.Object']
        },
        {
          type: 'cc.Node',
          value: { uuid: '' },
          extends: ['cc.Object']
        }
      ],
      isArray: true,
      elementTypeData: {
        type: 'cc.Node',
        value: { uuid: '' },
        extends: ['cc.Object']
      },
      extends: ['cc.Object']
    })).toEqual([
      {
        kind: 'node',
        objectUuid: 'node-a',
        fileId: 'node-file-a',
        nodePath: null,
        available: true
      },
      {
        kind: 'node',
        objectUuid: 'node-b',
        fileId: null,
        nodePath: null,
        available: true
      },
      {
        kind: 'missing',
        expectedKind: 'node',
        serializedUuid: null,
        serializedFileId: null,
        reason: 'serialized-target-empty'
      }
    ]);

    expect(normalizeSerializedReferences({
      type: 'cc.Node',
      value: [],
      isArray: true,
      elementTypeData: {
        type: 'cc.Node',
        value: { uuid: '' },
        extends: ['cc.Object']
      },
      extends: ['cc.Object']
    })).toEqual([]);
  });
});

describe('readScriptPathFromAssetInfo', () => {
  it('优先返回稳定的 db URL，并在缺失时返回 null', () => {
    expect(readScriptPathFromAssetInfo({
      url: 'db://assets/script/TestComp.ts',
      file: 'E:/project/assets/script/TestComp.ts'
    })).toBe('db://assets/script/TestComp.ts');
    expect(readScriptPathFromAssetInfo({ file: 'E:/project/assets/script/TestComp.ts' }))
      .toBe('E:/project/assets/script/TestComp.ts');
    expect(readScriptPathFromAssetInfo({})).toBeNull();
  });
});
