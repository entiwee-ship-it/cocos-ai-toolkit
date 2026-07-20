import type { PrefabImpactAnalysis, PrefabImpactAffectedDocument } from '@cocos-ai/protocol';

/** 影响分析实际消费的最小 Prefab 图合同，兼容 protocol 的可选扩展字段。 */
export interface PrefabImpactGraph {
  nodes: Array<{
    assetUuid: string;
    path: string | null;
    documentType: 'scene' | 'prefab';
  }>;
  edges: Array<{
    fromAssetUuid: string;
    toAssetUuid: string;
    depth: number;
  }>;
  blocked?: boolean;
}

/**
 * 源预制体影响分析：按 Phase 1 prefab-graph 的实例来源边，
 * 反查源资产的直接容器文档与传递祖先文档，输出协议影响分析报告。
 * 设计规格 8.4：source-prefab / apply-to-source 执行前必须回答
 * “会修改哪个资源、影响多少 Scene/Prefab/实例、有哪些风险”。
 *
 * instanceCount 语义：直接容器为源资产实例数；传递祖先为其内部
 * 会间接受影响的实例数（指向通往源资产路径上的直接子实例边数）。
 *
 * @param graph Phase 1 预制体引用图（含循环诊断）。
 * @param sourceAssetUuid 待分析源资产 UUID。
 * @param sourceAssetPath 待分析源资产路径。
 * @returns 协议 PrefabImpactAnalysisSchema 兼容的影响分析。
 */
export function analyzePrefabImpact(
  graph: PrefabImpactGraph,
  sourceAssetUuid: string,
  sourceAssetPath: string
): PrefabImpactAnalysis {
  const nodeByAsset = new Map(graph.nodes.map((node) => [node.assetUuid, node]));
  const risks: string[] = [];

  // 直接容器：to === source 的边，按宿主文档聚合实例数。
  const directEdges = graph.edges.filter((edge) => edge.toAssetUuid === sourceAssetUuid);
  const instanceCountByAsset = new Map<string, number>();
  for (const edge of directEdges) {
    instanceCountByAsset.set(edge.fromAssetUuid, (instanceCountByAsset.get(edge.fromAssetUuid) ?? 0) + 1);
  }

  // 传递祖先：沿 from→to 反向逐层向上走，统计每层会间接受影响的实例数。
  const visitedLayers: Array<Map<string, number>> = [instanceCountByAsset];
  let frontier = [...instanceCountByAsset.keys()];
  const ancestryPath = new Set<string>([sourceAssetUuid]);
  while (frontier.length > 0) {
    const nextLayer = new Map<string, number>();
    const nextFrontier: string[] = [];
    for (const container of frontier) {
      const parentEdges = graph.edges.filter((edge) => edge.toAssetUuid === container);
      for (const edge of parentEdges) {
        if (edge.fromAssetUuid === sourceAssetUuid || ancestryPath.has(edge.fromAssetUuid)) {
          if (edge.fromAssetUuid === sourceAssetUuid) {
            risks.push(`检测到循环引用：${edge.fromAssetUuid} 与 ${container} 互相嵌套`);
          }
          continue;
        }
        nextLayer.set(edge.fromAssetUuid, (nextLayer.get(edge.fromAssetUuid) ?? 0) + 1);
        nextFrontier.push(edge.fromAssetUuid);
      }
    }
    for (const asset of nextLayer.keys()) {
      ancestryPath.add(asset);
    }
    if (nextLayer.size > 0) {
      visitedLayers.push(nextLayer);
    }
    frontier = [...new Set(nextFrontier)];
  }

  // 循环补充检测：source 出现在自身祖先链上。
  if (graph.edges.some((edge) => edge.fromAssetUuid === sourceAssetUuid && ancestryPath.has(edge.toAssetUuid))) {
    risks.push(`源资产 ${sourceAssetUuid} 处于循环嵌套链上，应用前必须人工确认`);
  }

  const affectedDocuments: PrefabImpactAffectedDocument[] = [];
  const seen = new Map<string, PrefabImpactAffectedDocument>();
  for (const layer of visitedLayers) {
    for (const [assetUuid, count] of layer) {
      const existing = seen.get(assetUuid);
      if (existing) {
        existing.instanceCount = Math.max(existing.instanceCount, count);
        continue;
      }
      const node = nodeByAsset.get(assetUuid);
      const document: PrefabImpactAffectedDocument = {
        assetUuid,
        path: node?.path ?? assetUuid,
        documentType: node?.documentType ?? 'prefab',
        instanceCount: count
      };
      seen.set(assetUuid, document);
      affectedDocuments.push(document);
    }
  }

  const overrideLayers = [...new Set(directEdges.map((edge) => `depth:${edge.depth}`))].sort();
  const totalInstanceCount = affectedDocuments.reduce((sum, document) => sum + document.instanceCount, 0);

  if (affectedDocuments.length === 0 && !nodeByAsset.has(sourceAssetUuid)) {
    risks.push(`源资产 ${sourceAssetUuid} 不在当前 Prefab 图中：无实例引用，也可能资产已不存在`);
  }
  if (graph.blocked) {
    risks.push('Prefab 图存在阻断（循环或解析失败），影响分析可能不完整');
  }

  return {
    sourceAssetUuid,
    sourceAssetPath,
    affectedDocuments,
    totalInstanceCount,
    overrideLayers,
    risks: [...new Set(risks)]
  };
}
