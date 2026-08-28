import { describe, expect, it } from 'vitest';
import { PrefabProbeSchema } from '../../protocol/src/index.js';
import {
  normalizeComponentDump,
  normalizeHierarchyTree,
  normalizeNodeDump,
  normalizePrefabDump,
  normalizePrefabInstanceSummary,
  resolvePrefabOverrideValues
} from '../src/scene-probe.js';

describe('scene normalizer', () => {
  it('保留节点身份、Transform、层级和完整原始 Dump', () => {
    const raw = {
      uuid: { value: 'node-1' }, name: { value: 'Main Camera' }, active: { value: true },
      layer: { value: 1073741824 }, position: { value: { x: 1, y: 2, z: 3 } },
      rotation: { value: { x: 4, y: 5, z: 6 } }, scale: { value: { x: 1, y: 1, z: 1 } },
      parent: { value: { uuid: 'scene-1' } }, children: [{ uuid: 'child-1' }], __type__: 'cc.Node', __comps__: [],
      __prefab__: { fileId: 'node-file-id' }
    };
    const node = normalizeNodeDump(raw, 2);
    expect(node).toMatchObject({
      identity: { objectUuid: 'node-1', fileId: 'node-file-id' }, name: 'Main Camera', active: true,
      layer: 1073741824, siblingIndex: 2, parentUuid: 'scene-1', childUuids: ['child-1'],
      transform: { position: { x: 1, y: 2, z: 3 } }
    });
    expect(node.raw).toEqual(raw);
  });

  it('紧凑节点归一化不附加节点和组件原始 Dump', () => {
    const node = normalizeNodeDump({
      uuid: { value: 'node-1' },
      name: { value: 'Panel' },
      children: [],
      __comps__: [{
        value: {
          uuid: { value: 'component-1' },
          payload: { type: 'Object', value: { raw: { value: 'business-value' } } }
        },
        type: 'cc.Label'
      }]
    }, null, false);

    expect(node).not.toHaveProperty('raw');
    expect(node.components[0]).not.toHaveProperty('raw');
    expect(node.components[0].properties.uuid).not.toHaveProperty('raw');
    expect(node.components[0].schema).not.toHaveProperty('rawClassAttributes');
    expect(node.components[0].schema.properties[0]).not.toHaveProperty('rawClassAttributes');
    expect(node.components[0].schema.properties.find((property) => property.propertyPath === 'payload')?.currentValue)
      .toEqual({ raw: 'business-value' });
  });

  it('节点摘要直接返回 Prefab 实例根身份', () => {
    const summary = normalizePrefabInstanceSummary({
      uuid: { value: 'instance-node' },
      __prefab__: {
        uuid: 'source-prefab',
        rootUuid: 'instance-node',
        prefabStateInfo: { state: 2 },
        instance: { value: { fileId: { value: 'instance-file-id' } } }
      }
    });

    expect(summary).toEqual({
      isInstanceRoot: true,
      prefabAssetUuid: 'source-prefab',
      instanceFileId: 'instance-file-id',
      state: 2,
      sourceUrl: null
    });
  });

  it('层级深度截断时保留 truncated 标记', () => {
    const hierarchy = normalizeHierarchyTree({
      uuid: 'root', name: 'Root', children: [{
        uuid: 'child', name: 'Child', children: [{ uuid: 'grandchild', name: 'Grandchild', children: [] }]
      }]
    }, 1) as { children: Array<{ truncated: boolean; children: unknown[] }> };

    expect(hierarchy.children[0]).toMatchObject({ truncated: true, children: [] });
  });

  it('紧凑层级归一化不在递归节点中附加原始树', () => {
    const hierarchy = normalizeHierarchyTree({
      uuid: 'root', name: 'Root', children: [{ uuid: 'child', name: 'Child', children: [] }]
    }, 1, false) as { raw?: unknown; children: Array<{ raw?: unknown }> };

    expect(hierarchy).not.toHaveProperty('raw');
    expect(hierarchy.children[0]).not.toHaveProperty('raw');
  });

  it('区分 Node、Component、Asset 引用并保留自定义组件信息', () => {
    const raw = {
      value: {
        uuid: { value: 'component-1' }, node: { type: 'cc.Node', value: { uuid: 'node-1' } },
        target: { type: 'cc.Camera', value: { uuid: 'component-2' }, extends: ['cc.Component'] },
        sprite: { type: 'cc.SpriteFrame', value: { uuid: 'asset-1' }, extends: ['cc.Asset'] },
        __scriptAsset: { type: 'cc.Script', value: { uuid: 'script-1' }, extends: ['cc.Asset'] },
        score: { type: 'Number', value: 3 }, futureProperty: { value: { opaque: true } }
      },
      __prefab__: { fileId: 'component-file-id' },
      type: 'GameController', cid: 'custom-cid', extends: ['cc.Component', 'cc.Object']
    };
    const component = normalizeComponentDump(raw, new Map([
      ['script-1', 'db://assets/script/GameController.ts']
    ]));
    expect(component.identity).toEqual({
      objectUuid: 'component-1',
      fileId: 'component-file-id'
    });
    expect(component.class).toMatchObject({
      className: 'GameController',
      typeId: 'custom-cid',
      custom: true,
      scriptUuid: 'script-1',
      scriptPath: 'db://assets/script/GameController.ts'
    });
    expect(component.schema).toMatchObject({
      className: 'GameController',
      scriptUuid: 'script-1',
      scriptPath: 'db://assets/script/GameController.ts'
    });
    expect(component.properties.node.valueKind).toBe('node-reference');
    expect(component.properties.target.valueKind).toBe('component-reference');
    expect(component.properties.sprite.valueKind).toBe('asset-reference');
    expect(component.unresolved).toContainEqual(expect.objectContaining({ path: 'properties.futureProperty' }));
    expect(component.unresolved).not.toContainEqual(expect.objectContaining({
      reason: 'SCRIPT_ASSET_PATH_NOT_FOUND'
    }));
    expect(component.raw).toEqual(raw);
  });

  it('把 Spine 和 DragonBones 组件归类为 Creator 内建扩展组件', () => {
    for (const className of ['sp.Skeleton', 'dragonBones.ArmatureDisplay']) {
      const component = normalizeComponentDump({
        value: {
          uuid: { value: `${className}-component` }
        },
        type: className,
        cid: `${className}-type-id`,
        extends: ['cc.Component', 'cc.Object']
      });

      expect(component.class).toMatchObject({
        className,
        custom: false,
        scriptUuid: null
      });
      expect(component.unresolved).not.toContainEqual(expect.objectContaining({
        reason: 'SCRIPT_UUID_MISSING'
      }));
    }
  });

  it('区分 Prefab 源、实例、FileID 和属性覆盖', () => {
    const raw = {
      uuid: { value: 'instance-node' },
      __prefab__: {
        uuid: 'source-prefab', fileId: 'source-node-file-id', rootUuid: 'instance-node', sync: true,
        prefabStateInfo: { state: 2, isNested: true, isRevertable: true, isApplicable: true },
        instance: { value: {
          fileId: { value: 'instance-file-id' },
          prefabRootNode: { value: { uuid: 'outer-root' } },
          propertyOverrides: { value: [{ value: {
            targetInfo: { value: { localID: { value: [{ value: 'target-file-id' }] } } },
            propertyPath: { value: [{ value: '_contentSize' }] },
            value: { value: { width: 128, height: 50 }, type: 'cc.Size' }
          } }] },
          targetOverrides: { value: [] }, mountedChildren: { value: [] },
          mountedComponents: { value: [] }, removedComponents: { value: [] }
        } }
      }
    };
    const prefab = normalizePrefabDump(raw, 'document-prefab', 'Page/Instance');
    expect(prefab).toMatchObject({
      ownerDocumentAssetUuid: 'document-prefab',
      hostNodePath: 'Page/Instance',
      sourcePrefabAssetUuid: 'source-prefab',
      instanceRootObjectUuid: 'instance-node',
      sourceObjectFileId: 'source-node-file-id',
      instanceFileId: 'instance-file-id',
      prefabRootNodeUuid: 'outer-root'
    });
    expect(prefab.propertyOverrides[0]).toMatchObject({
      targetLocalIds: ['target-file-id'], propertyPath: ['_contentSize'],
      overrideValue: { width: 128, height: 50 }, declaredType: 'cc.Size'
    });
    expect(prefab.rawPrefabInfo).toEqual(raw.__prefab__);
  });

  it('Prefab 稳定来源身份缺失时写入 unresolved 而不是静默返回 null', () => {
    const prefab = normalizePrefabDump({
      uuid: { value: 'instance-node' },
      __prefab__: {
        rootUuid: 'instance-node',
        instance: { value: {
          propertyOverrides: { value: [] },
          targetOverrides: { value: [] },
          mountedChildren: { value: [] },
          mountedComponents: { value: [] },
          removedComponents: { value: [] }
        } }
      }
    }, 'document-prefab');

    expect(prefab.unresolved).toEqual(expect.arrayContaining([
      { path: 'sourcePrefabAssetUuid', reason: 'SOURCE_PREFAB_ASSET_UUID_MISSING' },
      { path: 'sourceObjectFileId', reason: 'SOURCE_OBJECT_FILE_ID_MISSING' },
      { path: 'instanceFileId', reason: 'PREFAB_INSTANCE_FILE_ID_MISSING' }
    ]));
  });

  it('把 Creator Override 的 undefined 保留为可序列化明确状态', () => {
    const prefab = normalizePrefabDump({
      uuid: { value: 'instance-node' },
      __prefab__: {
        uuid: 'source-prefab',
        fileId: 'source-node-file-id',
        rootUuid: 'instance-node',
        instance: { value: {
          fileId: { value: 'instance-file-id' },
          propertyOverrides: { value: [{ value: {
            targetInfo: { value: { localID: { value: [{ value: 'target-file-id' }] } } },
            propertyPath: { value: [{ value: '_spriteFrame' }] },
            value: { value: undefined, type: 'cc.SpriteFrame' }
          } }] },
          targetOverrides: { value: [] },
          mountedChildren: { value: [] },
          mountedComponents: { value: [] },
          removedComponents: { value: [] }
        } }
      }
    }, 'document-prefab');

    expect(prefab.propertyOverrides[0].overrideValue).toEqual({
      kind: 'undefined',
      source: 'creator-dump'
    });
    expect(prefab.unresolved).toContainEqual({
      path: 'propertyOverrides.0.overrideValue',
      reason: 'CREATOR_OVERRIDE_VALUE_UNDEFINED'
    });

    const roundTrip = JSON.parse(JSON.stringify(prefab)) as unknown;
    expect(() => PrefabProbeSchema.parse(roundTrip)).not.toThrow();
    expect(PrefabProbeSchema.parse(roundTrip).propertyOverrides[0].overrideValue).toEqual({
      kind: 'undefined',
      source: 'creator-dump'
    });
  });

  it('按 FileID 和属性路径分别解析源值与实例最终值', () => {
    const sourceRoot = {
      _prefab: { fileId: 'root-file-id' },
      _name: 'source-root',
      children: [{
        _prefab: { fileId: 'child-file-id' },
        _active: true,
        children: [],
        components: [{ __prefab: { fileId: 'component-file-id' }, _fontSize: 18 }]
      }],
      components: []
    };
    const effectiveRoot = {
      _prefab: { fileId: 'root-file-id' },
      _name: 'instance-root',
      children: [{
        _prefab: { fileId: 'child-file-id' },
        _active: false,
        children: [],
        components: [{ __prefab: { fileId: 'component-file-id' }, _fontSize: 24 }]
      }],
      components: []
    };
    const prefab = {
      propertyOverrides: [
        { index: 0, targetLocalIds: ['child-file-id'], propertyPath: ['_active'], sourceValue: null, overrideValue: false, effectiveValue: null },
        { index: 1, targetLocalIds: ['component-file-id'], propertyPath: ['_fontSize'], sourceValue: null, overrideValue: 24, effectiveValue: null }
      ],
      unresolved: [
        { path: 'propertyOverrides.0.sourceValue', reason: 'SOURCE_VALUE_REQUIRES_PREFAB_SOURCE_LOOKUP' },
        { path: 'propertyOverrides.0.effectiveValue', reason: 'EFFECTIVE_VALUE_REQUIRES_TARGET_RESOLUTION' },
        { path: 'propertyOverrides.1.sourceValue', reason: 'SOURCE_VALUE_REQUIRES_PREFAB_SOURCE_LOOKUP' },
        { path: 'propertyOverrides.1.effectiveValue', reason: 'EFFECTIVE_VALUE_REQUIRES_TARGET_RESOLUTION' }
      ]
    };

    const resolved = resolvePrefabOverrideValues(prefab, sourceRoot, effectiveRoot);

    expect(resolved.propertyOverrides[0]).toMatchObject({ sourceValue: true, overrideValue: false, effectiveValue: false });
    expect(resolved.propertyOverrides[1]).toMatchObject({ sourceValue: 18, overrideValue: 24, effectiveValue: 24 });
    expect(resolved.unresolved).toEqual([]);
  });

  it('多段 localID 未经真实 TargetMap 验证时不猜测目标', () => {
    const prefab = {
      propertyOverrides: [{
        index: 0,
        targetLocalIds: ['outer-file-id', 'inner-file-id'],
        propertyPath: ['_active'],
        sourceValue: null,
        overrideValue: false,
        effectiveValue: null
      }],
      unresolved: []
    };
    const root = {
      _prefab: { fileId: 'inner-file-id' },
      _active: false,
      children: [],
      components: []
    };

    const resolved = resolvePrefabOverrideValues(prefab, root, root);

    expect(resolved.propertyOverrides[0]).toMatchObject({ sourceValue: null, effectiveValue: null });
    expect(resolved.unresolved).toEqual([
      { path: 'propertyOverrides.0.sourceValue', reason: 'MULTI_SEGMENT_TARGET_LOCAL_ID_REQUIRES_NESTED_TARGET_MAP' },
      { path: 'propertyOverrides.0.effectiveValue', reason: 'MULTI_SEGMENT_TARGET_LOCAL_ID_REQUIRES_NESTED_TARGET_MAP' }
    ]);
  });

  it('使用嵌套 TargetMap 逐层解析多段 localID 到最终 FileID', () => {
    const prefab = {
      propertyOverrides: [{
        index: 0,
        targetLocalIds: ['outer-file-id', 'inner-file-id'],
        propertyPath: ['_active'],
        sourceValue: null,
        overrideValue: false,
        effectiveValue: null
      }],
      unresolved: []
    };
    const root = {
      _prefab: { fileId: 'inner-file-id' },
      _active: false,
      children: [],
      components: []
    };
    const targetMaps = {
      targets: {
        'outer-file-id': { assetUuid: 'outer-prefab', fileId: 'outer-file-id', nodePath: null }
      },
      children: {
        'outer-file-id': {
          targets: {
            'inner-file-id': { assetUuid: 'inner-prefab', fileId: 'inner-file-id', nodePath: null }
          },
          children: {}
        }
      }
    };

    const resolved = resolvePrefabOverrideValues(prefab, root, root, targetMaps);

    expect(resolved.propertyOverrides[0]).toMatchObject({ sourceValue: false, effectiveValue: false });
    expect(resolved.unresolved).toEqual([]);
  });

  it('嵌套 TargetMap 缺少下一层时报告下一段 localID 索引', () => {
    const prefab = {
      propertyOverrides: [{
        index: 0,
        targetLocalIds: ['outer-file-id', 'inner-file-id'],
        propertyPath: ['_active'],
        sourceValue: null,
        overrideValue: false,
        effectiveValue: null
      }],
      unresolved: []
    };
    const targetMaps = {
      targets: {
        'outer-file-id': {
          assetUuid: 'outer-prefab',
          fileId: 'outer-file-id',
          nodePath: null
        }
      },
      children: {}
    };

    const resolved = resolvePrefabOverrideValues(prefab, {}, {}, targetMaps);

    expect(resolved.unresolved).toEqual([
      {
        path: 'propertyOverrides.0.sourceValue',
        reason: 'NESTED_TARGET_MAP_SEGMENT_NOT_FOUND_AT_1'
      },
      {
        path: 'propertyOverrides.0.effectiveValue',
        reason: 'NESTED_TARGET_MAP_SEGMENT_NOT_FOUND_AT_1'
      }
    ]);
  });
});
