import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapperPath = fileURLToPath(new URL('../../../scripts/run-runtime-validation.ps1', import.meta.url));
const runnerPath = fileURLToPath(new URL('../../../scripts/run-runtime-validation.mjs', import.meta.url));
const gitignorePath = fileURLToPath(new URL('../../../.gitignore', import.meta.url));

describe('运行态统一验证脚本', () => {
  it('PowerShell 包装器和 Node 主脚本都能通过语法检查', () => {
    const inlinePath = wrapperPath.replace(/'/g, "''");
    const command = [
      '$tokens = $null',
      '$errors = $null',
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${inlinePath}', [ref]$tokens, [ref]$errors)`,
      '@($errors).Count'
    ].join('; ');
    expect(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 60_000
    }).trim()).toBe('0');
    expect(() => execFileSync(process.execPath, ['--check', runnerPath], { stdio: 'pipe' })).not.toThrow();
  }, 90_000);

  it('单个 stdio MCP 会话完成 Preview 验证，不再启动 Probe 或端口服务', async () => {
    const wrapper = await readFile(wrapperPath, 'utf8');
    const runner = await readFile(runnerPath, 'utf8');
    expect(wrapper).toContain('run-runtime-validation.mjs');
    expect(runner).toContain('StdioClientTransport');
    expect(runner.match(/new StdioClientTransport/g)).toHaveLength(1);
    expect(`${wrapper}\n${runner}`).not.toMatch(/probe-server|32188|WebSocket|Get-NetTCPConnection/);
  });

  it('按顺序验证发现、启动、层级、Console、截图、场景和停止', async () => {
    const runner = await readFile(runnerPath, 'utf8');
    const ordered = [
      "'cocos_editor_list'",
      "'cocos_preview_launch'",
      "'cocos_runtime_get_hierarchy'",
      "'cocos_runtime_get_console'",
      "'cocos_runtime_capture'",
      "'cocos_runtime_run_scenario'",
      "'cocos_preview_stop'"
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(runner.indexOf(ordered[index])).toBeGreaterThan(runner.indexOf(ordered[index - 1]));
    }
  });

  it('截图和 Git 状态保留真实证据，finally 兜底关闭会话', async () => {
    const [runner, gitignore] = await Promise.all([
      readFile(runnerPath, 'utf8'),
      readFile(gitignorePath, 'utf8')
    ]);
    expect(runner).toContain("toString('ascii') !== 'PNG'");
    expect(runner).toContain('GIT_STATUS_CHANGED_DURING_VALIDATION');
    expect(runner).toContain("callTool('cocos_preview_stop', { sessionId }).catch");
    expect(gitignore.split(/\r?\n/)).toContain('reports/runtime-captures/');
  });
});
