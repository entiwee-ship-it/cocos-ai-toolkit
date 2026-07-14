import type {
  AssetRecord,
  DocumentAssetRecord,
  DocumentSnapshot,
  ProjectCoverage,
  ScriptAssetRecord
} from '@cocos-ai/protocol';
import { createEmptyProjectCoverage } from '@cocos-ai/protocol';

/**
 * 聚合资产索引和已完成文档快照的项目级覆盖率。
 *
 * @param input 资产、脚本、文档和成功读取的快照。
 * @returns 不重复计算分页的项目覆盖率。
 */
export function collectProjectCoverage(input: {
  assets: AssetRecord[];
  scripts: ScriptAssetRecord[];
  documents: DocumentAssetRecord[];
  snapshots: DocumentSnapshot[];
}): ProjectCoverage {
  const coverage = createEmptyProjectCoverage({
    assets: { total: input.assets.length, decoded: input.assets.length },
    scripts: { total: input.scripts.length, decoded: input.scripts.length },
    documents: { total: input.documents.length, decoded: input.snapshots.length }
  });

  for (const snapshot of input.snapshots) {
    coverage.nodes = addDecodedCount(coverage.nodes, snapshot.coverage.nodes);
    coverage.components = addDecodedCount(coverage.components, snapshot.coverage.components);
    coverage.properties = addDecodedCount(coverage.properties, snapshot.coverage.properties);
    coverage.references = addResolvedCount(coverage.references, snapshot.coverage.references);
    coverage.prefabInstances = addResolvedCount(
      coverage.prefabInstances,
      snapshot.coverage.prefabInstances
    );
    coverage.overrides = addDecodedCount(coverage.overrides, snapshot.coverage.overrides);
  }

  return coverage;
}

function addDecodedCount(
  current: Record<string, number>,
  incoming: Record<string, number>
): { total: number; decoded: number } {
  return {
    total: current.total + incoming.total,
    decoded: current.decoded + incoming.decoded
  };
}

function addResolvedCount(
  current: Record<string, number>,
  incoming: Record<string, number>
): { total: number; resolved: number } {
  return {
    total: current.total + incoming.total,
    resolved: current.resolved + incoming.resolved
  };
}
