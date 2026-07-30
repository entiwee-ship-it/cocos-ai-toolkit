import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const installerPath = new URL('./install-codex-mcp.ps1', import.meta.url);
const checkerPath = new URL('./check-codex-mcp.ps1', import.meta.url);
const checkerRuntimePath = new URL('./check-codex-mcp.mjs', import.meta.url);

describe('Codex MCP 安装入口', () => {
  it('默认安装写工具，Readonly 才显式关闭', async () => {
    const installer = await readFile(installerPath, 'utf8');
    expect(installer).toContain('[switch]$Readonly');
    expect(installer).toMatch(/if\s*\(-not\s*\$Readonly\)[\s\S]*--enable-writes/);
    expect(installer).toContain('默认写入');
    expect(installer).toContain('Write-Output $(if ($Readonly)');
    expect(installer).not.toContain('Write-Output (if ($Readonly)');
  });

  it('健康检查区分默认写入与显式只读模式', async () => {
    const checker = await readFile(checkerPath, 'utf8');
    expect(checker).toContain('[switch]$Readonly');
    expect(checker).toContain('--enable-writes');
    expect(checker).toContain('COCOS_AI_MCP_ENABLE_WRITES');
  });

  it('安装和健康检查使用直写单一工具档，旧 profile 机制已移除', async () => {
    const installer = await readFile(installerPath, 'utf8');
    const checker = await readFile(checkerPath, 'utf8');
    const checkerRuntime = await readFile(checkerRuntimePath, 'utf8');

    expect(installer).not.toContain('$Profile');
    expect(installer).not.toContain('--profile');
    expect(checker).not.toContain('$Profile');
    expect(checker).toContain('仍携带已移除的 --profile 参数');
    expect(checkerRuntime).not.toContain('COCOS_AI_MCP_PROFILE');
    expect(checkerRuntime).toContain('direct-tools.js');
    expect(checkerRuntime).toContain('COCOS_DIRECT_READONLY_TOOL_NAMES');
    expect(checkerRuntime).toContain('COCOS_DIRECT_WRITE_TOOL_NAMES');
    expect(checkerRuntime).toContain('COCOS_RUNTIME_GATED_TOOL_NAMES');
  });
});
