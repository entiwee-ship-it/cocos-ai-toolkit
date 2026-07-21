import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const validationScriptPath = fileURLToPath(
  new URL('../../../scripts/run-phase-4-declarative-validation.ps1', import.meta.url)
);
const gitignorePath = fileURLToPath(new URL('../../../.gitignore', import.meta.url));

/**
 * 通过 pwsh 解析脚本 AST，返回语法错误数与消息。
 *
 * @param scriptPath 待解析的阶段四 PowerShell 脚本绝对路径。
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

describe('Phase 4 声明式统一验证脚本', () => {
  it('通过 PowerShell AST 解析，无语法错误', { timeout: 90000 }, () => {
    expect(parsePowerShellAst(validationScriptPath)).toEqual({ errorCount: 0, messages: [] });
  });

  it('以 fail-fast 顺序执行静态检查和声明式完整往返', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const mainFlow = script.slice(script.indexOf('\ntry {'));
    const orderedMarkers = [
      "@('test')",
      "@('run', 'typecheck')",
      "@('run', 'build')",
      'Wait-EditorConnection',
      'Wait-AssetIndexReady',
      'Wait-SampleDocumentReady',
      'Wait-DesignInspect',
      "'design-plan'",
      "'design-preview'",
      "'design-apply'",
      "'design-verify'",
      "'design-export'",
      'round-trip plan',
      'Invoke-DesignRollbackChain',
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

  it('目标文档包含逻辑 ID、组件属性和节点引用，并显式禁止 prune', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain("id = '$dialog'");
    expect(script).toContain("id = '$label'");
    expect(script).toContain("id = '$target'");
    expect(script).toContain("type = 'Phase2Probe'");
    expect(script).toContain("targetNode = '$target'");
    expect(script).toContain('probeFlag = $true');
    expect(script).toContain('prune = $false');
    expect(script).toContain("match = 'name-path'");
    expect(script).toContain("if (-not [string]::IsNullOrWhiteSpace([string]$Root.fileId))");
  });

  it('门禁 Creator 3.8.8 和声明式所需 Bridge 能力', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain('$PSVersionTable.PSVersion.Major -lt 7');
    expect(script).toContain("creatorVersion -eq '3.8.8'");
    for (const capability of [
      'probe.documentSnapshot',
      'probe.writePrepare',
      'probe.writeConfirm',
      'probe.transactionRollback'
    ]) {
      expect(script).toContain(`'${capability}'`);
    }
  });

  it('Bridge 连接后等待场景资产与脚本资产 Ready，再打开场景文档', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const assetLocationFunction = script.slice(
      script.indexOf('function Test-AssetLocation'),
      script.indexOf('function Wait-AssetIndexReady')
    );
    const waitFunction = script.slice(
      script.indexOf('function Wait-AssetIndexReady'),
      script.indexOf('function Find-SampleDocument')
    );
    const findDocumentFunction = script.slice(
      script.indexOf('function Find-SampleDocument'),
      script.indexOf('function Find-Phase2ProbeScript')
    );

    expect(waitFunction).toContain("@('asset-index')");
    expect(waitFunction).toContain("type -eq 'cc.SceneAsset'");
    expect(waitFunction).toContain("Test-AssetLocation -Asset $_ -ExpectedPath 'db://assets/phase2-probe' -ExpectedUrl 'db://assets/phase2-probe.scene'");
    expect(waitFunction).toContain("Test-AssetLocation -Asset $_ -ExpectedPath 'db://assets/Phase2Probe' -ExpectedUrl 'db://assets/Phase2Probe.ts'");
    expect(assetLocationFunction).toContain('[string]$Asset.path -eq $ExpectedPath');
    expect(assetLocationFunction).toContain('[string]$Asset.url -eq $ExpectedUrl');
    expect(waitFunction).toContain('Start-Sleep');
    expect(waitFunction).toContain('$ReadyTimeoutSeconds');
    expect(findDocumentFunction).toContain('$AssetIndex.assets');
    expect(findDocumentFunction).toContain("type -eq 'cc.SceneAsset'");
    expect(findDocumentFunction).toContain("Test-AssetLocation -Asset $_ -ExpectedPath 'db://assets/phase2-probe' -ExpectedUrl 'db://assets/phase2-probe.scene'");
  });

  it('design-apply 非零退出码仍解析 stdout JSON 并先落恢复证据', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const invokeFunction = script.slice(
      script.indexOf('function Invoke-CliJson'),
      script.indexOf('function Add-PassedStep')
    );
    const mainFlow = script.slice(script.indexOf('\ntry {'));
    const applyStart = mainFlow.indexOf("@('design-apply')");
    const applyEvidence = mainFlow.indexOf('design-apply.json', applyStart);
    const applyAssertion = mainFlow.indexOf("$apply.data.status -eq 'committed'", applyStart);

    expect(invokeFunction).not.toContain('raw = $null; data = $null');
    expect(invokeFunction).toContain('$result.stdout | ConvertFrom-Json -AsHashtable');
    expect(mainFlow.slice(applyStart, applyEvidence)).toContain('-AllowFailure');
    expect(applyStart).toBeGreaterThanOrEqual(0);
    expect(applyEvidence).toBeGreaterThan(applyStart);
    expect(applyAssertion).toBeGreaterThan(applyEvidence);
  });

  it('等待类原生命令超时可返回失败结果，并在场景根可读后才执行 full inspect', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const nativeFunction = script.slice(
      script.indexOf('function Invoke-NativeCommand'),
      script.indexOf('function Invoke-CliJson')
    );
    const readyFunction = script.slice(
      script.indexOf('function Wait-SampleDocumentReady'),
      script.indexOf('function Wait-DesignInspect')
    );

    expect(nativeFunction).toContain('$timedOut = $true');
    expect(nativeFunction).toContain('timedOut = $timedOut');
    expect(nativeFunction).toContain('if (-not $AllowFailure)');
    expect(nativeFunction).toContain('exitCode = if ($timedOut) { -1 }');
    expect(nativeFunction).toContain('stdout = $stdoutTask.GetAwaiter().GetResult().Trim()');
    expect(nativeFunction).not.toContain('$stdoutTask.IsCompleted');
    expect(readyFunction).toContain("@('open-asset')");
    expect(readyFunction).toContain("@('hierarchy')");
    expect(readyFunction).toContain('-AllowFailure');
    expect(readyFunction).toContain('$hierarchy.data.data.identity.objectUuid -ceq $ExpectedAssetUuid');
  });

  it('递归检查节点名称时允许叶子节点传入空 children 集合', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const searchFunction = script.slice(
      script.indexOf('function Test-DesignNodeName'),
      script.indexOf('function New-DesignTarget')
    );

    expect(searchFunction).toContain('[AllowEmptyCollection()]');
  });

  it('apply、verify 和 export 均保留协议级断言与独立 JSON 证据', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain("$apply.data.status -eq 'committed'");
    expect(script).toContain('$verify.data.passed -eq $true');
    expect(script).toContain('$roundTripPlan.data.items.Count -eq 0');
    expect(script).toContain('design-apply.json');
    expect(script).toContain('design-verify.json');
    expect(script).toContain('design-export.json');
    expect(script).toContain('design-round-trip-plan.json');
  });

  it('按已提交事务逆序回滚，要求 verifiedClean，并复查目标子树消失', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const rollbackFunction = script.slice(
      script.indexOf('function Invoke-DesignRollbackChain'),
      script.indexOf('\ntry {')
    );

    expect(rollbackFunction).toContain('[Array]::Reverse');
    expect(rollbackFunction).toContain('transaction-rollback');
    expect(rollbackFunction).toContain('rollbackEvidence.verifiedClean');
    expect(rollbackFunction).toContain('if ($AllowFailure) { return $false }');
    expect(rollbackFunction).toContain('$rolledBackIds');
    expect(rollbackFunction).toContain('$ApplyResult.rollbackResults');
    expect(rollbackFunction).toContain("status -eq 'rolled-back'");
    expect(rollbackFunction).toContain('rollbackEvidence.verifiedClean -eq $true');
    expect(rollbackFunction).toContain('$expectedTransactionId');
    expect(rollbackFunction).toContain('$result.transactionId -cne $expectedTransactionId');
    expect(rollbackFunction).toContain('$rollback.data.transactionId -ceq $transactionId');
    expect(script).toContain('回滚后仍存在阶段四夹具根节点');
  });

  it('manual-recovery-required 保留现场，不继续盲目自动回滚', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const finallyFlow = script.slice(script.lastIndexOf('} finally {'));
    const manualRecoveryGuard = finallyFlow.indexOf("$apply.data.status -ne 'manual-recovery-required'");
    const rollbackCall = finallyFlow.indexOf('Invoke-DesignRollbackChain');

    expect(manualRecoveryGuard).toBeGreaterThanOrEqual(0);
    expect(rollbackCall).toBeGreaterThan(manualRecoveryGuard);
    expect(finallyFlow).toContain('人工恢复状态禁止自动回滚');
  });

  it('每次运行使用唯一证据前缀，失败时保留恢复信息并逐字核对 Git', async () => {
    const [script, gitignore] = await Promise.all([
      readFile(validationScriptPath, 'utf8'),
      readFile(gitignorePath, 'utf8')
    ]);

    expect(script).toContain('$runId');
    expect(script).toContain('phase-4-');
    expect(script).toContain('Phase4Dialog_');
    expect(script).toContain('[IO.FileMode]::CreateNew');
    expect(script).toContain('recovery-required');
    expect(script).toContain('transactions = @(');
    expect(script).toContain('applyRollbackResults = @(');
    expect(script).toContain('git-status-before');
    expect(script).toContain('git-status-after');
    expect(script).toContain('Assert-UnchangedStatus');
    expect(script).toContain('$reportPrefix-*.tmp');
    expect(script).toContain('finally');
    expect(gitignore.split(/\r?\n/)).toContain('reports/*.tmp');
  });
});
