import { describe, expect, it } from 'vitest';
import { ProjectScanner } from '../src/project-scanner.js';
import type { ScanCheckpoint } from '../src/scan-checkpoint.js';

describe('ProjectScanner checkpoint gate', () => {
  it('在发送任何 Bridge 请求前拒绝未通过运行时 Schema 的 checkpoint', async () => {
    let requestCount = 0;
    const scanner = new ProjectScanner({
      async request() {
        requestCount += 1;
        throw new Error('REQUEST_MUST_NOT_RUN');
      }
    });
    const checkpoint = {
      version: 1,
      scanId: 'scan-1',
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      projectPath: 'E:/project',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0',
      protocolVersion: '0.3.0',
      parameters: { pageSize: 100, includeRaw: false, concurrency: 2 },
      parametersHash: 'tampered',
      assetManifestHash: 'manifest-1',
      assetUuids: [],
      completedAssetUuids: [],
      failures: [],
      documents: [],
      unresolved: [],
      updatedAt: '2026-07-14T00:00:00.000Z'
    } as unknown as ScanCheckpoint;

    await expect(scanner.scan({
      projectId: 'project-1',
      checkpoint
    })).rejects.toThrow('SCAN_CHECKPOINT_INVALID');
    expect(requestCount).toBe(0);
  });
});
