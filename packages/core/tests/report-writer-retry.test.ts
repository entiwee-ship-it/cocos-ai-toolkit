import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renameControl = vi.hoisted(() => ({
  failureCodes: [] as string[],
  callCount: 0,
  errors: [] as Array<Error & { code: string }>
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      renameControl.callCount += 1;
      const code = renameControl.failureCodes.shift();
      if (code) {
        const error = Object.assign(new Error(`rename failed: ${code}`), { code });
        renameControl.errors.push(error);
        throw error;
      }
      await actual.rename(oldPath, newPath);
    }
  };
});

import { JsonScanReportWriter } from '../src/report-writer.js';
import type { ScanCheckpoint } from '../src/scan-checkpoint.js';

afterEach(() => {
  vi.useRealTimers();
  renameControl.failureCodes = [];
  renameControl.callCount = 0;
  renameControl.errors = [];
});

describe('JsonScanReportWriter Windows 原子替换', () => {
  it('遇到短时 EPERM 文件锁时有限重试并保留最新 checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-retry-'));
    const checkpointPath = join(directory, 'checkpoint.json');
    const writer = new JsonScanReportWriter(join(directory, 'report.json'), checkpointPath);
    const checkpoint = createCheckpoint();
    renameControl.failureCodes = ['EPERM', 'EPERM'];

    try {
      await writer.writeCheckpoint(checkpoint);

      expect(renameControl.callCount).toBe(3);
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        scanId: checkpoint.scanId,
        completedAssetUuids: checkpoint.completedAssetUuids
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['EACCES', 'EBUSY'])('同样重试短时 %s 文件锁', async (code) => {
    const directory = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-retry-'));
    const checkpointPath = join(directory, 'checkpoint.json');
    const writer = new JsonScanReportWriter(join(directory, 'report.json'), checkpointPath);
    renameControl.failureCodes = [code];

    try {
      await writer.writeCheckpoint(createCheckpoint());

      expect(renameControl.callCount).toBe(2);
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        scanId: 'retry-scan'
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('非文件锁错误立即失败且清理临时文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-retry-'));
    const checkpointPath = join(directory, 'checkpoint.json');
    const writer = new JsonScanReportWriter(join(directory, 'report.json'), checkpointPath);
    renameControl.failureCodes = ['ENOSPC'];

    try {
      await expect(writer.writeCheckpoint(createCheckpoint())).rejects.toMatchObject({
        code: 'ENOSPC'
      });
      expect(renameControl.callCount).toBe(1);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('重试耗尽后保留原错误、旧 checkpoint 和目录原子性', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-retry-'));
    const checkpointPath = join(directory, 'checkpoint.json');
    const writer = new JsonScanReportWriter(join(directory, 'report.json'), checkpointPath);
    const firstCheckpoint = createCheckpoint();
    const nextCheckpoint = {
      ...firstCheckpoint,
      completedAssetUuids: ['scene-a', 'prefab-b'],
      updatedAt: '2026-07-15T12:02:00.000Z'
    };

    try {
      await writer.writeCheckpoint(firstCheckpoint);
      renameControl.callCount = 0;
      renameControl.errors = [];
      renameControl.failureCodes = Array.from({ length: 10 }, () => 'EPERM');

      const error = await writer.writeCheckpoint(nextCheckpoint).catch(
        (writeError: unknown) => writeError
      );

      expect(error).toBe(renameControl.errors.at(-1));
      expect(renameControl.callCount).toBe(10);
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        completedAssetUuids: ['scene-a']
      });
      expect(await readdir(directory)).toEqual(['checkpoint.json']);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * 创建报告写入器可直接持久化的最小 checkpoint。
 *
 * @returns 用于原子替换回归测试的扫描 checkpoint。
 */
function createCheckpoint(): ScanCheckpoint {
  return {
    scanId: 'retry-scan',
    projectId: 'project-1',
    editorInstanceId: 'editor-1',
    creatorVersion: '3.8.8',
    bridgeVersion: '0.1.0',
    protocolVersion: '0.5.0',
    assetManifestHash: 'manifest-hash',
    assetUuids: ['scene-a'],
    parameters: {
      pageSize: 500,
      includeRaw: true,
      concurrency: 1
    },
    completedAssetUuids: ['scene-a'],
    failures: [],
    documents: [],
    startedAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:01:00.000Z'
  };
}
