import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('bridge extension manifest', () => {
  it('主进程和 Scene 进程都使用稳定 dist 构建入口', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      main?: string;
      contributions?: { scene?: { script?: string } };
    };

    expect(manifest.main).toBe('./dist/main.js');
    expect(manifest.contributions?.scene?.script).toBe('./dist/scene.js');
  });
});
