import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('@cocos-ai/core package contract', () => {
  it('不再导出已删除的 prefab-graph 模块', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).not.toHaveProperty('./prefab-graph');
  });
});
