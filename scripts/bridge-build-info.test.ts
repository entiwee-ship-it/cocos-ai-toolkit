import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBridgeBuildId } from '../packages/bridge-extension/src/bridge-build-info.js';

const writer = fileURLToPath(new URL('./write-bridge-build-info.mjs', import.meta.url));

describe('Bridge 构建指纹', () => {
  it('只随 Bridge dist JavaScript 内容变化，并可由运行时读取', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'cocos-ai-bridge-build-'));
    try {
      await writeFile(join(dist, 'main.js'), 'module.exports = 1;');
      execFileSync(process.execPath, [writer, dist], { stdio: 'pipe' });
      const first = readBridgeBuildId(dist);
      const firstInfo = JSON.parse(await readFile(join(dist, 'build-info.json'), 'utf8'));
      expect(first).toBe(firstInfo.buildId);
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);

      execFileSync(process.execPath, [writer, dist], { stdio: 'pipe' });
      expect(readBridgeBuildId(dist)).toBe(first);
      await writeFile(join(dist, 'main.js'), 'module.exports = 2;');
      execFileSync(process.execPath, [writer, dist], { stdio: 'pipe' });
      expect(readBridgeBuildId(dist)).not.toBe(first);
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });

  it('构建信息缺失时明确返回 missing', () => {
    expect(readBridgeBuildId('E:/definitely-missing-cocos-ai-bridge-dist')).toBe('missing');
  });
});
