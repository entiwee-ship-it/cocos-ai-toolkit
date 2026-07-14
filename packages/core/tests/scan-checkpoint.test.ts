import { describe, expect, it } from 'vitest';
import * as checkpointModule from '../src/scan-checkpoint.js';

function createCheckpoint() {
  return checkpointModule.createScanCheckpoint({
    scanId: 'scan-1',
    context: {
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      projectPath: 'E:/project',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0',
      protocolVersion: '1.0.0',
      parameters: { pageSize: 100, includeRaw: false, concurrency: 2 },
      assetManifestHash: 'manifest-1',
      assetUuids: []
    },
    updatedAt: '2026-07-14T00:00:00.000Z'
  });
}

function createDocumentSnapshot(options: {
  mode: 'summary' | 'full';
  nextCursor: string | null;
}) {
  return {
    document: {
      assetUuid: 'scene-1',
      path: 'db://assets/Main.scene',
      filePath: 'E:/project/assets/Main.scene',
      documentType: 'scene',
      available: true,
      raw: {}
    },
    revision: 'revision-1',
    mode: options.mode,
    page: { offset: 0, pageSize: 100, totalNodes: 0, nextCursor: options.nextCursor },
    nodes: [],
    componentSchemas: [],
    prefabInstances: [],
    coverage: {
      nodes: { total: 0, decoded: 0 },
      components: { total: 0, decoded: 0 },
      properties: { total: 0, decoded: 0 },
      references: { total: 0, resolved: 0 },
      prefabInstances: { total: 0, resolved: 0 },
      overrides: { total: 0, decoded: 0 }
    },
    unresolved: [],
    diagnostics: []
  };
}

describe('scan checkpoint schema', () => {
  it('导出运行时 Schema 和稳定解析器', () => {
    const runtime = checkpointModule as typeof checkpointModule & {
      ScanCheckpointSchema?: { parse(value: unknown): unknown };
      parseScanCheckpoint?: (value: unknown) => unknown;
    };

    expect(runtime.ScanCheckpointSchema).toBeDefined();
    expect(runtime.parseScanCheckpoint).toBeTypeOf('function');
    if (!runtime.parseScanCheckpoint) return;
    expect(runtime.parseScanCheckpoint(createCheckpoint())).toEqual(createCheckpoint());
  });

  it('拒绝参数指纹与参数正文不一致的 checkpoint', () => {
    const runtime = checkpointModule as typeof checkpointModule & {
      parseScanCheckpoint?: (value: unknown) => unknown;
    };
    expect(runtime.parseScanCheckpoint).toBeTypeOf('function');
    if (!runtime.parseScanCheckpoint) return;

    const checkpoint = createCheckpoint();
    expect(() => runtime.parseScanCheckpoint({
      ...checkpoint,
      parametersHash: 'tampered'
    })).toThrow('SCAN_CHECKPOINT_INVALID');
  });

  it('拒绝没有快照或失败记录却声称已完成的资产', () => {
    const runtime = checkpointModule as typeof checkpointModule & {
      parseScanCheckpoint?: (value: unknown) => unknown;
    };
    expect(runtime.parseScanCheckpoint).toBeTypeOf('function');
    if (!runtime.parseScanCheckpoint) return;

    const checkpoint = createCheckpoint();
    expect(() => runtime.parseScanCheckpoint({
      ...checkpoint,
      assetUuids: ['scene-1'],
      completedAssetUuids: ['scene-1']
    })).toThrow('SCAN_CHECKPOINT_INVALID');
  });

  it('拒绝未标记完成却残留失败记录的资产', () => {
    const runtime = checkpointModule as typeof checkpointModule & {
      parseScanCheckpoint?: (value: unknown) => unknown;
    };
    expect(runtime.parseScanCheckpoint).toBeTypeOf('function');
    if (!runtime.parseScanCheckpoint) return;

    const checkpoint = createCheckpoint();
    expect(() => runtime.parseScanCheckpoint({
      ...checkpoint,
      assetUuids: ['scene-1'],
      failures: [{
        assetUuid: 'scene-1',
        code: 'DOCUMENT_SCAN_FAILED',
        message: '失败'
      }]
    })).toThrow('SCAN_CHECKPOINT_INVALID');
  });

  it('拒绝把 summary 或未完成分页快照作为 completed 证据', () => {
    const runtime = checkpointModule as typeof checkpointModule & {
      parseScanCheckpoint?: (value: unknown) => unknown;
    };
    expect(runtime.parseScanCheckpoint).toBeTypeOf('function');
    if (!runtime.parseScanCheckpoint) return;

    const checkpoint = createCheckpoint();
    expect(() => runtime.parseScanCheckpoint({
      ...checkpoint,
      assetUuids: ['scene-1'],
      completedAssetUuids: ['scene-1'],
      documents: [createDocumentSnapshot({ mode: 'summary', nextCursor: 'next-page' })]
    })).toThrow('SCAN_CHECKPOINT_INVALID');
  });

  it('资产 UUID 集合相同但顺序变化时 checkpoint 仍兼容', () => {
    const checkpoint = checkpointModule.createScanCheckpoint({
      scanId: 'scan-1',
      context: {
        projectId: 'project-1',
        editorInstanceId: 'editor-1',
        projectPath: 'E:/project',
        creatorVersion: '3.8.8',
        bridgeVersion: '0.1.0',
        protocolVersion: '1.0.0',
        parameters: { pageSize: 100, includeRaw: false, concurrency: 2 },
        assetManifestHash: 'manifest-1',
        assetUuids: ['scene-b', 'scene-a']
      },
      updatedAt: '2026-07-14T00:00:00.000Z'
    });

    expect(() => checkpointModule.assertCheckpointCompatible(checkpoint, {
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      projectPath: 'E:/project',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0',
      protocolVersion: '1.0.0',
      parameters: { pageSize: 100, includeRaw: false, concurrency: 2 },
      assetManifestHash: 'manifest-1',
      assetUuids: ['scene-a', 'scene-b']
    })).not.toThrow();
  });

  it('资产 mtime 变化会改变 manifest 指纹', () => {
    const before = checkpointModule.createAssetManifestHash([{
      assetUuid: 'scene-1',
      url: 'db://assets/Main.scene',
      type: 'cc.SceneAsset',
      raw: { mtime: 100 }
    }], []);
    const after = checkpointModule.createAssetManifestHash([{
      assetUuid: 'scene-1',
      url: 'db://assets/Main.scene',
      type: 'cc.SceneAsset',
      raw: { mtime: 101 }
    }], []);

    expect(after).not.toBe(before);
  });
});
