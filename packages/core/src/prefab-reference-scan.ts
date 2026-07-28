import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrefabImpactGraph } from './prefab-impact.js';

/** 磁盘扫描出的单个文档引用关系。 */
export interface PrefabReferenceScanDiagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  details?: unknown;
}

/**
 * 直接从项目 assets 目录磁盘文件构建 Prefab 引用图，
 * 只读取 .prefab / .scene 序列化文件本身，不在编辑器里打开任何文档。
 *
 * 设计约定：影响分析只需要"谁引用了目标 Prefab"的来源边，
 * 序列化文件里 cc.PrefabInfo.asset.__uuid__ 就是完整的嵌套引用记录，
 * 逐个打开文档做快照属于浪费，按"用哪里就扫哪里"的原则改为磁盘只读扫描。
 *
 * @param assetsRoot 项目 assets 目录绝对路径。
 * @returns 与影响分析兼容的 Prefab 图（nodes + edges）。
 */
export async function scanPrefabReferencesFromDisk(assetsRoot: string): Promise<PrefabImpactGraph & { diagnostics: PrefabReferenceScanDiagnostic[] }> {
  const diagnostics: PrefabReferenceScanDiagnostic[] = [];
  const documentFiles = await collectDocumentFiles(assetsRoot);

  const nodes: PrefabImpactGraph['nodes'] = [];
  const edges: PrefabImpactGraph['edges'] = [];

  for (const file of documentFiles) {
    const metaUuid = await readMetaUuid(`${file}.meta`, diagnostics);
    if (!metaUuid) {
      continue;
    }

    const documentType = file.endsWith('.scene') ? 'scene' as const : 'prefab' as const;
    nodes.push({
      assetUuid: metaUuid,
      path: toAssetUrl(assetsRoot, file),
      documentType
    });

    let documentJson: unknown;
    try {
      documentJson = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      diagnostics.push({
        code: 'PREFAB_REFERENCE_SCAN_PARSE_FAILED',
        message: `文档 ${file} 解析失败，引用扫描跳过该文件`,
        severity: 'warning',
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      continue;
    }

    edges.push(...collectInstanceEdges(metaUuid, documentJson));
  }

  return {
    nodes,
    edges,
    ...(diagnostics.some((item) => item.severity === 'error') ? { blocked: true } : {}),
    diagnostics
  };
}

/** 递归收集 assets 目录下全部 .prefab / .scene 文件。 */
async function collectDocumentFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry);
      const info = await stat(fullPath).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        await walk(fullPath);
      } else if (entry.endsWith('.prefab') || entry.endsWith('.scene')) {
        results.push(fullPath);
      }
    }
  }
  await walk(root);
  return results.sort();
}

/** 读取文档配套 .meta 里的资产 UUID。 */
async function readMetaUuid(metaPath: string, diagnostics: PrefabReferenceScanDiagnostic[]): Promise<string | null> {
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { uuid?: unknown };
    return typeof meta.uuid === 'string' && meta.uuid.length > 0 ? meta.uuid : null;
  } catch {
    diagnostics.push({
      code: 'PREFAB_REFERENCE_SCAN_META_MISSING',
      message: `文档缺少可读的 meta 文件，引用扫描跳过: ${metaPath}`,
      severity: 'warning'
    });
    return null;
  }
}

/** 把绝对文件路径转成 db://assets 相对 URL，供报告展示。 */
function toAssetUrl(assetsRoot: string, file: string): string {
  const normalizedRoot = assetsRoot.replace(/\\/g, '/');
  const normalizedFile = file.replace(/\\/g, '/');
  const relative = normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile;
  return `db://assets/${relative}`;
}

interface SerializedNode {
  __type__?: string;
  _children?: Array<{ __id__: number }>;
  _prefab?: { __id__: number };
}

/**
 * 从单个序列化文档里提取 Prefab 实例引用边。
 * cc.PrefabInfo.asset.__uuid__ 记录了该节点嵌套的源 Prefab 资产；
 * 边的 depth 取实例节点在文档节点树里的深度，供影响分析分层展示。
 *
 * @param hostAssetUuid 宿主文档资产 UUID。
 * @param documentJson 解析后的文档 JSON 数组。
 * @returns 该文档指向其它 Prefab 资产的引用边集合。
 */
function collectInstanceEdges(hostAssetUuid: string, documentJson: unknown): PrefabImpactGraph['edges'] {
  const edges: PrefabImpactGraph['edges'] = [];
  if (!Array.isArray(documentJson)) {
    return edges;
  }

  const items = documentJson as Array<Record<string, unknown>>;
  const nodeDepthById = new Map<number, number>();
  const rootIndex = items.findIndex((item) => item?.__type__ === 'cc.Prefab' || item?.__type__ === 'cc.Scene');
  const rootNodeId = rootIndex >= 0
    ? ((items[rootIndex] as { data?: { __id__?: number } }).data?.__id__ ?? null)
    : null;

  if (rootNodeId !== null) {
    const walk = (nodeId: number, depth: number): void => {
      if (nodeDepthById.has(nodeId)) return;
      nodeDepthById.set(nodeId, depth);
      const node = items[nodeId] as SerializedNode | undefined;
      for (const child of node?._children ?? []) {
        if (typeof child?.__id__ === 'number') {
          walk(child.__id__, depth + 1);
        }
      }
    };
    walk(rootNodeId, 0);
  }

  items.forEach((item, index) => {
    if (item?.__type__ !== 'cc.PrefabInfo') return;
    const asset = item.asset as { __uuid__?: unknown } | undefined;
    const targetUuid = typeof asset?.__uuid__ === 'string' ? asset.__uuid__ : null;
    if (!targetUuid) return;

    // PrefabInfo 挂所属的序列化节点：优先用节点深度，找不到归属节点时按 1 处理
    let depth = 1;
    const ownerNodeIndex = items.findIndex((node) =>
      (node as SerializedNode)?._prefab && (node as SerializedNode)._prefab!.__id__ === index
    );
    if (ownerNodeIndex >= 0 && nodeDepthById.has(ownerNodeIndex)) {
      depth = nodeDepthById.get(ownerNodeIndex)!;
    }

    edges.push({
      fromAssetUuid: hostAssetUuid,
      toAssetUuid: targetUuid,
      depth
    });
  });

  return edges;
}
