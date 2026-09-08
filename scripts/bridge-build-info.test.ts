import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBridgeBuildId } from '../packages/bridge-extension/src/bridge-build-info.js';

const writer = fileURLToPath(new URL('./write-bridge-build-info.mjs', import.meta.url));

describe('Bridge 构建指纹', () => {
  it('随 Bridge JavaScript、原生宿主或 static 内容变化，并可由运行时读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-bridge-build-'));
    const dist = join(root, 'dist');
    const staticRoot = join(root, 'static');
    try {
      await Promise.all([mkdir(join(dist, 'native'), { recursive: true }), mkdir(staticRoot)]);
      await writeFile(join(dist, 'main.js'), 'module.exports = 1;\n');
      await writeFile(join(dist, 'native', 'simulator-embed-host.exe'), Buffer.from([1, 2, 3]));
      await writeFile(join(staticRoot, 'index.html'), '<main>workbench</main>\n');
      execFileSync(process.execPath, [writer, dist, staticRoot], { stdio: 'pipe' });
      const first = readBridgeBuildId(dist);
      const firstInfo = JSON.parse(await readFile(join(dist, 'build-info.json'), 'utf8'));
      expect(first).toBe(firstInfo.buildId);
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);

      await writeFile(join(dist, 'main.js'), 'module.exports = 1;\r\n');
      await writeFile(join(staticRoot, 'index.html'), '<main>workbench</main>\r\n');
      execFileSync(process.execPath, [writer, dist, staticRoot], { stdio: 'pipe' });
      expect(readBridgeBuildId(dist)).toBe(first);

      execFileSync(process.execPath, [writer, dist, staticRoot], { stdio: 'pipe' });
      expect(readBridgeBuildId(dist)).toBe(first);
      await writeFile(join(dist, 'main.js'), 'module.exports = 2;');
      execFileSync(process.execPath, [writer, dist, staticRoot], { stdio: 'pipe' });
      const second = readBridgeBuildId(dist);
      expect(second).not.toBe(first);

      await writeFile(join(staticRoot, 'index.html'), '<main>updated workbench</main>\n');
      execFileSync(process.execPath, [writer, dist, staticRoot], { stdio: 'pipe' });
      const third = readBridgeBuildId(dist);
      expect(third).not.toBe(second);

      await writeFile(join(dist, 'native', 'simulator-embed-host.exe'), Buffer.from([4, 5, 6]));
      execFileSync(process.execPath, [writer, dist, staticRoot], { stdio: 'pipe' });
      expect(readBridgeBuildId(dist)).not.toBe(third);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('构建信息缺失时明确返回 missing', () => {
    expect(readBridgeBuildId('E:/definitely-missing-cocos-ai-bridge-dist')).toBe('missing');
  });
});
