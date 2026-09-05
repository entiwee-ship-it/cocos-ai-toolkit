import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const installerPath = new URL('./install-codex-mcp.ps1', import.meta.url);
const checkerPath = new URL('./check-codex-mcp.ps1', import.meta.url);
const checkerRuntimePath = new URL('./check-codex-mcp.mjs', import.meta.url);

describe('Codex MCP 安装入口', () => {
  it('安装脚本默认只注册一个全部工具公开的 MCP 入口', async () => {
    const installer = await readFile(installerPath, 'utf8');
    expect(installer).toContain("$installArgs += @('--', $NodePath, $entry)");
    expect(installer).toContain('全部工具默认公开');
    expect(installer).not.toContain('$Readonly');
    expect(installer).not.toContain('--enable-writes');
  });

  it('健康检查固定验证完整工具集合和 Bridge 身份', async () => {
    const [checker, checkerRuntime] = await Promise.all([
      readFile(checkerPath, 'utf8'),
      readFile(checkerRuntimePath, 'utf8')
    ]);
    expect(checker).toContain('E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0');
    expect(checker).not.toContain('[switch]$Readonly');
    expect(checker).toContain('仍包含已移除的 --enable-writes 参数');
    expect(checker).not.toContain('COCOS_AI_MCP_ENABLE_WRITES');
    expect(checkerRuntime).toContain('EXPECTED_TOOLS');
    expect(checkerRuntime).toContain('COCOS_DIRECT_WRITE_TOOL_NAMES');
    expect(checkerRuntime).toContain('COCOS_RUNTIME_ACTION_TOOL_NAMES');
    expect(checkerRuntime).toContain('allToolsPublic: true');
    expect(checkerRuntime).not.toContain('COCOS_AI_MCP_ENABLE_WRITES');
    expect(checkerRuntime).not.toContain('--enable-writes');
    expect(checkerRuntime).toContain('BRIDGE_BUILD_ID_MISMATCH');
    expect(checkerRuntime).toContain('BRIDGE_CAPABILITIES_MISMATCH');
    expect(checkerRuntime).toContain('COCOS_EDITOR_NOT_CONNECTED');
  });
});
