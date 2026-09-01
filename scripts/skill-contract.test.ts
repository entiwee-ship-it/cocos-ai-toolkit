import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const skillPath = new URL('../skills/cocos-ai-toolkit/SKILL.md', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

const EXPECTED_TOOL_NAMES = [
  'cocos_asset_import',
  'cocos_asset_inspect',
  'cocos_asset_refresh',
  'cocos_asset_search',
  'cocos_batch_write',
  'cocos_component_add',
  'cocos_component_set_property',
  'cocos_document_save',
  'cocos_editor_list',
  'cocos_editor_state',
  'cocos_extension_manager_open',
  'cocos_hierarchy',
  'cocos_node_create',
  'cocos_node_delete',
  'cocos_node_read',
  'cocos_node_rename',
  'cocos_node_reparent',
  'cocos_node_select',
  'cocos_node_set_transform',
  'cocos_nodes_read',
  'cocos_prefab_create',
  'cocos_prefab_delete',
  'cocos_prefab_instantiate',
  'cocos_prefab_open',
  'cocos_prefab_rename',
  'cocos_prefab_unpack',
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
  'cocos_runtime_watch_property',
  'cocos_scene_open'
];

describe('Cocos AI Toolkit 技能契约', () => {
  it('教授当前直写档全部四十个工具', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const names = [...new Set(skill.match(/\bcocos_[a-z0-9_]+\b/g) ?? [])].sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('只强制 Creator 删除 Prefab，并允许普通资源直接删除', async () => {
    const [skill, readme] = await Promise.all([
      readFile(skillPath, 'utf8'),
      readFile(readmePath, 'utf8')
    ]);
    expect(skill).toContain('禁止手写或直接编辑 `.prefab`、`.scene`、`.meta` JSON');
    expect(skill).toContain('删除边界：只有 `.prefab` 必须通过 Creator/MCP 删除');
    for (const document of [skill, readme]) {
      expect(document).toContain('非 Prefab 资源文件可以直接通过文件系统删除，无需 Creator/MCP');
      expect(document).toContain('同时删除同名 `.meta` 文件（如存在）');
      expect(document).toContain('整文件删除，不是手改 `.meta` JSON');
    }
    expect(skill).toContain('停下并报告阻塞');
    expect(skill).toContain('直写失败即停');
    expect(skill).toContain('DIRECT_WRITE_VERIFY_FAILED');
    expect(skill).toContain('DIRECT_WRITE_OUTCOME_UNKNOWN');
    expect(skill).toContain('PREFAB_DELETE_CONFIRMATION_REQUIRED');
    expect(skill).toContain('PREFAB_REFERENCES_CONFIRMATION_REQUIRED');
  });

  it('固定 Sprite 默认使用原图尺寸且关闭 Trim', async () => {
    const skill = await readFile(skillPath, 'utf8');

    expect(skill).toContain('`Sprite.SizeMode.RAW`（写入值 `2`）');
    expect(skill).toContain('把 `trim` 设为 `false`');
    expect(skill).toContain('不得自行修改 `UITransform.contentSize`');
  });

  it('技能和 README 都要求打开前保护 dirty 文档并验证创建与保存后的 clean 状态', async () => {
    const [skill, readme] = await Promise.all([
      readFile(skillPath, 'utf8'),
      readFile(readmePath, 'utf8')
    ]);

    for (const document of [skill, readme]) {
      expect(document).toContain('DOCUMENT_SAVE_REQUIRED');
      expect(document).toContain('DOCUMENT_DIRTY_AFTER_PREFAB_CREATE');
      expect(document).toContain('DOCUMENT_DIRTY_AFTER_SAVE');
    }
    expect(skill).toContain('工具不得先切换文档或触发原生保存框');
    expect(skill).toContain('dirty 时补保存');
  });

  it('技能和 README 都明确 batch 只允许节点与组件操作', async () => {
    const [skill, readme] = await Promise.all([
      readFile(skillPath, 'utf8'),
      readFile(readmePath, 'utf8')
    ]);
    for (const document of [skill, readme]) {
      expect(document).toContain('`node.*`');
      expect(document).toContain('`component.*`');
      expect(document).toContain('`asset.*`');
      expect(document).toContain('`prefab.*`');
    }
    expect(skill).toContain('BATCH_WRITE_OPERATION_NOT_ALLOWED');
  });

  it('列出全部 Scenario 步骤并说明 always-stop 清理语义', async () => {
    const skill = await readFile(skillPath, 'utf8');
    for (const step of [
      'launch',
      'wait-node',
      'assert-property',
      'dispatch-input',
      'instantiate-prefab',
      'assert-console',
      'capture',
      'assert-image-diff',
      'stop'
    ]) {
      expect(skill).toContain(`\`${step}\``);
    }
    expect(skill).toContain('`stop(always:true)`');
  });

  it('描述覆盖中英文 Prefab 创建、查看、编辑和删除触发词', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const frontmatter = skill.split('---')[1] ?? '';
    for (const trigger of ['create', 'inspect', 'edit', 'delete', '创建', '查看', '编辑', '删除']) {
      expect(frontmatter).toContain(trigger);
    }
  });
});
