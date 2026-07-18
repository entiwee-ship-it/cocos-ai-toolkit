import { describe, expect, it } from 'vitest';
import type { PrefabGraph } from '../src/prefab-graph.js';
import { analyzePrefabImpact } from '../src/prefab-impact.js';

/**
 * 构造最小 PrefabGraph：节点按 uuid 简写登记，边按 [from, to, depth] 元组展开。
 *
 * @param nodes 文档节点清单。
 * @param edges 实例来源边（from 宿主 → to 源资产）。
 * @returns 供影响分析的最小图对象。
 */
function createGraph(
  nodes: Array<[string, 'scene' | 'prefab']>,
  edges: Array<[string, string, number]>
): PrefabGraph {
  return {
    nodes: nodes.map(([assetUuid, documentType]) => ({
      assetUuid,
      path: `db://assets/${assetUuid}`,
      documentType
    })),
    edges: edges.map(([fromAssetUuid, toAssetUuid, depth]) => ({
      fromAssetUuid,
      toAssetUuid,
      kind: 'prefab-instance' as const,
      hostNodePath: null,
      instanceFileId: `${fromAssetUuid}->${toAssetUuid}`,
      sourceObjectFileId: null,
      depth,
      overrideCount: 0,
      overrideSummary: {
        propertyOverrideCount: 0,
        targetOverrideCount: 0,
        mountedChildrenCount: 0,
        mountedComponentsCount: 0,
        removedComponentsCount: 0
      }
    })),
    targetMaps: { targets: {}, children: {} },
    targetMapsByAsset: {},
    blocked: false,
    diagnostics: []
  };
}

describe('analyzePrefabImpact', () => {
  it('列出直接引用源资产的文档并统计实例数', () => {
    const graph = createGraph(
      [['main.scene', 'scene'], ['card.prefab', 'prefab'], ['button.prefab', 'prefab']],
      [
        ['main.scene', 'button.prefab', 1],
        ['main.scene', 'button.prefab', 1],
        ['card.prefab', 'button.prefab', 1]
      ]
    );

    const impact = analyzePrefabImpact(graph, 'button.prefab', 'db://assets/button.prefab');

    expect(impact.sourceAssetUuid).toBe('button.prefab');
    expect(impact.affectedDocuments).toHaveLength(2);
    const scene = impact.affectedDocuments.find((doc) => doc.assetUuid === 'main.scene');
    const card = impact.affectedDocuments.find((doc) => doc.assetUuid === 'card.prefab');
    expect(scene).toMatchObject({ documentType: 'scene', instanceCount: 2 });
    expect(card).toMatchObject({ documentType: 'prefab', instanceCount: 1 });
    expect(impact.totalInstanceCount).toBe(3);
    expect(impact.risks).toHaveLength(0);
  });

  it('沿嵌套链向上传导：源资产变动影响祖先文档', () => {
    const graph = createGraph(
      [['page.scene', 'scene'], ['card.prefab', 'prefab'], ['button.prefab', 'prefab']],
      [
        ['card.prefab', 'button.prefab', 2],
        ['page.scene', 'card.prefab', 1],
        ['page.scene', 'card.prefab', 1]
      ]
    );

    const impact = analyzePrefabImpact(graph, 'button.prefab', 'db://assets/button.prefab');

    // card 是直接容器（1 个实例）；page.scene 是传递祖先（2 个 card 实例受影响）
    const card = impact.affectedDocuments.find((doc) => doc.assetUuid === 'card.prefab');
    const page = impact.affectedDocuments.find((doc) => doc.assetUuid === 'page.scene');
    expect(card).toMatchObject({ instanceCount: 1 });
    expect(page).toMatchObject({ instanceCount: 2 });
    expect(impact.totalInstanceCount).toBe(3);
  });

  it('循环引用列入风险列表且不递归死循环', () => {
    const graph = createGraph(
      [['a.prefab', 'prefab'], ['b.prefab', 'prefab']],
      [
        ['a.prefab', 'b.prefab', 1],
        ['b.prefab', 'a.prefab', 1]
      ]
    );

    const impact = analyzePrefabImpact(graph, 'a.prefab', 'db://assets/a.prefab');

    expect(impact.risks.some((risk) => risk.includes('循环'))).toBe(true);
  });

  it('源资产不在图中时返回空影响并带风险标注', () => {
    const graph = createGraph([['main.scene', 'scene']], []);

    const impact = analyzePrefabImpact(graph, 'missing.prefab', 'db://assets/missing.prefab');

    expect(impact.affectedDocuments).toHaveLength(0);
    expect(impact.totalInstanceCount).toBe(0);
    expect(impact.risks.length).toBeGreaterThan(0);
  });

  it('覆盖层标注来源受影响边的嵌套深度', () => {
    const graph = createGraph(
      [['page.scene', 'scene'], ['card.prefab', 'prefab'], ['button.prefab', 'prefab']],
      [
        ['card.prefab', 'button.prefab', 3],
        ['page.scene', 'button.prefab', 1]
      ]
    );

    const impact = analyzePrefabImpact(graph, 'button.prefab', 'db://assets/button.prefab');

    expect(impact.overrideLayers).toContain('depth:1');
    expect(impact.overrideLayers).toContain('depth:3');
  });
});
