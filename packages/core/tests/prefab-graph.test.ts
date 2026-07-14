import { describe, expect, it } from 'vitest';
import {
  buildPrefabGraph,
  buildPrefabGraphFromSnapshots,
  resolveTarget,
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

    expect(resolveTarget(['goods-root', 'button-node'], graph.targetMaps)).toEqual({
      assetUuid: 'button-prefab',
      fileId: 'button-node'
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

    expect(resolveTarget(['goods-root', 'button-node'], graph.targetMaps)).toEqual({
      assetUuid: 'button-prefab',
      fileId: 'button-node'
    });
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

    expect(resolveTargetPath(['goods-root', 'missing-button'], graph.targetMaps)).toEqual({
      target: null,
      localIds: ['goods-root', 'missing-button'],
      failedSegmentIndex: 1
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

  it('使用文档快照的 instanceChain 恢复嵌套实例真实父 Prefab 和深度', () => {
    const graph = buildPrefabGraphFromSnapshots([{
      document: {
        assetUuid: 'page-prefab',
        path: 'db://assets/page.prefab',
        documentType: 'prefab'
      },
      nodes: [],
      prefabInstances: [
        {
          sourcePrefabAssetUuid: 'goods-card-prefab',
          instanceFileId: 'goods-instance',
          sourceObjectFileId: 'goods-root',
          instanceChain: [
            { depth: 0, assetUuid: 'page-prefab', instanceNodeUuid: 'page-root' },
            { depth: 1, assetUuid: 'goods-card-prefab', instanceNodeUuid: 'goods-node' }
          ]
        },
        {
          sourcePrefabAssetUuid: 'button-prefab',
          instanceFileId: 'button-instance',
          sourceObjectFileId: 'button-root',
          instanceChain: [
            { depth: 0, assetUuid: 'page-prefab', instanceNodeUuid: 'page-root' },
            { depth: 1, assetUuid: 'goods-card-prefab', instanceNodeUuid: 'goods-node' },
            { depth: 2, assetUuid: 'button-prefab', instanceNodeUuid: 'button-node' }
          ]
        }
      ]
    }]);

    expect(graph.edges).toContainEqual(expect.objectContaining({
      fromAssetUuid: 'goods-card-prefab',
      toAssetUuid: 'button-prefab',
      depth: 2
    }));
    expect(graph.edges).not.toContainEqual(expect.objectContaining({
      fromAssetUuid: 'page-prefab',
      toAssetUuid: 'button-prefab'
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

  it('不把缺少稳定 FileID 的两个同源实例误合并为一条边', () => {
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
