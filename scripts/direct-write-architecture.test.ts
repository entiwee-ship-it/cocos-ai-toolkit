import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

describe('Bridge 安全边界', () => {
  it('正式 Bridge 不注册调试探针', async () => {
    const [main, scene] = await Promise.all([
      read('packages/bridge-extension/src/main.ts'),
      read('packages/bridge-extension/src/scene.ts')
    ]);

    expect(main).not.toMatch(/\bdebug[A-Z]/);
    expect(scene).not.toMatch(/\bdebug[A-Z]/);
  });
});
