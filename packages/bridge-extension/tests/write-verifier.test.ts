import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ComponentWriteOpResult } from '../src/component-writer.js';
import type { NodeWriteOpResult } from '../src/node-writer.js';
import {
  saveAndVerifyDirectWrite,
  type WriteVerifierDependencies
} from '../src/write-verifier.js';

describe('saveAndVerifyDirectWrite', () => {
  it('保存后重读验证每个写操作的最终生效值，全部一致才 passed', async () => {
    const dependencies = createDependencies();
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [
        nodeResult({ nodeUuid: 'node-1', after: { uuid: 'node-1', name: 'Renamed' } }, { type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' }),
        componentResult({ componentUuid: 'comp-1', after: { uuid: 'comp-1', propertyPath: 'items[2]', value: 'c' } }, { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'items[2]', value: 'c' })
      ],
      dependencies
    );

    expect(dependencies.calls).toEqual(['saveDocument', 'reloadDocument']);
    expect(report.passed).toBe(true);
    expect(report.items).toHaveLength(2);
    expect(report.items.every((item) => item.passed)).toBe(true);
  });

  it('任一项重读不符时 passed 为 false 并保留 expected/actual 明细', async () => {
    const dependencies = createDependencies({ actualNodeName: 'UnexpectedName' });
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [nodeResult({ nodeUuid: 'node-1', after: { uuid: 'node-1', name: 'Renamed' } }, { type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' })],
      dependencies
    );

    expect(report.passed).toBe(false);
    expect(report.items[0]).toMatchObject({
      operationIndex: 0,
      expected: 'Renamed',
      actual: 'UnexpectedName',
      passed: false
    });
  });

  it('node.create 按回填的 resultNodeUuid 重读验证', async () => {
    const dependencies = createDependencies();
    dependencies.getNodeInfo = async (nodeUuid) => nodeUuid === 'created-1'
      ? { uuid: 'created-1', name: 'New' }
      : null;
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: { type: 'node.create', parentNodeUuid: 'p', name: 'New', resultNodeUuid: 'created-1' },
        nodeUuid: 'created-1',
        before: null,
        after: { uuid: 'created-1', name: 'New' },
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: '节点存在', actual: '节点存在', passed: true });
  });

  it('node.create 保存后 UUID 重建时按稳定层级路径重定位', async () => {
    const dependencies = createDependencies();
    dependencies.getNodeInfo = async () => null;
    (dependencies as WriteVerifierDependencies & {
      getNodeInfoByStablePath(path: string): Promise<Record<string, unknown> | null>;
    }).getNodeInfoByStablePath = async (path) => path === '/FriendsRoomView/CocosAiValidationView/Title'
      ? { uuid: 'rebuilt-title', name: 'Title' }
      : null;
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: {
          type: 'node.create',
          parentNodeUuid: 'stale-parent',
          name: 'Title',
          resultNodeUuid: 'stale-title',
          resultNodeStablePath: '/FriendsRoomView/CocosAiValidationView/Title'
        },
        nodeUuid: 'stale-title',
        before: null,
        after: { uuid: 'stale-title', name: 'Title' },
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: '节点存在', actual: '节点存在', passed: true });
  });

  it('prefab.instantiate 保存重开后按稳定路径重定位并保留实例关联', async () => {
    const dependencies = createDependencies();
    dependencies.getPrefabInstanceInfo = async (nodeUuid) => nodeUuid === 'avatar-reloaded'
      ? prefabInfo({
          nodeUuid,
          name: 'Avatar',
          stablePath: '/Scene~0/Panel~0/Avatar~0',
          prefabAssetUuid: 'avatar-prefab',
          instanceFileId: 'avatar-instance'
        })
      : null;
    dependencies.getNodeInfoByStablePath = async (stablePath) => (
      stablePath === '/Scene~0/Panel~0/Avatar~0' ? { uuid: 'avatar-reloaded' } : null
    );

    const report = await saveAndVerifyDirectWrite(writeRequest(), [{
      operation: {
        type: 'prefab.instantiate',
        prefabAssetUuid: 'avatar-prefab',
        parentNodeUuid: 'panel-old',
        name: 'Avatar',
        resultNodeUuid: 'avatar-created',
        resultNodeStablePath: '/Scene~0/Panel~0/Avatar~0',
        resultPrefabAssetUuid: 'avatar-prefab',
        resultPrefabInstanceFileId: 'avatar-instance'
      },
      nodeUuid: 'avatar-created',
      assetUuid: null,
      before: null,
      after: prefabInfo({
        nodeUuid: 'avatar-created',
        name: 'Avatar',
        stablePath: '/Scene~0/Panel~0/Avatar~0',
        prefabAssetUuid: 'avatar-prefab',
        instanceFileId: 'avatar-instance'
      })
    } as never], dependencies);

    expect(dependencies.calls).toEqual(['saveDocument', 'reloadDocument']);
    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({
      passed: true,
      actual: {
        nodeUuid: 'avatar-reloaded',
        stablePath: '/Scene~0/Panel~0/Avatar~0',
        prefabAssetUuid: 'avatar-prefab',
        instanceFileId: 'avatar-instance'
      }
    });
  });

  it('component.add 复用现有组件时作为 no-op 验证且不触发保存', async () => {
    const dependencies = createDependencies();
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: {
          type: 'component.add',
          nodeUuid: 'node-1',
          componentType: 'cc.UITransform',
          resultComponentUuid: 'comp-ui-transform'
        },
        componentUuid: 'comp-ui-transform',
        before: { uuid: 'comp-ui-transform', type: 'cc.UITransform', enabled: true },
        after: { uuid: 'comp-ui-transform', type: 'cc.UITransform', enabled: true },
        changed: false
      } as never],
      dependencies
    );

    expect(dependencies.calls).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: '组件存在', actual: '组件存在', passed: true });
  });

  it('component.add 保存后 UUID 重建时按节点稳定路径和同类型序号重定位', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentInfo = async () => null;
    (dependencies as WriteVerifierDependencies & {
      getComponentInfoByStableLocator(
        nodeStablePath: string,
        componentType: string,
        sameTypeIndex: number
      ): Promise<Record<string, unknown> | null>;
    }).getComponentInfoByStableLocator = async (nodeStablePath, componentType, sameTypeIndex) => (
      nodeStablePath === '/FriendsRoomView~0/CocosAiValidationView~0/Title~0'
      && componentType === 'cc.UITransform'
      && sameTypeIndex === 0
        ? { uuid: 'rebuilt-ui-transform', type: componentType, enabled: true }
        : null
    );
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: {
          type: 'component.add',
          nodeUuid: 'stale-title',
          componentType: 'cc.UITransform',
          resultComponentUuid: 'stale-ui-transform',
          resultComponentNodeStablePath: '/FriendsRoomView~0/CocosAiValidationView~0/Title~0',
          resultComponentType: 'cc.UITransform',
          resultComponentSameTypeIndex: 0
        },
        componentUuid: 'stale-ui-transform',
        before: null,
        after: { uuid: 'stale-ui-transform', type: 'cc.UITransform', enabled: true },
      } as never],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: '组件存在', actual: '组件存在', passed: true });
  });

  it('node.delete 后节点仍可读到时验证失败', async () => {
    const dependencies = createDependencies({ nodeStillExists: true });
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [nodeResult({ nodeUuid: 'node-1', after: null }, { type: 'node.delete', nodeUuid: 'node-1' })],
      dependencies
    );

    expect(report.passed).toBe(false);
    expect(report.items[0].passed).toBe(false);
  });

  it('component.resize_array 重读数组长度', async () => {
    const dependencies = createDependencies();
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [componentResult(
        { componentUuid: 'comp-1', after: { uuid: 'comp-1', propertyPath: 'items', length: 3 } },
        { type: 'component.resize_array', componentUuid: 'comp-1', propertyPath: 'items', length: 3 }
      )],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: 3, actual: 3, passed: true });
  });

  it('clear_reference 按 Dump 空 UUID 判定已清空', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentProperty = async () => ({ uuid: '' });
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: { type: 'component.clear_reference', componentUuid: 'comp-1', propertyPath: 'target' },
        componentUuid: 'comp-1',
        before: { reference: { uuid: 'node-9' } },
        after: { reference: { uuid: '' } },
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0].passed).toBe(true);
  });

  it('set_reference 按归一化 UUID 比对 Dump 形态', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentProperty = async () => ({ uuid: 'node-9' });
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: {
          type: 'component.set_reference',
          componentUuid: 'comp-1',
          propertyPath: 'clickEvents[0].target',
          reference: { kind: 'node', objectUuid: 'node-9', fileId: null, nodePath: null, available: true }
        },
        componentUuid: 'comp-1',
        before: null,
        after: { reference: { uuid: 'node-9' } },
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: 'node-9', actual: 'node-9', passed: true });
  });

  it('set_reference 对引用数组逐项校验 UUID 与顺序', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentProperty = async () => [
      { uuid: 'frame-a' },
      { uuid: 'frame-b' }
    ];
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: {
          type: 'component.set_reference',
          componentUuid: 'comp-1',
          propertyPath: 'textureFrames',
          reference: [
            { kind: 'asset', assetUuid: 'texture-a', subAssetUuid: 'frame-a', assetType: 'cc.SpriteFrame', path: null, available: true },
            { kind: 'asset', assetUuid: 'texture-b', subAssetUuid: 'frame-b', assetType: 'cc.SpriteFrame', path: null, available: true }
          ]
        },
        componentUuid: 'comp-1', before: null, after: null
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({
      expected: ['frame-a', 'frame-b'], actual: ['frame-a', 'frame-b'], passed: true
    });
  });

  it('set_property 对嵌套 ccclass 数组中的 Enum 与引用做结构化 roundtrip 校验', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentProperty = async () => [
      { mode: 2, target: { uuid: 'node-a' }, runtimeOnly: true },
      { mode: 3, target: { uuid: 'frame-a' }, runtimeOnly: true }
    ];
    const value = [
      { mode: 2, target: { kind: 'node', objectUuid: 'node-a', fileId: null, nodePath: null, available: true } },
      { mode: 3, target: { kind: 'asset', assetUuid: 'texture-a', subAssetUuid: 'frame-a', assetType: 'cc.SpriteFrame', path: null, available: true } }
    ];
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [componentResult(
        { componentUuid: 'comp-custom' },
        { type: 'component.set_property', componentUuid: 'comp-custom', propertyPath: 'items', value }
      )],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ passed: true });
  });

  it('AssetDB move 与 write_meta 保存后重读 UUID 和元数据', async () => {
    const dependencies = createDependencies();
    dependencies.queryAssetInfo = async (assetUrl) => assetUrl === 'db://assets/b.ts'
      ? { uuid: 'asset-a', type: 'cc.Script' }
      : null;
    dependencies.readAssetMeta = async () => ({ userData: { priority: 1 } });
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [
        {
          operation: {
            type: 'asset.move', sourceUrl: 'db://assets/a.ts', targetUrl: 'db://assets/b.ts',
            expectedAssetUuid: 'asset-a'
          },
          nodeUuid: null, assetUuid: 'asset-a', before: null, after: null
        },
        {
          operation: {
            type: 'asset.write_meta', assetUrl: 'db://assets/b.ts', expectedAssetUuid: 'asset-a',
            meta: { userData: { priority: 1 } }
          },
          nodeUuid: null, assetUuid: 'asset-a', before: null, after: null
        }
      ],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ expected: 'asset-a', actual: 'asset-a', passed: true }),
      expect.objectContaining({ expected: { userData: { priority: 1 } }, passed: true })
    ]));
  });

  it('asset.update_text 按执行结果目标 SHA256 独立重读验证', async () => {
    const content = 'export enum UIID {\n  Lobby,\n  CocosAiValidation,\n}\n';
    const dependencies = createDependencies();
    dependencies.queryAssetInfo = async () => ({ uuid: 'game-ui-config', type: 'cc.Script' });
    dependencies.readAssetContent = async () => content;
    const report = await saveAndVerifyDirectWrite(
      writeRequest({ save: false }),
      [{
        operation: {
          type: 'asset.update_text',
          assetUrl: 'db://assets/script/GameUIConfig.ts',
          expectedAssetUuid: 'game-ui-config',
          oldText: '  Lobby,',
          newText: '  Lobby,\n  CocosAiValidation,',
          resultTargetSha256: createHash('sha256').update(content).digest('hex')
        },
        nodeUuid: null, assetUuid: 'game-ui-config', before: null, after: null
      }],
      dependencies
    );

    expect(report.items[0]).toMatchObject({
      expected: { assetUuid: 'game-ui-config', sha256: createHash('sha256').update(content).digest('hex') },
      actual: { assetUuid: 'game-ui-config', sha256: createHash('sha256').update(content).digest('hex') },
      passed: true
    });
  });

  it('prefab.instance_override 同时验证最终值与精确 localID 覆盖记录', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentProperty = async () => '新标题';
    dependencies.getPrefabInstanceInfo = async (nodeUuid) => ({
      nodeUuid,
      name: 'Panel',
      prefabAssetUuid: 'asset-panel',
      sourceObjectFileId: 'panel-root',
      instanceFileId: 'panel-instance',
      state: 2,
      isApplicable: true,
      isRevertable: true,
      isUnwrappable: true,
      parentUuid: null,
      childCount: 1,
      overrideCount: 1,
      overridePaths: ['string'],
      overrideTargets: [{
        path: 'string', targetFileId: 'nested-instance',
        targetLocalIds: ['nested-instance', 'label-component']
      }]
    });
    const report = await saveAndVerifyDirectWrite(
      writeRequest(),
      [{
        operation: {
          type: 'prefab.instance_override', instanceRootUuid: 'instance-root',
          targetObjectUuid: 'comp-1', propertyPath: 'string', value: '新标题',
          resultTargetLocalIds: ['nested-instance', 'label-component']
        },
        nodeUuid: 'instance-root', assetUuid: null,
        before: null, after: null,
        targetLocalIds: ['nested-instance', 'label-component']
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ passed: true });
  });

  it('prefab.instance_override 重载后用稳定路径和 FileID 重定位新 UUID', async () => {
    const dependencies = createDependencies();
    dependencies.getPrefabInstanceInfo = async (nodeUuid) => nodeUuid === 'instance-new'
      ? prefabInfo({
          nodeUuid,
          stablePath: '/Scene~0/Panel~0',
          prefabAssetUuid: 'asset-panel',
          instanceFileId: 'instance-file-id',
          overrideCount: 1,
          overridePaths: ['string'],
          overrideTargets: [{
            path: 'string',
            targetFileId: 'nested-instance',
            targetLocalIds: ['nested-instance', 'label-component']
          }]
        })
      : null;
    dependencies.getNodeInfoByStablePath = async (stablePath) => stablePath === '/Scene~0/Panel~0'
      ? { uuid: 'instance-new' }
      : null;
    const getPrefabTargetProperty = vi.fn(async () => '新标题');
    (dependencies as WriteVerifierDependencies & {
      getPrefabTargetProperty(
        instanceRootUuid: string,
        targetLocalIds: string[],
        propertyPath: string
      ): Promise<unknown>;
    }).getPrefabTargetProperty = getPrefabTargetProperty;

    const report = await saveAndVerifyDirectWrite(writeRequest(), [{
      operation: {
        type: 'prefab.instance_override',
        instanceRootUuid: 'instance-old',
        targetObjectUuid: 'label-old',
        propertyPath: 'string',
        value: '新标题',
        resultNodeStablePath: '/Scene~0/Panel~0',
        resultPrefabAssetUuid: 'asset-panel',
        resultPrefabInstanceFileId: 'instance-file-id',
        resultTargetLocalIds: ['nested-instance', 'label-component']
      },
      nodeUuid: 'instance-old', assetUuid: null,
      before: null, after: null,
      targetLocalIds: ['nested-instance', 'label-component']
    }], dependencies);

    expect(report.passed).toBe(true);
    expect(getPrefabTargetProperty).toHaveBeenCalledWith(
      'instance-new',
      ['nested-instance', 'label-component'],
      'string'
    );
  });

  it('prefab.revert_override 重载后同时验证覆盖已删除且属性已恢复源值', async () => {
    const dependencies = createDependencies();
    dependencies.getPrefabInstanceInfo = async (nodeUuid) => nodeUuid === 'instance-new'
      ? prefabInfo({
          nodeUuid,
          stablePath: '/Scene~0/Panel~0',
          prefabAssetUuid: 'asset-panel',
          instanceFileId: 'instance-file-id',
          overrideCount: 0,
          overridePaths: [],
          overrideTargets: []
        })
      : null;
    dependencies.getNodeInfoByStablePath = async () => ({ uuid: 'instance-new' });
    const getPrefabTargetProperty = vi.fn(async () => 'Source Value');
    (dependencies as WriteVerifierDependencies & {
      getPrefabTargetProperty(
        instanceRootUuid: string,
        targetLocalIds: string[],
        propertyPath: string
      ): Promise<unknown>;
    }).getPrefabTargetProperty = getPrefabTargetProperty;

    const report = await saveAndVerifyDirectWrite(writeRequest(), [{
      operation: {
        type: 'prefab.revert_override',
        instanceRootUuid: 'instance-old',
        targetObjectUuid: 'label-old',
        propertyPath: 'string',
        resultNodeStablePath: '/Scene~0/Panel~0',
        resultPrefabAssetUuid: 'asset-panel',
        resultPrefabInstanceFileId: 'instance-file-id',
        resultTargetLocalIds: ['nested-instance', 'label-component'],
        resultHadPreviousOverride: true,
        resultPreviousOverrideValue: 'Override Applied'
      },
      nodeUuid: 'instance-old', assetUuid: null,
      before: null, after: null,
      targetLocalIds: ['nested-instance', 'label-component']
    }], dependencies);

    expect(report.passed).toBe(true);
    expect(report.items[0].actual).toMatchObject({
      overrideRemoved: true,
      restoredValue: 'Source Value'
    });
  });

  it('node.rename 重载后用稳定路径验证新 UUID', async () => {
    const dependencies = createDependencies();
    dependencies.getNodeInfo = async () => null;
    dependencies.getNodeInfoByStablePath = async (stablePath) => stablePath === '/Scene~0/Renamed~0'
      ? { uuid: 'node-new', name: 'Renamed' }
      : null;

    const report = await saveAndVerifyDirectWrite(writeRequest(), [nodeResult({
      nodeUuid: 'node-old',
      after: { uuid: 'node-old', name: 'Renamed', stablePath: '/Scene~0/Renamed~0' }
    }, {
      type: 'node.rename',
      nodeUuid: 'node-old',
      name: 'Renamed',
      resultNodeStablePath: '/Scene~0/Renamed~0'
    })], dependencies);

    expect(report.passed).toBe(true);
  });

  it('node.reparent 节点存在但稳定路径错误时验证失败', async () => {
    const dependencies = createDependencies();
    dependencies.getNodeInfo = async () => ({
      uuid: 'node-old',
      parentUuid: 'wrong-parent',
      stablePath: '/Scene~0/WrongParent~0/Panel~0'
    });

    const report = await saveAndVerifyDirectWrite(writeRequest(), [nodeResult({
      nodeUuid: 'node-old',
      after: { uuid: 'node-old', parentUuid: 'parent-new', stablePath: '/Scene~0/NewParent~0/Panel~0' }
    }, {
      type: 'node.reparent',
      nodeUuid: 'node-old',
      newParentUuid: 'parent-new',
      resultNodeStablePath: '/Scene~0/NewParent~0/Panel~0'
    })], dependencies);

    expect(report.passed).toBe(false);
    expect(report.items[0]).toMatchObject({
      expected: '/Scene~0/NewParent~0/Panel~0',
      actual: '/Scene~0/WrongParent~0/Panel~0',
      passed: false
    });
  });

  it('node.reparent 缺少稳定路径时回退验证新父节点', async () => {
    const dependencies = createDependencies();
    dependencies.getNodeInfo = async () => ({ uuid: 'node-old', parentUuid: 'parent-new' });

    const report = await saveAndVerifyDirectWrite(writeRequest(), [nodeResult({
      nodeUuid: 'node-old',
      after: { uuid: 'node-old', parentUuid: 'parent-new', stablePath: '/Scene~0/NewParent~0/Panel~0' }
    }, {
      type: 'node.reparent',
      nodeUuid: 'node-old',
      newParentUuid: 'parent-new',
      resultNodeStablePath: '/Scene~0/NewParent~0/Panel~0'
    })], dependencies);

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: 'parent-new', actual: 'parent-new', passed: true });
  });

  it('node.delete 重载后仍能用删除前稳定路径发现残留节点', async () => {
    const dependencies = createDependencies();
    dependencies.getNodeInfo = async () => null;
    dependencies.getNodeInfoByStablePath = async () => ({ uuid: 'node-new', name: 'StillHere' });

    const report = await saveAndVerifyDirectWrite(writeRequest(), [nodeResult({
      nodeUuid: 'node-old',
      before: { uuid: 'node-old', name: 'StillHere', stablePath: '/Scene~0/StillHere~0' },
      after: null
    }, {
      type: 'node.delete',
      nodeUuid: 'node-old',
      resultNodeStablePath: '/Scene~0/StillHere~0'
    })], dependencies);

    expect(report.passed).toBe(false);
    expect(report.items[0].actual).toBe('节点仍存在');
  });

  it('component.set_property 重载后用节点路径和组件序号读取新 UUID', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentInfo = async () => null;
    dependencies.getComponentInfoByStableLocator = async () => ({
      uuid: 'component-new', type: 'cc.Label', enabled: true
    });
    dependencies.getComponentProperty = async (componentUuid) => componentUuid === 'component-new'
      ? 'Saved Value'
      : undefined;

    const report = await saveAndVerifyDirectWrite(writeRequest(), [componentResult({
      componentUuid: 'component-old',
      after: null
    }, {
      type: 'component.set_property',
      componentUuid: 'component-old',
      propertyPath: 'string',
      value: 'Saved Value',
      resultComponentNodeStablePath: '/Scene~0/Label~0',
      resultComponentType: 'cc.Label',
      resultComponentSameTypeIndex: 0
    })], dependencies);

    expect(report.passed).toBe(true);
  });

  it('component.remove 重载后仍能用稳定 locator 发现残留组件', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentInfo = async () => null;
    dependencies.getComponentInfoByStableLocator = async () => ({
      uuid: 'component-new', type: 'cc.Label', enabled: true
    });

    const report = await saveAndVerifyDirectWrite(writeRequest(), [componentResult({
      componentUuid: 'component-old',
      before: null,
      after: null
    }, {
      type: 'component.remove',
      componentUuid: 'component-old',
      resultComponentNodeStablePath: '/Scene~0/Label~0',
      resultComponentType: 'cc.Label',
      resultComponentSameTypeIndex: 0
    })], dependencies);

    expect(report.passed).toBe(false);
    expect(report.items[0].actual).toBe('组件仍存在');
  });

  it('prefab.unlink_instance current 保留子树、组件和嵌套 Prefab', async () => {
    const dependencies = createDependencies();
    dependencies.getPrefabInstanceInfo = async () => prefabInfo({
      nodeUuid: 'instance-new',
      prefabAssetUuid: null,
      instanceFileId: null
    });
    dependencies.getNodeInfoByStablePath = async () => ({ uuid: 'instance-new' });
    dependencies.getPrefabSubtreeSnapshot = async () => unpackSnapshot({ currentUnlinked: true });

    const report = await saveAndVerifyDirectWrite(writeRequest(), [{
      operation: {
        type: 'prefab.unlink_instance',
        instanceRootUuid: 'instance-old',
        removeNested: false,
        expectedPrefabAssetUuid: 'asset-panel',
        resultNodeStablePath: '/Scene~0/Panel~0',
        resultPrefabBeforeSubtree: unpackSnapshot()
      },
      nodeUuid: 'instance-old', assetUuid: null,
      before: prefabInfo(), after: prefabInfo({ prefabAssetUuid: null, instanceFileId: null })
    } as never], dependencies);

    expect(report.passed).toBe(true);
    expect(report.items[0].actual).toMatchObject({
      subtreePreserved: true,
      componentsPreserved: true,
      oldAssociationRemoved: true,
      nestedAssociationsPreserved: true
    });
  });

  it('prefab.unlink_instance complete 清除子树内全部 Prefab 关联', async () => {
    const dependencies = createDependencies();
    dependencies.getPrefabInstanceInfo = async () => prefabInfo({
      nodeUuid: 'instance-new',
      prefabAssetUuid: null,
      instanceFileId: null
    });
    dependencies.getNodeInfoByStablePath = async () => ({ uuid: 'instance-new' });
    dependencies.getPrefabSubtreeSnapshot = async () => unpackSnapshot({ completeUnlinked: true });

    const report = await saveAndVerifyDirectWrite(writeRequest(), [{
      operation: {
        type: 'prefab.unlink_instance',
        instanceRootUuid: 'instance-old',
        removeNested: true,
        expectedPrefabAssetUuid: 'asset-panel',
        resultNodeStablePath: '/Scene~0/Panel~0',
        resultPrefabBeforeSubtree: unpackSnapshot()
      },
      nodeUuid: 'instance-old', assetUuid: null,
      before: prefabInfo(), after: prefabInfo({ prefabAssetUuid: null, instanceFileId: null })
    } as never], dependencies);

    expect(report.passed).toBe(true);
    expect(report.items[0].actual).toMatchObject({
      subtreePreserved: true,
      componentsPreserved: true,
      allAssociationsRemoved: true
    });
  });

  it('prefab.unlink_instance 组件丢失时验证失败', async () => {
    const dependencies = createDependencies();
    dependencies.getPrefabInstanceInfo = async () => prefabInfo({
      nodeUuid: 'instance-new', prefabAssetUuid: null, instanceFileId: null
    });
    dependencies.getNodeInfoByStablePath = async () => ({ uuid: 'instance-new' });
    dependencies.getPrefabSubtreeSnapshot = async () => unpackSnapshot({
      currentUnlinked: true,
      rootComponentTypes: []
    });

    const report = await saveAndVerifyDirectWrite(writeRequest(), [{
      operation: {
        type: 'prefab.unlink_instance', instanceRootUuid: 'instance-old',
        removeNested: false, expectedPrefabAssetUuid: 'asset-panel',
        resultNodeStablePath: '/Scene~0/Panel~0', resultPrefabBeforeSubtree: unpackSnapshot()
      },
      nodeUuid: 'instance-old', assetUuid: null,
      before: prefabInfo(), after: prefabInfo({ prefabAssetUuid: null, instanceFileId: null })
    } as never], dependencies);

    expect(report.passed).toBe(false);
    expect(report.items[0].actual).toMatchObject({ componentsPreserved: false });
  });

  it('save 为 false 时不保存不重开，直接对编辑器现状重读验证', async () => {
    const dependencies = createDependencies();
    const report = await saveAndVerifyDirectWrite(
      writeRequest({ save: false }),
      [nodeResult({ nodeUuid: 'node-1', after: { uuid: 'node-1', name: 'Renamed' } }, { type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' })],
      dependencies
    );

    expect(dependencies.calls).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

function writeRequest(overrides: { save?: boolean } = {}): { save: boolean } {
  return { save: true, ...overrides };
}

function nodeResult(
  overrides: Partial<NodeWriteOpResult>,
  operation: { type: string; [field: string]: unknown }
): NodeWriteOpResult & { operation: { type: string; [field: string]: unknown } } {
  return {
    nodeUuid: 'node-1',
    before: null,
    after: null,
    ...overrides,
    operation
  };
}

function componentResult(
  overrides: Partial<ComponentWriteOpResult>,
  operation: { type: string; [field: string]: unknown }
): ComponentWriteOpResult & { operation: { type: string; [field: string]: unknown } } {
  return {
    componentUuid: 'comp-1',
    before: null,
    after: null,
    ...overrides,
    operation
  };
}

function createDependencies(options: {
  actualNodeName?: string;
  nodeStillExists?: boolean;
} = {}): WriteVerifierDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    saveDocument: async () => {
      calls.push('saveDocument');
    },
    reloadDocument: async () => {
      calls.push('reloadDocument');
    },
    getNodeInfo: async (nodeUuid) => {
      if (options.nodeStillExists === false) return null;
      if (options.nodeStillExists) return { uuid: nodeUuid, name: 'Renamed' };
      return { uuid: nodeUuid, name: options.actualNodeName ?? 'Renamed' };
    },
    getComponentInfo: async (componentUuid) => ({ uuid: componentUuid, type: 'cc.Label', enabled: true }),
    getComponentProperty: async (_componentUuid, propertyPath) => {
      if (propertyPath === 'items[2]') return 'c';
      if (propertyPath === 'items') return ['a', 'b', 'c'];
      return undefined;
    },
    getPrefabInstanceInfo: async (nodeUuid) => ({
      nodeUuid,
      name: 'Instance',
      prefabAssetUuid: 'asset-1',
      sourceObjectFileId: 'file-1',
      instanceFileId: 'inst-1',
      state: 2,
      isApplicable: true,
      isRevertable: true,
      isUnwrappable: true,
      parentUuid: null,
      childCount: 0,
      overrideCount: 0,
      overridePaths: [],
      overrideTargets: []
    }),
    getPrefabSubtreeSnapshot: async () => unpackSnapshot(),
    queryAssetInfo: async () => null,
    readAssetMeta: async () => ({}),
    readAssetContent: async () => ''
  };
}

function prefabInfo(overrides: Record<string, unknown> = {}) {
  return {
    nodeUuid: 'instance-root',
    name: 'Panel',
    stablePath: '/Scene~0/Panel~0',
    prefabAssetUuid: 'asset-panel',
    sourceObjectFileId: 'panel-root',
    instanceFileId: 'instance-file-id',
    state: 2,
    isApplicable: true,
    isRevertable: true,
    isUnwrappable: true,
    parentUuid: null,
    childCount: 1,
    overrideCount: 0,
    overridePaths: [],
    overrideTargets: [],
    ...overrides
  } as never;
}

function unpackSnapshot(options: {
  currentUnlinked?: boolean;
  completeUnlinked?: boolean;
  rootComponentTypes?: string[];
} = {}) {
  return {
    rootStablePath: '/Scene~0/Panel~0',
    nodes: [
      {
        nodeUuid: 'instance-root',
        relativePath: '',
        name: 'Panel',
        componentTypes: options.rootComponentTypes ?? ['cc.UITransform'],
        prefabAssetUuid: options.currentUnlinked || options.completeUnlinked ? 'host-asset' : 'asset-panel',
        instanceFileId: options.currentUnlinked || options.completeUnlinked ? null : 'instance-file-id',
        isNested: !(options.currentUnlinked || options.completeUnlinked),
        state: options.currentUnlinked || options.completeUnlinked ? 1 : 2
      },
      {
        nodeUuid: 'nested-root',
        relativePath: '0',
        name: 'Nested',
        componentTypes: ['cc.Sprite'],
        prefabAssetUuid: options.completeUnlinked ? 'host-asset' : 'asset-nested',
        instanceFileId: options.completeUnlinked ? null : 'nested-instance-file-id',
        isNested: !options.completeUnlinked,
        state: options.completeUnlinked ? 1 : 2
      }
    ]
  } as never;
}
