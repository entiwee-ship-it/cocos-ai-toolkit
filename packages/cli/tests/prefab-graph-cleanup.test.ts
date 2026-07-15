import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCommand } from '../src/commands.js';

const { removeDirectoryMock } = vi.hoisted(() => ({
  removeDirectoryMock: vi.fn()
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rm: removeDirectoryMock };
});

import { executePrefabGraph } from '../src/index.js';

describe('executePrefabGraph cleanup', () => {
  beforeEach(() => {
    removeDirectoryMock.mockReset();
  });

  it('扫描和清理同时失败时保留原始扫描错误', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const parent = await actual.mkdtemp(join(tmpdir(), 'cocos-ai-prefab-cleanup-'));
    removeDirectoryMock.mockRejectedValueOnce(new Error('TEMP_CLEANUP_FAILED'));
    try {
      await expect(executePrefabGraph(
        parseCommand(['prefab-graph', '--project-id', 'project-1']),
        {
          async request(method) {
            if (method === 'server.editors') throw new Error('SERVER_CONNECTION_CLOSED');
            throw new Error(`UNEXPECTED_METHOD:${method}`);
          }
        },
        parent
      )).rejects.toThrow('SERVER_CONNECTION_CLOSED');
      expect(removeDirectoryMock).toHaveBeenCalledTimes(1);
    } finally {
      await actual.rm(parent, { recursive: true, force: true });
    }
  });
});
