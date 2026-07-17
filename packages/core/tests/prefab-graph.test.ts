import { describe, expect, it } from 'vitest';
import {
  buildPrefabGraph,
  buildPrefabGraphFromSnapshots,
  resolveGraphTargetPath,
  resolveTargetPath
} from '../src/prefab-graph.js';

describe('prefab graph', () => {
  it('记录三层嵌套 Prefab 的实例来源边、深度和 Override 摘要', () => {
    const graph = buildPrefabGraph([
      {
        assetUuid: 'page-prefab',
        path: 'db://assets/page.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'page-root', nodePath: 'Page' }],
        instances: [{
          sourceAssetUuid: 'goods-card-prefab',
          instanceFileId: 'goods-instance',
          sourceObjectFileId: 'goods-root',
          hostNodePath: 'Page/Goods',
          propertyOverrides: [{ propertyPath: ['title'], targetLocalIds: ['goods-root'] }],
          nestedInstances: [{
            sourceAssetUuid: 'button-prefab',
            instanceFileId: 'button-instance',
            sourceObjectFileId: 'button-node',
            hostNodePath: 'Page/Goods/Button',
            propertyOverrides: [{ propertyPath: ['label'], targetLocalIds: ['button-node'] }]
          }]
        }]
      },
      {
        assetUuid: 'goods-card-prefab',
        path: 'db://assets/goods-card.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'goods-root', nodePath: 'Goods' }]
      },
      {
        assetUuid: 'button-prefab',
        path: 'db://assets/button.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'button-node', nodePath: 'Button' }]
      }
    ]);

    expect(graph.edges).toContainEqual(expect.objectContaining({
      fromAssetUuid: 'page-prefab',
      toAssetUuid: 'goods-card-prefab',
      kind: 'prefab-instance',
      depth: 1,
      overrideSummary: expect.objectContaining({ propertyOverrideCount: 1 })
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      fromAssetUuid: 'goods-card-prefab',
      toAssetUuid: 'button-prefab',
      kind: 'prefab-instance',
      depth: 2
    }));
  });

  it('逐层解析多段 localID，不把嵌套目标误解析到外层', () => {
    const graph = buildPrefabGraph([
      {
        assetUuid: 'page-prefab',
        path: 'db://assets/page.prefab',
        documentType: 'prefab',
        instances: [{
          sourceAssetUuid: 'goods-card-prefab',
          instanceFileId: 'goods-instance',
          sourceObjectFileId: 'goods-root',
          nestedInstances: [{
            sourceAssetUuid: 'button-prefab',
            instanceFileId: 'button-instance',
            sourceObjectFileId: 'button-node'
          }]
        }]
      },
      {
        assetUuid: 'goods-card-prefab',
        path: 'db://assets/goods-card.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'goods-root', nodePath: 'Goods' }]
      },
      {
        assetUuid: 'button-prefab',
        path: 'db://assets/button.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'button-node', nodePath: 'Button' }]
      }
    ]);

    expect(resolveGraphTargetPath(
      'goods-card-prefab',
      ['button-instance', 'button-node'],
      graph
    )).toEqual({
      target: {
        assetUuid: 'button-prefab',
        fileId: 'button-node'
      },
      localIds: ['button-instance', 'button-node'],
      failedSegmentIndex: null
    });
  });

  it('把分散在不同 Prefab 文档中的嵌套实例连接到同一条 localID 路径', () => {
    const graph = buildPrefabGraph([
      {
        assetUuid: 'page-prefab',
        path: 'db://assets/page.prefab',
        documentType: 'prefab',
        instances: [{
          sourceAssetUuid: 'goods-card-prefab',
          instanceFileId: 'goods-instance',
          sourceObjectFileId: 'goods-root'
        }]
      },
      {
        assetUuid: 'goods-card-prefab',
        path: 'db://assets/goods-card.prefab',
        documentType: 'prefab',
        instances: [{
          sourceAssetUuid: 'button-prefab',
          instanceFileId: 'button-instance',
          sourceObjectFileId: 'button-node'
        }]
      },
      {
        assetUuid: 'button-prefab',
        path: 'db://assets/button.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'button-node', nodePath: 'Button' }]
      }
    ]);

    expect(resolveGraphTargetPath(
      'goods-card-prefab',
      ['button-instance', 'button-node'],
      graph
    )).toEqual({
      target: {
        assetUuid: 'button-prefab',
        fileId: 'button-node'
      },
      localIds: ['button-instance', 'button-node'],
      failedSegmentIndex: null
    });
  });

  it('把实例 FileID 作为嵌套跳转，不与源对象 FileID 的直接目标冲突', () => {
    const graph = buildPrefabGraph([
      {
        assetUuid: 'player-info-prefab',
        path: 'db://assets/player-info.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'source-root', nodePath: 'PlayerInfo/Interactive' }],
        instances: [{
          sourceAssetUuid: 'interactive-prefab',
          instanceFileId: 'interactive-instance',
          sourceObjectFileId: 'source-root',
          hostNodePath: 'PlayerInfo/Interactive'
        }]
      },
      {
        assetUuid: 'interactive-prefab',
        path: 'db://assets/interactive.prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'target-node', nodePath: 'Interactive/Target' }]
      }
    ]);

    expect(graph.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'PREFAB_TARGET_MAP_COLLISION'
    }));
    expect(graph.targetMapsByAsset['player-info-prefab'].targets['source-root']).toMatchObject({
      assetUuid: 'player-info-prefab',
      fileId: 'source-root'
    });
    expect(resolveGraphTargetPath(
      'player-info-prefab',
      ['interactive-instance', 'target-node'],
      graph
    )).toEqual({
      target: { assetUuid: 'interactive-prefab', fileId: 'target-node' },
      localIds: ['interactive-instance', 'target-node'],
      failedSegmentIndex: null
    });
  });

  it('把嵌套 TargetMap 冲突归属到实际源 Prefab', () => {
    const graph = buildPrefabGraph([{
      assetUuid: 'page-prefab',
      documentType: 'prefab',
      instances: [{
        sourceAssetUuid: 'goods-card-prefab',
        instanceFileId: 'goods-instance',
        nestedInstances: [
          {
            sourceAssetUuid: 'button-a-prefab',
            instanceFileId: 'shared-button-instance',
            sourceObjectFileId: 'button-a-root'
          },
          {
            sourceAssetUuid: 'button-b-prefab',
            instanceFileId: 'shared-button-instance',
            sourceObjectFileId: 'button-b-root'
          }
        ]
      }]
    }]);

    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PREFAB_TARGET_MAP_COLLISION',
      message: 'Prefab localID shared-button-instance 在 goods-card-prefab 中映射冲突'
    }));
  });

  it('多段 localID 缺失时保留完整输入和失败段索引', () => {
    const graph = buildPrefabGraph([{
      assetUuid: 'page-prefab',
      path: 'db://assets/page.prefab',
      documentType: 'prefab',
      instances: [{
        sourceAssetUuid: 'goods-card-prefab',
        instanceFileId: 'goods-instance',
        sourceObjectFileId: 'goods-root'
      }]
    }]);

    expect(resolveGraphTargetPath(
      'page-prefab',
      ['goods-root', 'missing-button'],
      graph
    )).toEqual({
      target: null,
      localIds: ['goods-root', 'missing-button'],
      failedSegmentIndex: 1
    });
  });

  it('按资产保留直接 FileID 索引，不把共享源 Prefab 复制到每个实例路径', () => {
    const sourceTargets = Array.from({ length: 100 }, (_, index) => ({
      fileId: `source-target-${index}`,
      nodePath: `Source/Target${index}`
    }));
    const instances = Array.from({ length: 100 }, (_, index) => ({
      sourceAssetUuid: 'shared-source-prefab',
      instanceFileId: `shared-instance-${index}`,
      sourceObjectFileId: 'shared-source-root'
    }));
    const graph = buildPrefabGraph([
      {
        assetUuid: 'host-prefab',
        path: 'db://assets/host.prefab',
        documentType: 'prefab',
        instances
      },
      {
        assetUuid: 'shared-source-prefab',
        path: 'db://assets/shared-source.prefab',
        documentType: 'prefab',
        targets: [
          { fileId: 'shared-source-root', nodePath: 'Source' },
          ...sourceTargets
        ]
      }
    ]);

    expect(Object.values(graph.targetMapsByAsset['host-prefab'].children).every(
      (childMap) => Object.keys(childMap.targets).length === 0
    )).toBe(true);
    expect(resolveGraphTargetPath(
      'host-prefab',
      ['shared-instance-99', 'source-target-99'],
      graph
    )).toEqual({
      target: {
        assetUuid: 'shared-source-prefab',
        fileId: 'source-target-99'
      },
      localIds: ['shared-instance-99', 'source-target-99'],
      failedSegmentIndex: null
    });
  });

  it('当前段存在但下一层 TargetMap 缺失时报告下一段索引', () => {
    expect(resolveTargetPath(['outer-root', 'inner-root'], {
      targets: {
        'outer-root': {
          assetUuid: 'outer-prefab',
          fileId: 'outer-root',
          nodePath: null
        }
      },
      children: {}
    })).toEqual({
      target: null,
      localIds: ['outer-root', 'inner-root'],
      failedSegmentIndex: 1
    });
  });

  it('直接从 Creator 文档快照建立来源边和节点 FileID TargetMap', () => {
    const graph = buildPrefabGraphFromSnapshots([
      {
        document: {
          assetUuid: 'page-prefab',
          path: 'db://assets/page.prefab',
          documentType: 'prefab'
        },
        nodes: [{ identity: { fileId: 'page-root' }, path: 'Page' }],
        prefabInstances: [{
          sourcePrefabAssetUuid: 'goods-card-prefab',
          instanceFileId: 'goods-instance',
          sourceObjectFileId: 'goods-root',
          hostNodePath: 'Page/Goods',
          propertyOverrides: [],
          targetOverrides: [],
          mountedChildren: [],
          mountedComponents: [],
          removedComponents: []
        }]
      },
      {
        document: {
          assetUuid: 'goods-card-prefab',
          path: 'db://assets/goods-card.prefab',
          documentType: 'prefab'
        },
        nodes: [{ identity: { fileId: 'goods-root' }, path: 'Goods' }],
        componentSchemas: [{ componentFileId: 'goods-label-component', nodePath: 'Goods/Label' }],
        prefabInstances: []
      }
    ]);

    expect(graph.edges).toContainEqual(expect.objectContaining({
      fromAssetUuid: 'page-prefab',
      toAssetUuid: 'goods-card-prefab',
      instanceFileId: 'goods-instance',
      sourceObjectFileId: 'goods-root'
    }));
    expect(graph.targetMapsByAsset['goods-card-prefab'].targets['goods-root']).toMatchObject({
      assetUuid: 'goods-card-prefab',
      fileId: 'goods-root'
    });
    expect(graph.targetMapsByAsset['goods-card-prefab'].targets['goods-label-component']).toMatchObject({
      assetUuid: 'goods-card-prefab',
      fileId: 'goods-label-component'
    });
  });

  it('把上下文嵌套实例归属当前扫描文档，不污染共享源 Prefab', () => {
    const graph = buildPrefabGraphFromSnapshots([
      {
        document: {
          assetUuid: 'game-a-prefab',
          path: 'db://assets/game-a.prefab',
          documentType: 'prefab'
        },
        prefabInstances: [{
          sourcePrefabAssetUuid: 'rank-a-prefab',
          instanceFileId: 'shared-rank-instance',
          sourceObjectFileId: 'rank-root',
          hostNodePath: 'GameA/PlayerNode/Rank',
          instanceChain: [
            { depth: 0, assetUuid: 'game-a-prefab' },
            { depth: 1, assetUuid: 'player-node-prefab' },
            { depth: 2, assetUuid: 'rank-a-prefab' }
          ]
        }]
      },
      {
        document: {
          assetUuid: 'game-b-prefab',
          path: 'db://assets/game-b.prefab',
          documentType: 'prefab'
        },
        prefabInstances: [{
          sourcePrefabAssetUuid: 'rank-b-prefab',
          instanceFileId: 'shared-rank-instance',
          sourceObjectFileId: 'rank-root',
          hostNodePath: 'GameB/PlayerNode/Rank',
          instanceChain: [
            { depth: 0, assetUuid: 'game-b-prefab' },
            { depth: 1, assetUuid: 'player-node-prefab' },
            { depth: 2, assetUuid: 'rank-b-prefab' }
          ]
        }]
      },
      {
        document: {
          assetUuid: 'player-node-prefab',
          path: 'db://assets/player-node.prefab',
          documentType: 'prefab'
        },
        prefabInstances: []
      }
    ]);

    expect(graph.edges).toContainEqual(expect.objectContaining({
      fromAssetUuid: 'game-a-prefab',
      toAssetUuid: 'rank-a-prefab',
      depth: 2
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      fromAssetUuid: 'game-b-prefab',
      toAssetUuid: 'rank-b-prefab',
      depth: 2
    }));
    expect(graph.edges).not.toContainEqual(expect.objectContaining({
      fromAssetUuid: 'player-node-prefab'
    }));
    expect(graph.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'PREFAB_TARGET_MAP_COLLISION'
    }));
  });

  it('缺少 PrefabInstance FileID 时保留诊断但不创建伪边或伪循环', () => {
    const graph = buildPrefabGraphFromSnapshots([
      {
        document: {
          assetUuid: 'player-node-prefab',
          path: 'db://assets/player-node.prefab',
          documentType: 'prefab'
        },
        prefabInstances: [{
          sourcePrefabAssetUuid: 'player-info-prefab',
          instanceFileId: 'player-info-instance',
          sourceObjectFileId: 'player-info-root'
        }]
      },
      {
        document: {
          assetUuid: 'player-info-prefab',
          path: 'db://assets/player-info.prefab',
          documentType: 'prefab'
        },
        prefabInstances: [{
          sourcePrefabAssetUuid: 'player-node-prefab',
          instanceFileId: null,
          sourceObjectFileId: 'member-node',
          hostNodePath: 'PlayerInfo/MemberNode'
        }]
      }
    ]);

    expect(graph.edges).toEqual([
      expect.objectContaining({
        fromAssetUuid: 'player-node-prefab',
        toAssetUuid: 'player-info-prefab'
      })
    ]);
    expect(graph.blocked).toBe(false);
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PREFAB_INSTANCE_FILE_ID_MISSING',
      severity: 'warning'
    }));
    expect(graph.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'PREFAB_GRAPH_CYCLE'
    }));
  });

  it('汇总 Override localID 解析率并报告准确失败段', () => {
    const graph = buildPrefabGraph([
      {
        assetUuid: 'page-prefab',
        documentType: 'prefab',
        instances: [{
          sourceAssetUuid: 'player-info-prefab',
          instanceFileId: 'player-info-instance',
          sourceObjectFileId: 'player-info-root',
          propertyOverrides: [
            { targetLocalIds: ['interactive-instance', 'target-node'] },
            { targetLocalIds: ['interactive-instance', 'missing-node'] }
          ]
        }]
      },
      {
        assetUuid: 'player-info-prefab',
        documentType: 'prefab',
        instances: [{
          sourceAssetUuid: 'interactive-prefab',
          instanceFileId: 'interactive-instance',
          sourceObjectFileId: 'interactive-root'
        }]
      },
      {
        assetUuid: 'interactive-prefab',
        documentType: 'prefab',
        targets: [{ fileId: 'target-node', nodePath: 'Interactive/Target' }]
      }
    ]);

    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PREFAB_TARGET_LOCAL_ID_RESOLUTION_SUMMARY',
      severity: 'info',
      details: {
        total: 2,
        singleSegment: 0,
        multiSegment: 2,
        resolved: 1,
        failed: 1
      }
    }));
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PREFAB_TARGET_LOCAL_ID_UNRESOLVED',
      severity: 'warning',
      details: expect.objectContaining({
        localIds: ['interactive-instance', 'missing-node'],
        failedSegmentIndex: 1
      })
    }));
  });

  it('合并同一文档的多个分页快照，不覆盖较早页面的 FileID', () => {
    const graph = buildPrefabGraphFromSnapshots([
      {
        document: {
          assetUuid: 'page-prefab',
          path: 'db://assets/page.prefab',
          documentType: 'prefab'
        },
        nodes: [{ identity: { fileId: 'page-root' }, path: 'Page' }],
        prefabInstances: []
      },
      {
        document: {
          assetUuid: 'page-prefab',
          path: 'db://assets/page.prefab',
          documentType: 'prefab'
        },
        nodes: [{ identity: { fileId: 'page-child' }, path: 'Page/Child' }],
        prefabInstances: []
      }
    ]);

    expect(graph.targetMapsByAsset['page-prefab'].targets).toMatchObject({
      'page-root': { assetUuid: 'page-prefab', fileId: 'page-root' },
      'page-child': { assetUuid: 'page-prefab', fileId: 'page-child' }
    });
  });

  it('缺少稳定 FileID 的同源记录分别诊断且不进入引用图', () => {
    const graph = buildPrefabGraphFromSnapshots([{
      document: {
        assetUuid: 'page-prefab',
        path: 'db://assets/page.prefab',
        documentType: 'prefab'
      },
      prefabInstances: [
        {
          sourcePrefabAssetUuid: 'goods-card-prefab',
          instanceRootObjectUuid: 'runtime-instance-a'
        },
        {
          sourcePrefabAssetUuid: 'goods-card-prefab',
          instanceRootObjectUuid: 'runtime-instance-b'
        }
      ]
    }]);

    expect(graph.edges.filter((edge) =>
      edge.fromAssetUuid === 'page-prefab'
      && edge.toAssetUuid === 'goods-card-prefab'
    )).toHaveLength(0);
    expect(graph.diagnostics.filter((diagnostic) =>
      diagnostic.code === 'PREFAB_INSTANCE_FILE_ID_MISSING'
    )).toHaveLength(2);
  });

  it('把 Prefab 循环引用标记为阻断诊断', () => {
    const graph = buildPrefabGraph([
      {
        assetUuid: 'a-prefab',
        path: 'db://assets/a.prefab',
        documentType: 'prefab',
        instances: [{
          sourceAssetUuid: 'b-prefab',
          instanceFileId: 'b-instance',
          sourceObjectFileId: 'b-root'
        }]
      },
      {
        assetUuid: 'b-prefab',
        path: 'db://assets/b.prefab',
        documentType: 'prefab',
        instances: [{
          sourceAssetUuid: 'a-prefab',
          instanceFileId: 'a-instance',
          sourceObjectFileId: 'a-root'
        }]
      }
    ]);

    expect(graph.blocked).toBe(true);
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PREFAB_GRAPH_CYCLE',
      severity: 'error'
    }));
  });
});
