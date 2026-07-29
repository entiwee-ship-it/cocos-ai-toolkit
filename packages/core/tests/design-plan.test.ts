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

  it('引用数组保留顺序并为每个逻辑 ID 建立依赖', () => {
    const target = targetDocument({
      tree: [{
        id: '$root', name: 'root',
        children: [
          { id: '$first', name: 'first' },
          { id: '$second', name: 'second' },
          { id: '$consumer', name: 'consumer' }
        ]
      }]
    });
    const diffItems: DesignDiffItem[] = [
      {
        kind: 'reference.set', logicalId: '$consumer', componentType: 'FrameList',
        propertyPath: 'frames', reference: ['$first', '$second']
      },
      { kind: 'node.create', logicalId: '$consumer', parentLogicalId: '$root', name: 'consumer' },
      { kind: 'node.create', logicalId: '$second', parentLogicalId: '$root', name: 'second' },
      { kind: 'node.create', logicalId: '$first', parentLogicalId: '$root', name: 'first' },
      { kind: 'node.create', logicalId: '$root', parentLogicalId: null, name: 'root' }
    ];

    const plan = buildDesignPlan(diffItems, target);
    expect(plan.items.find((item) => item.kind === 'component.set_reference')).toMatchObject({
      params: { reference: ['$first', '$second'] },
      dependsOn: expect.arrayContaining(['$consumer', '$first', '$second'])
    });
  });

  it('显式 UITransform 属性在 Sprite 和 Label 的尺寸副作用之后写入', () => {
    const target = targetDocument({
      tree: [{ id: '$root', name: 'root', children: [
        { id: '$background', name: 'Background' },
        { id: '$title', name: 'Title' }
      ] }]
    });
    const plan = buildDesignPlan([
      {
        kind: 'component.set_property', logicalId: '$background', componentType: 'cc.UITransform',
        propertyPath: 'contentSize', value: { width: 640, height: 360 }
      },
      {
        kind: 'reference.set', logicalId: '$background', componentType: 'cc.Sprite',
        propertyPath: 'spriteFrame', reference: { kind: 'asset', assetUuid: 'frame-a' }
      },
      {
        kind: 'component.set_property', logicalId: '$title', componentType: 'cc.UITransform',
        propertyPath: 'contentSize', value: { width: 400, height: 80 }
      },
      {
        kind: 'component.set_property', logicalId: '$title', componentType: 'cc.Label',
        propertyPath: 'string', value: 'Cocos AI 0.2.0'
      }
    ], target);

    const backgroundSize = plan.items.findIndex((item) => item.target === '$background'
      && item.kind === 'component.set_property' && item.params?.componentType === 'cc.UITransform');
    const spriteFrame = plan.items.findIndex((item) => item.target === '$background'
      && item.kind === 'component.set_reference');
    const titleSize = plan.items.findIndex((item) => item.target === '$title'
      && item.kind === 'component.set_property' && item.params?.componentType === 'cc.UITransform');
    const labelString = plan.items.findIndex((item) => item.target === '$title'
      && item.kind === 'component.set_property' && item.params?.componentType === 'cc.Label');

    expect(spriteFrame).toBeLessThan(backgroundSize);
    expect(labelString).toBeLessThan(titleSize);
  });

  it('新建 Label 声明固定 contentSize 时补 CLAMP，显式 overflow 不被覆盖', () => {
    const target = targetDocument({
      tree: [{
        id: '$title', name: 'Title', components: [
          { type: 'cc.UITransform', properties: { contentSize: { width: 400, height: 80 } } },
          { type: 'cc.Label', properties: { string: 'Cocos AI' } }
        ]
      }]
    });
    const plan = buildDesignPlan([
      { kind: 'node.create', logicalId: '$title', parentLogicalId: null, name: 'Title' },
      {
        kind: 'component.add', logicalId: '$title', componentType: 'cc.UITransform',
        properties: { contentSize: { width: 400, height: 80 } }
      },
      {
        kind: 'component.add', logicalId: '$title', componentType: 'cc.Label',
        properties: { string: 'Cocos AI' }
      }
    ], target);

    expect(plan.items).toContainEqual(expect.objectContaining({
      kind: 'component.set_property',
      target: '$title',
      propertyPath: 'overflow',
      value: 1,
      params: expect.objectContaining({ componentType: 'cc.Label' })
    }));

    const explicitTarget = targetDocument({
      tree: [{
        id: '$title', name: 'Title', components: [
          { type: 'cc.UITransform', properties: { contentSize: { width: 400, height: 80 } } },
          { type: 'cc.Label', properties: { string: 'Cocos AI', overflow: 0 } }
        ]
      }]
    });
    const explicitPlan = buildDesignPlan([
      { kind: 'node.create', logicalId: '$title', parentLogicalId: null, name: 'Title' },
      {
        kind: 'component.add', logicalId: '$title', componentType: 'cc.UITransform',
        properties: { contentSize: { width: 400, height: 80 } }
      },
      {
        kind: 'component.add', logicalId: '$title', componentType: 'cc.Label',
        properties: { string: 'Cocos AI', overflow: 0 }
      }
    ], explicitTarget);

    expect(explicitPlan.items.filter((item) => item.propertyPath === 'overflow')).toEqual([
      expect.objectContaining({ value: 0 })
    ]);
  });

  it('document.extract_subtree 生成身份屏障计划并依赖目标节点', () => {
    const target = targetDocument({
      tree: [{ id: '$root', name: 'root', children: [{ id: '$dialog', name: 'dialog' }] }],
      operations: [{
        type: 'document.extract_subtree', nodeId: '$dialog', assetUrl: 'db://assets/ui/Dialog.prefab'
      }]
    });
    const plan = buildDesignPlan([
      { kind: 'node.create', logicalId: '$root', parentLogicalId: null, name: 'root' },
      { kind: 'node.create', logicalId: '$dialog', parentLogicalId: '$root', name: 'dialog' }
    ], target);

    expect(plan.items.at(-1)).toMatchObject({
      kind: 'document.extract_subtree', target: '$dialog',
      params: { nodeLogicalId: '$dialog', assetUrl: 'db://assets/ui/Dialog.prefab' },
      dependsOn: expect.arrayContaining(['$dialog'])
    });
  });

  it('prefab.revert_override 生成可精确物化的声明式还原计划', () => {
    const target = targetDocument({
      tree: [{
        id: '$instance', name: 'panel', path: 'Root/Panel', prefabInstance: { assetUuid: 'asset-panel' },
        children: [{ id: '$label', name: 'label', path: 'Root/Panel/Label' }]
      }],
      operations: [{
        type: 'prefab.revert_override',
        instanceRootId: '$instance',
        targetId: '$label',
        componentType: 'cc.Label',
        propertyPath: 'string'
      }]
    });

    const plan = buildDesignPlan([], target, { documentEditMode: 'prefab' });

    expect(plan.items).toEqual([expect.objectContaining({
      kind: 'prefab.revert_override',
      target: '$label',
      propertyPath: 'string',
      params: {
        instanceRootLogicalId: '$instance',
        targetObjectLogicalId: '$label',
        componentType: 'cc.Label',
        targetNodePath: 'Root/Panel/Label'
      }
    })]);
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

  it('预制体编辑模式中的嵌套实例属性写入生成显式 override', () => {
    const target = targetDocument({
      tree: [{
        id: '$instance', name: 'panel', path: 'Root/Panel', prefabInstance: { assetUuid: 'asset-panel' },
        children: [{ id: '$label', name: 'label', path: 'Root/Panel/Label' }]
      }]
    });
    const plan = buildDesignPlan([
      {
        kind: 'component.set_property', logicalId: '$label', targetUuid: 'node-label',
        componentUuid: 'component-label', componentType: 'cc.Label', propertyPath: 'string', value: '可写'
      }
    ], target, { documentEditMode: 'prefab' });

    expect(plan.unresolved).toEqual([]);
    expect(plan.items).toEqual([expect.objectContaining({
      kind: 'prefab.instance_override',
      target: '$label',
      propertyPath: 'string',
      value: '可写',
      producesOverride: true,
      overrideLayer: 'instance:$instance',
      params: expect.objectContaining({
        instanceRootLogicalId: '$instance',
        targetObjectUuid: 'component-label',
        componentType: 'cc.Label',
        targetNodePath: 'Root/Panel/Label'
      })
    })]);
  });

  it('预制体编辑模式中的嵌套实例结构修改仍拒绝', () => {
    const target = targetDocument({
      tree: [{
        id: '$instance', name: 'panel', prefabInstance: { assetUuid: 'asset-panel' },
        children: [{ id: '$label', name: 'label' }]
      }]
    });
    const plan = buildDesignPlan([
      { kind: 'component.add', logicalId: '$label', targetUuid: 'node-label', componentType: 'cc.Button' }
    ], target, { documentEditMode: 'prefab' });

    expect(plan.items).toHaveLength(0);
    expect(plan.unresolved[0]).toMatchObject({ path: '$label' });
  });
});
