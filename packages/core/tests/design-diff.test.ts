import { describe, expect, it } from 'vitest';
import { computeDesignDiff, type DesignCurrentNode, type DesignDiffItem } from '../src/design-diff.js';
import type { DesignTargetNode } from '@cocos-ai/protocol';

/** 构造当前状态节点（测试夹具）。 */
function currentNode(overrides: Partial<DesignCurrentNode> = {}): DesignCurrentNode {
  return {
    uuid: 'u-root',
    fileId: null,
    name: 'root',
    path: 'root',
    prefabAssetUuid: null,
    components: [],
    children: [],
    ...overrides
  };
}

/** 构造目标节点（测试夹具）。 */
function targetNode(overrides: Partial<DesignTargetNode> = {}): DesignTargetNode {
  return { id: '$n', name: 'n', ...overrides };
}

describe('computeDesignDiff', () => {
  it('目标树与当前状态一致时零差异', () => {
    const current = [currentNode({
      children: [currentNode({
        uuid: 'u-title', name: 'title', path: 'root/title',
        components: [{ type: 'cc.Label', properties: { string: '确定退出？', fontSize: 28 } }]
      })]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [targetNode({ id: '$title', name: 'title', components: [{ type: 'cc.Label', properties: { string: '确定退出？', fontSize: 28 } }] })]
    })];

    expect(computeDesignDiff(current, tree, false)).toEqual([]);
  });

  it('缺失节点产出 node.create 并关联父逻辑 ID', () => {
    const current = [currentNode()];
    const tree = [targetNode({ id: '$root', name: 'root', children: [targetNode({ id: '$new', name: 'newNode' })] })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({ kind: 'node.create', logicalId: '$new', parentLogicalId: '$root', name: 'newNode' }));
  });

  it('已存在节点属性不同产出属性修改（name-path 匹配）', () => {
    const current = [currentNode({
      children: [currentNode({
        uuid: 'u-title', name: 'title', path: 'root/title',
        components: [{ type: 'cc.Label', properties: { string: '确定退出？', fontSize: 24 } }]
      })]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [targetNode({ id: '$title', name: 'title', components: [{ type: 'cc.Label', properties: { fontSize: 28 } }] })]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({
      kind: 'component.set_property', targetUuid: 'u-title', componentType: 'cc.Label', propertyPath: 'fontSize', value: 28, matchBasis: 'name-path'
    }));
    // string 未声明，不应产出修改
    expect(diff.filter((item) => item.propertyPath === 'string')).toHaveLength(0);
  });

  it('优先按 fileId 匹配，即使名称已变化', () => {
    const current = [currentNode({
      children: [
        currentNode({ uuid: 'u-old', fileId: 'file-wrong', name: 'title', path: 'root/title' }),
        currentNode({ uuid: 'u-renamed', fileId: 'file-title', name: 'renamed-title', path: 'root/renamed-title', components: [{ type: 'cc.Label', properties: { fontSize: 24 } }] })
      ]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [{
        id: '$title', name: 'title', fileId: 'file-title',
        components: [{ type: 'cc.Label', properties: { fontSize: 28 } }]
      } as DesignTargetNode]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({
      kind: 'component.set_property', targetUuid: 'u-renamed', value: 28, matchBasis: 'fileId'
    }));
    expect(diff.some((item) => item.kind === 'node.create' && item.logicalId === '$title')).toBe(false);
  });

  it('同名节点按完整路径回退匹配，避免误改兄弟节点', () => {
    const current = [currentNode({
      children: [
        currentNode({ uuid: 'u-a', name: 'label', path: 'root/a/label', components: [{ type: 'cc.Label', properties: { fontSize: 20 } }] }),
        currentNode({ uuid: 'u-b', name: 'label', path: 'root/b/label', components: [{ type: 'cc.Label', properties: { fontSize: 24 } }] })
      ]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [{
        id: '$label', name: 'label', path: 'root/b/label',
        components: [{ type: 'cc.Label', properties: { fontSize: 28 } }]
      } as DesignTargetNode]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({
      kind: 'component.set_property', targetUuid: 'u-b', value: 28, matchBasis: 'name-path'
    }));
    expect(diff.some((item) => item.targetUuid === 'u-a')).toBe(false);
  });

  it('缺失组件产出 component.add', () => {
    const current = [currentNode({ children: [currentNode({ uuid: 'u-title', name: 'title', path: 'root/title', components: [] })] })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [targetNode({ id: '$title', name: 'title', components: [{ type: 'cc.Label' }] })]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({ kind: 'component.add', targetUuid: 'u-title', componentType: 'cc.Label' }));
  });

  it('新建子树展开组件属性和引用负载', () => {
    const current = [currentNode()];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [{
        id: '$dialog', name: 'dialog',
        components: [{
          type: 'cc.Label',
          properties: { string: '确定退出？', fontSize: 28 },
          references: { 'clickEvents[0].target': '$title' }
        }],
        children: [{ id: '$title', name: 'title' }]
      } as DesignTargetNode]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({
      kind: 'component.add', logicalId: '$dialog', componentType: 'cc.Label',
      properties: { string: '确定退出？', fontSize: 28 },
      references: { 'clickEvents[0].target': '$title' }
    }));
  });

  it('多余节点默认不删除，prune 开启才产出 node.delete', () => {
    const current = [currentNode({ children: [currentNode({ uuid: 'u-extra', name: 'extra', path: 'root/extra' })] })];
    const tree = [targetNode({ id: '$root', name: 'root' })];

    expect(computeDesignDiff(current, tree, false).filter((item) => item.kind === 'node.delete')).toHaveLength(0);
    expect(computeDesignDiff(current, tree, true)).toContainEqual(expect.objectContaining({ kind: 'node.delete', targetUuid: 'u-extra' }));
  });

  it('多余组件默认不拆，prune 开启才产出 component.remove', () => {
    const current = [currentNode({
      children: [currentNode({
        uuid: 'u-title', name: 'title', path: 'root/title',
        components: [{ type: 'cc.Label', properties: {} }, { type: 'cc.Sprite', properties: {} }]
      })]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [targetNode({ id: '$title', name: 'title', components: [{ type: 'cc.Label' }] })]
    })];

    expect(computeDesignDiff(current, tree, false).filter((item) => item.kind === 'component.remove')).toHaveLength(0);
    expect(computeDesignDiff(current, tree, true)).toContainEqual(expect.objectContaining({ kind: 'component.remove', targetUuid: 'u-title', componentType: 'cc.Sprite' }));
  });

  it('缺失预制体实例产出 prefab.instantiate', () => {
    const current = [currentNode()];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [targetNode({ id: '$btn', name: 'okBtn', prefabInstance: { assetUuid: 'asset-btn-1' } })]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({ kind: 'prefab.instantiate', logicalId: '$btn', parentLogicalId: '$root', prefabAssetUuid: 'asset-btn-1' }));
  });

  it('引用接线产出 reference.set 并保留逻辑 ID 占位', () => {
    const current = [currentNode({
      children: [
        currentNode({ uuid: 'u-label', name: 'title', path: 'root/title', components: [{ type: 'cc.Label', properties: {} }] }),
        currentNode({ uuid: 'u-btn', name: 'okBtn', path: 'root/okBtn', components: [{ type: 'cc.Button', properties: { clickEvents: [] } }] })
      ]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [
        targetNode({ id: '$label', name: 'title', components: [{ type: 'cc.Label' }] }),
        targetNode({ id: '$btn', name: 'okBtn', components: [{ type: 'cc.Button' }], references: { 'clickEvents[0].target': '$label' } })
      ]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff).toContainEqual(expect.objectContaining({
      kind: 'reference.set', targetUuid: 'u-btn', propertyPath: 'clickEvents[0].target', reference: '$label'
    }));
  });

  it('引用目标已一致时不重复产出 reference.set', () => {
    const current = [currentNode({
      children: [
        currentNode({ uuid: 'u-label', name: 'title', path: 'root/title' }),
        currentNode({ uuid: 'u-btn', name: 'okBtn', path: 'root/okBtn', references: { 'clickEvents[0].target': '$label' } } as DesignCurrentNode)
      ]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [
        targetNode({ id: '$label', name: 'title' }),
        targetNode({ id: '$btn', name: 'okBtn', references: { 'clickEvents[0].target': '$label' } })
      ]
    })];

    const diff = computeDesignDiff(current, tree, false);
    expect(diff.filter((item) => item.kind === 'reference.set')).toHaveLength(0);
  });

  it('引用数组按逐项身份和顺序比较', () => {
    const assetReference = {
      kind: 'asset' as const,
      assetUuid: 'texture-a',
      subAssetUuid: 'frame-a',
      assetType: 'cc.SpriteFrame',
      path: null,
      available: true
    };
    const current = [currentNode({
      children: [
        currentNode({ uuid: 'u-label', name: 'title', path: 'root/title' }),
        currentNode({
          uuid: 'u-list', name: 'list', path: 'root/list',
          components: [{
            type: 'FrameList', properties: {},
            references: { textureFrames: [assetReference, { kind: 'node', objectUuid: 'u-label' }] }
          }]
        })
      ]
    })];
    const tree = [targetNode({
      id: '$root', name: 'root',
      children: [
        targetNode({ id: '$label', name: 'title' }),
        targetNode({
          id: '$list', name: 'list',
          components: [{ type: 'FrameList', references: { textureFrames: [assetReference, '$label'] } }]
        })
      ]
    })];

    expect(computeDesignDiff(current, tree, false).filter((item) => item.kind === 'reference.set')).toHaveLength(0);
    tree[0].children![1].components![0].references!.textureFrames.reverse();
    expect(computeDesignDiff(current, tree, false)).toContainEqual(expect.objectContaining({
      kind: 'reference.set', propertyPath: 'textureFrames'
    }));
  });
});
