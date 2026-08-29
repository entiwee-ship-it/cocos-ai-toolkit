import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('TypeScript project references', () => {
  it('根构建按引用图编排并保留 Bridge build id', async () => {
    const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const solution = JSON.parse(await readFile(new URL('tsconfig.json', root), 'utf8')) as {
      references?: Array<{ path: string }>;
    };

    expect(packageJson.scripts?.build).toContain('tsc -b');
    expect(packageJson.scripts?.build).toContain('--force');
    expect(packageJson.scripts?.build).toContain('write-bridge-build-info.mjs');
    expect(packageJson.scripts?.typecheck).toBe('tsc -b --pretty false');
    expect(solution.references?.map((item) => item.path)).toEqual([
      'packages/protocol',
      'packages/client',
      'packages/core',
      'packages/cli',
      'packages/mcp-server',
      'packages/probe-server',
      'packages/bridge-extension'
    ]);
  });

  it('CLI 和 MCP 只声明实际使用的共享包', async () => {
    for (const packageRoot of ['packages/cli', 'packages/mcp-server']) {
      const manifest = JSON.parse(await readFile(new URL(`${packageRoot}/package.json`, root), 'utf8')) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const tsconfig = JSON.parse(await readFile(new URL(`${packageRoot}/tsconfig.json`, root), 'utf8')) as {
        references?: Array<{ path: string }>;
      };
      expect(manifest.scripts?.prebuild, packageRoot).toBeUndefined();
      expect(manifest.scripts?.pretypecheck, packageRoot).toBeUndefined();
      expect(manifest.dependencies?.['@cocos-ai/core'], packageRoot).toBeUndefined();
      expect(tsconfig.references?.map((item) => item.path), packageRoot).not.toContain('../core');
    }
  });
});
