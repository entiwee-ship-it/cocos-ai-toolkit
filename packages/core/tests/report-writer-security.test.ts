import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonScanReportWriter } from '../src/report-writer.js';
import { createScanCheckpoint } from '../src/scan-checkpoint.js';

describe('JsonScanReportWriter root boundary', () => {
  it('prepare 后父目录被替换成 Junction 时拒绝写到授权根目录外', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-outside-'));
    const parent = join(root, 'safe');
    try {
      await mkdir(parent);
      const writer = new JsonScanReportWriter(
        join(parent, 'report.json'),
        join(parent, 'checkpoint.json'),
        root
      );
      await rm(parent, { recursive: true, force: true });
      await symlink(outside, parent, 'junction');

      await expect(writer.writeCheckpoint(createEmptyCheckpoint())).rejects.toThrow(
        'REPORT_PATH_OUTSIDE_ROOT'
      );
      await expect(readFile(join(outside, 'checkpoint.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('不跟随预置的可预测临时文件符号链接写出授权根目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-outside-'));
    const outsideFile = join(outside, 'checkpoint.json');
    const checkpointPath = join(root, 'checkpoint.json');
    try {
      await writeFile(outsideFile, 'sentinel\n', 'utf8');
      await symlink(
        outsideFile,
        `${checkpointPath}.${process.pid}.tmp`,
        'file'
      );
      const writer = new JsonScanReportWriter(
        join(root, 'report.json'),
        checkpointPath,
        root
      );

      await writer.writeCheckpoint(createEmptyCheckpoint());

      expect(await readFile(outsideFile, 'utf8')).toBe('sentinel\n');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('最终替换失败时清理随机临时文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-writer-root-'));
    const checkpointPath = join(root, 'checkpoint.json');
    try {
      await mkdir(checkpointPath);
      const writer = new JsonScanReportWriter(
        join(root, 'report.json'),
        checkpointPath
      );

      await expect(writer.writeCheckpoint(createEmptyCheckpoint())).rejects.toBeTruthy();

      expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createEmptyCheckpoint() {
  return createScanCheckpoint({
    scanId: 'scan-1',
    context: {
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      projectPath: 'E:/project',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0',
      protocolVersion: '0.3.0',
      parameters: { pageSize: 100, includeRaw: false, concurrency: 2 },
      assetManifestHash: 'manifest-1',
      assetUuids: []
    },
    updatedAt: '2026-07-14T00:00:00.000Z'
  });
}
