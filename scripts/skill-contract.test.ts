import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const skillPath = new URL('../skills/cocos-ai-toolkit/SKILL.md', import.meta.url);

const EXPECTED_TOOL_NAMES = [
  'cocos_asset_import',
  'cocos_asset_refresh',
  'cocos_asset_search',
  'cocos_component_add',
  'cocos_component_set_property',
  'cocos_editor_list',
  'cocos_hierarchy',
  'cocos_node_create',
  'cocos_node_delete',
  'cocos_node_read',
  'cocos_prefab_create',
  'cocos_prefab_delete',
  'cocos_prefab_open',
  'cocos_prefab_save',
  'cocos_preview_launch',
  'cocos_preview_sessions',
  'cocos_preview_stop',
  'cocos_runtime_capture',
  'cocos_runtime_dispatch_input',
  'cocos_runtime_get_console',
  'cocos_runtime_get_hierarchy',
  'cocos_runtime_inspect_component',
  'cocos_runtime_instantiate_prefab',
  'cocos_runtime_invoke_method',
  'cocos_runtime_run_scenario',
  'cocos_runtime_sample_window',
  'cocos_runtime_watch_property'
];

describe('Cocos AI Toolkit 技能契约', () => {
  it('教授直写档全部二十七个工具，且不含已移除的旧工具', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const names = [...new Set(skill.match(/\bcocos_[a-z0-9_]+\b/g) ?? [])].sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    for (const removed of [
      'cocos_prefab_edit',
      'cocos_prefab_inspect',
      'cocos_prefab_verify',
      'cocos_prefab_search',
      'cocos_asset_create',
      'cocos_asset_move',
      'cocos_asset_write_meta',
      'cocos_asset_delete',
      'cocos_write_prepare',
      'cocos_design_apply'
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('明确禁止手写 Creator JSON，并规定直写纪律与阻塞上报', async () => {
    const skill = await readFile(skillPath, 'utf8');
    expect(skill).toContain('禁止手写或直接编辑 `.prefab`、`.scene`、`.meta` JSON');
    expect(skill).toContain('不得使用 shell、脚本、Edit、Write 或 apply_patch');
    expect(skill).toContain('停下并报告阻塞');
    expect(skill).toContain('直写没有事务和回滚');
    expect(skill).toContain('DIRECT_WRITE_VERIFY_FAILED');
  });

  it('描述覆盖中英文 Prefab 创建、查看、编辑和删除触发词', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const frontmatter = skill.split('---')[1] ?? '';
    for (const trigger of ['create', 'inspect', 'edit', 'delete', '创建', '查看', '编辑', '删除']) {
      expect(frontmatter).toContain(trigger);
    }
  });
});
