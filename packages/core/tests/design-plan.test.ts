import { describe, expect, it } from 'vitest';
import type { DesignTargetDocument } from '@cocos-ai/protocol';
import type { DesignDiffItem } from '../src/design-diff.js';
import { buildDesignPlan } from '../src/design-plan.js';

/** 构造最小声明式目标文档。 */
function targetDocument(overrides: Partial<DesignTargetDocument> = {}): DesignTargetDocument {
  return {
    document: { scope: 'current-document' },
    tree: [{ id: '$root', name: 'root' }],
    ...overrides
  };
}

describe('buildDesignPlan', () => {
  it('按依赖排序：父先于子、实例化先于覆盖、脚本挂载最后', () => {
    const target = targetDocument({
      tree: [{
        id: '$root', name: 'root',
        children: [{
          id: '$panel', name: 'panel', prefabInstance: { assetUuid: 'asset-panel' },
          children: [{ id: '$scriptNode', name: 'scriptNode', components: [{ type: 'GameLogic', scriptUuid: 'script-game' }] }]
        }]
      }]
    });
    const diffItems: DesignDiffItem[] = [
      { kind: 'component.add', logicalId: '$scriptNode', componentType: 'GameLogic', scriptUuid: 'script-game' },
      { kind: 'component.set_property', logicalId: '$panel', componentType: 'cc.UITransform', propertyPath: 'width', value: 320 },
      { kind: 'node.create', logicalId: '$scriptNode', parentLogicalId: '$panel', name: 'scriptNode' },
      { kind: 'prefab.instantiate', logicalId: '$panel', parentLogicalId: '$root', prefabAssetUuid: 'asset-panel' },
      { kind: 'node.create', logicalId: '$root', parentLogicalId: null, name: 'root' }
    ];

    const plan = buildDesignPlan(diffItems, target);
    const kinds = plan.items.map((item) => item.kind);
    expect(kinds.indexOf('node.create')).toBeLessThan(kinds.indexOf('prefab.instantiate'));
    expect(kinds.indexOf('prefab.instantiate')).toBeLessThan(kinds.indexOf('component.set_property'));
    expect(kinds.lastIndexOf('component.add')).toBe(kinds.length - 1);
    expect(kinds).toContain('script.wait_for_compile');
  });

  it('逻辑 ID 引用保留 resolveTo 占位并依赖目标节点', () => {
    const target = targetDocument({
      tree: [{
        id: '$root', name: 'root',
        children: [{ id: '$label', name: 'label' }, { id: '$button', name: 'button' }]
      }]
    });
    const diffItems: DesignDiffItem[] = [
      { kind: 'reference.set', logicalId: '$button', componentType: 'cc.Button', propertyPath: 'clickEvents[0].target', reference: '$label' },
      { kind: 'node.create', logicalId: '$button', parentLogicalId: '$root', name: 'button' },
      { kind: 'node.create', logicalId: '$label', parentLogicalId: '$root', name: 'label' },
      { kind: 'node.create', logicalId: '$root', parentLogicalId: null, name: 'root' }
    ];

    const plan = buildDesignPlan(diffItems, target);
    const referenceItem = plan.items.find((item) => item.kind === 'component.set_reference');
    expect(referenceItem).toMatchObject({
      target: '$button',
      propertyPath: 'clickEvents[0].target',
      params: { componentType: 'cc.Button', resolveTo: '$label' },
      dependsOn: expect.arrayContaining(['$button', '$label'])
    });
    expect(plan.items.findIndex((item) => item.target === '$label')).toBeLessThan(plan.items.indexOf(referenceItem!));
  });

  it('源预制体作用域组装影响分析，实例内容写入标注 Override 层', () => {
    const sourceTarget = targetDocument({
      document: { scope: 'source-prefab', assetUuid: 'asset-source' }
    });
    const sourcePlan = buildDesignPlan([], sourceTarget, {
      sourceAssetPath: 'db://assets/source.prefab',
      prefabGraph: {
        nodes: [
          { assetUuid: 'asset-source', path: 'db://assets/source.prefab', documentType: 'prefab' },
          { assetUuid: 'asset-scene', path: 'db://assets/main.scene', documentType: 'scene' }
        ],
        edges: [{ fromAssetUuid: 'asset-scene', toAssetUuid: 'asset-source', instanceRootUuid: 'instance-1', sourceFileId: 'file-root', depth: 1 }],
        blocked: false
      }
    });
    expect(sourcePlan.impactAnalysis).toMatchObject({
      sourceAssetUuid: 'asset-source',
      totalInstanceCount: 1
    });

    const instanceTarget = targetDocument({
      tree: [{
        id: '$instance', name: 'panel', prefabInstance: { assetUuid: 'asset-panel' },
        children: [{ id: '$label', name: 'label' }]
      }]
    });
    const instancePlan = buildDesignPlan([
      { kind: 'component.set_property', logicalId: '$label', componentType: 'cc.Label', propertyPath: 'string', value: '新标题' }
    ], instanceTarget);
    expect(instancePlan.items[0]).toMatchObject({
      producesOverride: true,
      overrideLayer: 'instance:$instance'
    });
  });

  it('apply-to-source 计划最后显式应用指定实例到源 Prefab', () => {
    const target = targetDocument({
      document: { scope: 'apply-to-source', assetUuid: 'asset-panel' },
      tree: [{
        id: '$instance', name: 'panel', prefabInstance: { assetUuid: 'asset-panel' },
        children: [{ id: '$label', name: 'label' }]
      }]
    });
    const plan = buildDesignPlan([
      {
        kind: 'component.set_property', logicalId: '$label', componentType: 'cc.Label',
        propertyPath: 'string', value: '应用到源'
      }
    ], target, {
      sourceAssetPath: 'db://assets/panel.prefab',
      prefabGraph: {
        nodes: [{ assetUuid: 'asset-panel', path: 'db://assets/panel.prefab', documentType: 'prefab' }],
        edges: [],
        blocked: false
      }
    });

    expect(plan.items.at(-1)).toMatchObject({
      kind: 'prefab.apply_to_source',
      target: '$instance',
      params: { instanceRootLogicalId: '$instance', sourcePrefabAssetUuid: 'asset-panel' }
    });
  });

  it('预制体编辑模式中的嵌套实例内容写入进入 unresolved', () => {
    const target = targetDocument({
      tree: [{
        id: '$instance', name: 'panel', prefabInstance: { assetUuid: 'asset-panel' },
        children: [{ id: '$label', name: 'label' }]
      }]
    });
    const plan = buildDesignPlan([
      { kind: 'component.set_property', logicalId: '$label', componentType: 'cc.Label', propertyPath: 'string', value: '不可写' }
    ], target, { documentEditMode: 'prefab' });

    expect(plan.items).toHaveLength(0);
    expect(plan.unresolved[0]).toMatchObject({ path: '$label.string' });
  });
});
