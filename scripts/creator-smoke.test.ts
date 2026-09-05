import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const smokePath = new URL('./run-creator-3.8.8-smoke.mjs', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);

describe('Creator 3.8.8 smoke 合同', () => {
  it('通过当前 MCP 做公开工具发现和 no-op 直写，并保护项目 Git 状态', async () => {
    const smoke = await readFile(smokePath, 'utf8');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:creator']).toContain('run-creator-3.8.8-smoke.mjs');
    expect(packageJson.scripts?.['smoke:creator:write-routing']).toContain('--write-applicability true');
    expect(smoke).not.toContain("'--enable-writes'");
    expect(smoke).toContain("name: 'cocos_editor_list'");
    expect(smoke).toContain('waitForProjectEditor(client, projectPath, 2_000)');
    expect(smoke).toContain("name: 'cocos_hierarchy'");
    expect(smoke).toContain("name: 'cocos_component_add'");
    expect(smoke).toContain("componentType: 'cc.UITransform'");
    expect(smoke).toContain("name: 'cocos_prefab_instantiate'");
    expect(smoke).toContain("name: 'cocos_prefab_unpack'");
    expect(smoke).toContain("name: 'cocos_prefab_open'");
    expect(smoke).toContain("name: 'cocos_node_delete'");
    expect(smoke).toContain("name: 'cocos_node_read'");
    expect(smoke).toContain("name: 'cocos_node_set_transform'");
    expect(smoke).toContain("name: 'cocos_editor_state'");
    expect(smoke).toContain('NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT');
    expect(smoke).toContain('WRITE_APPLICABILITY_REQUIRES_INSTANTIATE_FIXTURE');
    expect(smoke).toContain('prefab-instantiate-reopen');
    expect(smoke).toContain('prefab-instantiate-cleanup');
    expect(smoke).toContain('prefab-unpack-${options.unpackMode}');
    expect(smoke).toContain("'status', '--porcelain=v2', '--branch'");
    expect(smoke).toContain("'diff', '--binary', '--no-ext-diff'");
    expect(smoke).toContain("'diff', '--cached', '--binary', '--no-ext-diff'");
    expect(smoke).toContain("creatorVersion !== '3.8.8'");
    expect(smoke).toContain('unavailable ? 2 : 1');
    expect(smoke).toContain('Connection closed');
    expect(smoke).toContain('gitStatusBefore !== gitStatusAfter');
    expect(smoke.indexOf('class SmokeSkip')).toBeLessThan(smoke.indexOf('let client;'));
  });
});
