import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const skillPath = new URL('../skills/cocos-ai-toolkit/SKILL.md', import.meta.url);

const EXPECTED_TOOL_NAMES = [
  'cocos_asset_create',
  'cocos_asset_delete',
  'cocos_asset_move',
  'cocos_asset_write_meta',
  'cocos_editor_list',
  'cocos_prefab_create',
  'cocos_prefab_delete',
  'cocos_prefab_edit',
  'cocos_prefab_inspect',
  'cocos_prefab_search',
  'cocos_prefab_verify'
];

describe('Cocos AI Toolkit 技能契约', () => {
  it('只教授默认 prefab 档的十一个高层工具', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const names = [...new Set(skill.match(/\bcocos_[a-z0-9_]+\b/g) ?? [])].sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(skill).toContain('`--profile=full`');
    expect(skill).toContain('仅用于排障、事务恢复或运行态取证');
  });

  it('明确禁止手写 Creator JSON，并规定 preview 到 apply 的顺序', async () => {
    const skill = await readFile(skillPath, 'utf8');
    expect(skill).toContain('禁止手写或直接编辑 `.prefab`、`.scene`、`.meta` JSON');
    expect(skill).toContain('不得使用 shell、脚本、Edit、Write 或 apply_patch');
    expect(skill).toContain('先以 `mode: "preview"` 调用');
    expect(skill).toContain('再以 `mode: "apply"` 调用');
    expect(skill).toContain('停下并报告阻塞');
  });

  it('描述覆盖中英文 Prefab 创建、查看、编辑和删除触发词', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const frontmatter = skill.split('---')[1] ?? '';
    for (const trigger of ['create', 'inspect', 'edit', 'delete', '创建', '查看', '编辑', '删除']) {
      expect(frontmatter).toContain(trigger);
    }
  });
});
