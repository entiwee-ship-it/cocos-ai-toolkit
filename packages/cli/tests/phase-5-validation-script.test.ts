import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const validationScriptPath = fileURLToPath(
  new URL('../../../scripts/run-phase-5-runtime-validation.ps1', import.meta.url)
);
const gitignorePath = fileURLToPath(new URL('../../../.gitignore', import.meta.url));

/**
 * 通过 pwsh 解析脚本 AST，返回语法错误数与消息。
 *
 * @param scriptPath 待解析的阶段五 PowerShell 脚本绝对路径。
 * @returns PowerShell 语法错误数量和带行号的消息。
 */
function parsePowerShellAst(scriptPath: string): { errorCount: number; messages: string[] } {
  const inlinePath = scriptPath.replace(/'/g, "''");
  const command = [
    '$tokens = $null',
    '$errors = $null',
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${inlinePath}', [ref]$tokens, [ref]$errors)`,
    "$report = [pscustomobject]@{ errorCount = @($errors).Count; messages = @($errors | ForEach-Object { $_.Message + ' @' + $_.Extent.StartLineNumber }) }",
    '$report | ConvertTo-Json -Compress'
  ].join('; ');
  const stdout = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 60000
  });
  return JSON.parse(stdout) as { errorCount: number; messages: string[] };
}

describe('Phase 5 运行态统一验证脚本', () => {
  it('通过 PowerShell AST 解析，无语法错误', { timeout: 90000 }, () => {
    expect(parsePowerShellAst(validationScriptPath)).toEqual({ errorCount: 0, messages: [] });
  });

  it('以 fail-fast 顺序执行静态检查和运行态完整链路', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const mainFlow = script.slice(script.indexOf('\ntry {'));
    const orderedMarkers = [
      "@('test')",
      "@('run', 'typecheck')",
      "@('run', 'build')",
      'Wait-EditorConnection',
      "'preview-launch'",
      "'preview-sessions'",
      "'runtime-hierarchy'",
      "'runtime-component'",
      "'runtime-invoke'",
      "'runtime-watch'",
      "'runtime-input'",
      "'runtime-console'",
      "'runtime-capture'",
      "'runtime-scenario'",
      "'preview-stop'",
      'git-status-after'
    ];

    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('$process.ExitCode');
    for (let index = 1; index < orderedMarkers.length; index += 1) {
      expect(mainFlow.indexOf(orderedMarkers[index - 1])).toBeGreaterThanOrEqual(0);
      expect(mainFlow.indexOf(orderedMarkers[index])).toBeGreaterThan(
        mainFlow.indexOf(orderedMarkers[index - 1])
      );
    }
  });

  it('门禁 Creator 3.8.8 和运行态所需 Bridge 能力', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain('$PSVersionTable.PSVersion.Major -lt 7');
    expect(script).toContain("creatorVersion -eq '3.8.8'");
    expect(script).toContain("'probe.previewOpen'");
    expect(script).toContain("'probe.previewStatus'");
  });

  it('Preview URL 必须规范化为回环地址，会话仅 self-launched', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain("StartsWith('http://127.0.0.1:')");
    expect(script).toContain("pageSource -eq 'self-launched'");
  });

  it('差异基准图在多分辨率切换之后补拍，基准路径限定会话相对形态', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const mainFlow = script.slice(script.indexOf('\ntry {'));
    const multiIndex = mainFlow.indexOf('runtime-capture 多分辨率');
    const baselineIndex = mainFlow.indexOf('runtime-capture 差异基准');
    const scenarioIndex = mainFlow.indexOf("'runtime-scenario'");

    expect(multiIndex).toBeGreaterThanOrEqual(0);
    expect(baselineIndex).toBeGreaterThan(multiIndex);
    expect(scenarioIndex).toBeGreaterThan(baselineIndex);
    expect(script).toContain('evidenceSegments[-2..-1]');
    expect(script).toContain('assert-image-diff');
  });

  it('停止后会话必须拒绝读取，且兜底停止放在 finally', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const finallyFlow = script.slice(script.lastIndexOf('} finally {'));

    expect(script).toContain('PREVIEW_SESSION_CLOSED');
    expect(finallyFlow).toContain('Stop-PreviewSessionSafely');
    expect(finallyFlow).toContain('Stop-ManagedProbeServer');
  });

  it('invoke 与 watch 断言真实生效而非接口成功', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain('_contentSize.width -eq 321');
    expect(script).toContain('watchChanged.data.initialValue -eq 654');
    expect(script).toContain("$scenario.data.passed -eq $true");
  });

  it('截图证据做 PNG 签名与尺寸校验，截图产物目录已被 gitignore', async () => {
    const [script, gitignore] = await Promise.all([
      readFile(validationScriptPath, 'utf8'),
      readFile(gitignorePath, 'utf8')
    ]);

    expect(script).toContain("Assert-PngFile");
    expect(script).toContain("$signature -eq 'PNG'");
    expect(script).toContain('git-status-before');
    expect(script).toContain('git-status-after');
    expect(script).toContain('Assert-UnchangedStatus');
    expect(gitignore.split(/\r?\n/)).toContain('reports/runtime-captures/');
  });
});
