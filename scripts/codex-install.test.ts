import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const installerPath = new URL('./install-codex-mcp.ps1', import.meta.url);
const checkerPath = new URL('./check-codex-mcp.ps1', import.meta.url);

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
});
