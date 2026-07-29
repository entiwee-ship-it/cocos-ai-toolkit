import { describe, expect, it } from 'vitest';
import { DesignTargetDocumentSchema, type DesignTargetDocument } from '@cocos-ai/protocol';
import { computeDesignDiff, type DesignCurrentNode } from '../src/design-diff.js';
import { exportDesignDocument, verifyDesignTarget } from '../src/design-export.js';

describe('design-export', () => {
  it('导出稳定逻辑 ID、Prefab 根标注并把节点引用回写为逻辑 ID', () => {
    const current = createCurrentTree();
    const first = exportDesignDocument(current, {
      scope: 'current-document',
      assetUuid: 'scene-1',
      prefabInstances: [{ instanceRootObjectUuid: 'node-button', sourcePrefabAssetUuid: 'prefab-button' }]
    });
    const second = exportDesignDocument(current, {
      scope: 'current-document',
      assetUuid: 'scene-1',
      prefabInstances: [{ instanceRootObjectUuid: 'node-button', sourcePrefabAssetUuid: 'prefab-button' }]
    });

    expect(first).toEqual(second);
    expect(first.tree[0]).toMatchObject({ id: '$node-file-root', fileId: 'file-root' });
    expect(first.tree[0]?.children?.[1]).toMatchObject({
      id: '$node-file-button',
      prefabInstance: { assetUuid: 'prefab-button', name: 'button' }
    });
    expect(first.tree[0]?.children?.[1]?.components?.[0]?.references).toMatchObject({
      'clickEvents[0].target': '$node-file-label'
    });
    expect(() => DesignTargetDocumentSchema.parse(first)).not.toThrow();
  });

  it('导出目标可被差异引擎 round-trip 消费且不产生虚假引用差异', () => {
    const current = createCurrentTree();
    const target = exportDesignDocument(current, {
      scope: 'current-document', assetUuid: 'scene-1',
      prefabInstances: [{ instanceRootObjectUuid: 'node-button', sourcePrefabAssetUuid: 'prefab-button' }]
    });

    expect(computeDesignDiff(current, target.tree, false)).toEqual([]);
  });

  it('导出时省略组件指向所属节点的自引用，但保留跨节点引用', () => {
    const current = createCurrentTree();
    current[0]!.children[1]!.components[0]!.references!.node = {
      kind: 'node', objectUuid: 'node-button', fileId: 'file-button',
      nodePath: 'root/button', available: true
    };

    const target = exportDesignDocument(current, {
      scope: 'current-document', assetUuid: 'scene-1'
    });
    const references = target.tree[0]!.children![1]!.components![0]!.references;

    expect(references).not.toHaveProperty('node');
    expect(references).toMatchObject({
      'clickEvents[0].target': '$node-file-label'
    });
    expect(computeDesignDiff(current, target.tree, false)).toEqual([]);
  });

  it('verify 对节点、属性、引用和覆盖归属逐项报告', () => {
    const current = createCurrentTree();
    const target = exportDesignDocument(current, {
      scope: 'current-document', assetUuid: 'scene-1',
      prefabInstances: [{ instanceRootObjectUuid: 'node-button', sourcePrefabAssetUuid: 'prefab-button' }]
    });

    const passed = verifyDesignTarget(current, target);
    expect(passed.passed).toBe(true);
    expect(passed.items.length).toBeGreaterThan(4);
    expect(passed.items.every((item) => item.passed)).toBe(true);

    const changed = structuredClone(target) as DesignTargetDocument;
    changed.tree[0]!.children![0]!.components![0]!.properties!.text = '已修改';
    const failed = verifyDesignTarget(current, changed);
    expect(failed.passed).toBe(false);
    expect(failed.items).toContainEqual(expect.objectContaining({
      target: '$node-file-label::cc.Label', passed: false, description: expect.stringContaining('text')
    }));
  });

  it('verify 把 Creator uuid 数组与声明式 AssetRef 数组按身份逐项比较', () => {
    const current = createCurrentTree();
    const component = current[0]!.children[0]!.components[0]!;
    component.references = {
      textureFrames: [{ uuid: 'frame-a' }, { uuid: 'frame-b' }]
    };
    const target: DesignTargetDocument = {
      document: { scope: 'current-document', assetUuid: 'scene-1' },
      tree: [{
        id: '$root', fileId: 'file-root', name: 'root',
        children: [{
          id: '$label', fileId: 'file-label', name: 'label',
          components: [{
            type: 'cc.Label',
            references: {
              textureFrames: [
                { kind: 'asset', assetUuid: 'texture-a', subAssetUuid: 'frame-a', assetType: 'cc.SpriteFrame', path: null, available: true },
                { kind: 'asset', assetUuid: 'texture-b', subAssetUuid: 'frame-b', assetType: 'cc.SpriteFrame', path: null, available: true }
              ]
            }
          }]
        }]
      }]
    };

    const report = verifyDesignTarget(current, target);

    expect(report.passed).toBe(true);
    expect(report.items).toContainEqual(expect.objectContaining({
      description: 'reference:textureFrames',
      actual: [{ uuid: 'frame-a' }, { uuid: 'frame-b' }],
      passed: true
    }));
  });

  it('verify 在 prune 开启时报告目标外节点与组件', () => {
    const current = createCurrentTree();
    const target = exportDesignDocument(current);
    target.prune = true;
    current[0]!.components.push({ type: 'cc.UITransform', properties: {} });
    current[0]!.children.push({
      uuid: 'node-extra', fileId: 'file-extra', name: 'extra', path: 'root/extra',
      prefabAssetUuid: null, components: [], children: []
    });

    const report = verifyDesignTarget(current, target);
    expect(report.passed).toBe(false);
    expect(report.items).toContainEqual(expect.objectContaining({
      target: '$node-file-root::cc.UITransform', description: 'unexpected-component', passed: false
    }));
    expect(report.items).toContainEqual(expect.objectContaining({
      description: 'unexpected-node', passed: false
    }));
  });
});

function createCurrentTree(): DesignCurrentNode[] {
  return [{
    uuid: 'node-root', fileId: 'file-root', name: 'root', path: 'root', prefabAssetUuid: null,
    components: [],
    children: [
      {
        uuid: 'node-label', fileId: 'file-label', name: 'label', path: 'root/label', prefabAssetUuid: null,
        components: [{
          uuid: 'component-label', type: 'cc.Label', properties: { text: '标题' },
          references: {}, propertySources: { text: 'local' }
        }], children: []
      },
      {
        uuid: 'node-button', fileId: 'file-button', name: 'button', path: 'root/button',
        prefabAssetUuid: 'prefab-button',
        components: [{
          uuid: 'component-button', type: 'cc.Button', properties: {},
          references: {
            'clickEvents[0].target': {
              kind: 'node', objectUuid: 'node-label', fileId: 'file-label', nodePath: 'root/label', available: true
            }
          }, propertySources: { 'clickEvents[0].target': 'override' }
        }], children: []
      }
    ]
  }];
}
