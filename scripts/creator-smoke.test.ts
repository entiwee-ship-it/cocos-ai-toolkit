import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const smokePath = new URL('./run-creator-3.8.8-smoke.mjs', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);

describe('Creator 3.8.8 smoke 合同', () => {
  it('通过当前 MCP 做只读发现和 no-op 直写，并保护项目 Git 状态', async () => {
    const smoke = await readFile(smokePath, 'utf8');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:creator']).toContain('run-creator-3.8.8-smoke.mjs');
    expect(smoke).toContain("'--enable-writes'");
    expect(smoke).toContain("name: 'cocos_editor_list'");
    expect(smoke).toContain("name: 'cocos_hierarchy'");
    expect(smoke).toContain("name: 'cocos_component_add'");
    expect(smoke).toContain("componentType: 'cc.UITransform'");
    expect(smoke).toContain("'status', '--porcelain=v2', '--branch'");
    expect(smoke).toContain("creatorVersion !== '3.8.8'");
    expect(smoke).toContain('unavailable ? 2 : 1');
    expect(smoke).toContain('Connection closed');
    expect(smoke).toContain('gitStatusBefore !== gitStatusAfter');
    expect(smoke.indexOf('class SmokeSkip')).toBeLessThan(smoke.indexOf('let client;'));
  });
});
