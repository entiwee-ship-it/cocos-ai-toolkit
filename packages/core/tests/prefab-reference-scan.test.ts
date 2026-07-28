import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanPrefabReferencesFromDisk } from '../src/prefab-reference-scan.js';
import { analyzePrefabImpact } from '../src/prefab-impact.js';

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function prefabWithNestedInstance(targetUuid: string): string {
  return JSON.stringify([
    { __type__: 'cc.Prefab', data: { __id__: 1 } },
    { __type__: 'cc.Node', _children: [{ __id__: 2 }], _prefab: { __id__: 4 } },
    { __type__: 'cc.Node', _children: [] },
    { __type__: 'cc.PrefabInfo', root: null, asset: null, fileId: 'host' },
    { __type__: 'cc.PrefabInfo', root: null, asset: { __uuid__: targetUuid }, fileId: 'nested' }
  ]);
}

function plainPrefab(): string {
  return JSON.stringify([
    { __type__: 'cc.Prefab', data: { __id__: 1 } },
    { __type__: 'cc.Node', _children: [] }
  ]);
}

function meta(uuid: string): string {
  return JSON.stringify({ uuid });
}

describe('scanPrefabReferencesFromDisk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'prefab-ref-scan-'));
    await mkdir(join(root, 'gui'), { recursive: true });
    await writeFile(join(root, 'gui', 'a.prefab'), plainPrefab());
    await writeFile(join(root, 'gui', 'a.prefab.meta'), meta(UUID_A));
    await writeFile(join(root, 'gui', 'b.prefab'), prefabWithNestedInstance(UUID_A));
    await writeFile(join(root, 'gui', 'b.prefab.meta'), meta(UUID_B));
    await writeFile(join(root, 'gui', 'c.scene'), prefabWithNestedInstance(UUID_B));
    await writeFile(join(root, 'gui', 'c.scene.meta'), meta(UUID_C));
    // 缺 meta 的文档：跳过并告警
    await writeFile(join(root, 'gui', 'no-meta.prefab'), plainPrefab());
    // 坏 JSON 的文档：跳过并告警
    await writeFile(join(root, 'gui', 'broken.prefab'), '{ not json');
    await writeFile(join(root, 'gui', 'broken.prefab.meta'), meta('dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('从磁盘序列化文件构建节点和实例引用边，不在编辑器打开文档', async () => {
    const graph = await scanPrefabReferencesFromDisk(root);

    // 坏 JSON 的文档仍注册为资产节点，只是不产生引用边
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.map((node) => node.assetUuid).sort()).toEqual(
      [UUID_A, UUID_B, UUID_C, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'].sort()
    );
    expect(graph.nodes.find((node) => node.assetUuid === UUID_C)?.documentType).toBe('scene');
    expect(graph.nodes.find((node) => node.assetUuid === UUID_A)?.path).toBe('db://assets/gui/a.prefab');

    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toContainEqual({ fromAssetUuid: UUID_B, toAssetUuid: UUID_A, depth: 0 });
    expect(graph.edges).toContainEqual({ fromAssetUuid: UUID_C, toAssetUuid: UUID_B, depth: 0 });

    const warningCodes = graph.diagnostics.map((item) => item.code);
    expect(warningCodes).toContain('PREFAB_REFERENCE_SCAN_META_MISSING');
    expect(warningCodes).toContain('PREFAB_REFERENCE_SCAN_PARSE_FAILED');
  });

  it('扫描结果可直接驱动影响分析：反查直接容器与传递祖先', async () => {
    const graph = await scanPrefabReferencesFromDisk(root);
    const impact = analyzePrefabImpact(graph, UUID_A, 'db://assets/gui/a.prefab');

    const affected = new Map(impact.affectedDocuments.map((doc) => [doc.assetUuid, doc.instanceCount]));
    expect(affected.get(UUID_B)).toBe(1);
    expect(affected.get(UUID_C)).toBe(1);
    expect(impact.totalInstanceCount).toBe(2);
  });
});
