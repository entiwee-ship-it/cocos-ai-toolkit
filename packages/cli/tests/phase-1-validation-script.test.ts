import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const validationScriptPath = fileURLToPath(
  new URL('../../../scripts/run-phase-1-readonly-validation.ps1', import.meta.url)
);
const probeServerScriptPath = fileURLToPath(
  new URL('../../../scripts/start-probe-server.ps1', import.meta.url)
);
const gitignorePath = fileURLToPath(new URL('../../../.gitignore', import.meta.url));
const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));

async function readValidationScript() {
  return (await readFile(validationScriptPath, 'utf8')).replace(/\r\n/g, '\n');
}

describe('Phase 1 只读统一验证脚本', () => {
  it('以 fail-fast 顺序执行全部只读验证阶段', async () => {
    const script = await readValidationScript();

    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('Invoke-NativeCommand');
    expect(script).toContain('$process.ExitCode');

    const mainFlow = script.slice(script.indexOf('\ntry {'));

    const orderedMarkers = [
      "@('test')",
      "@('run', 'typecheck')",
      "@('run', 'build')",
      "'editors'",
      "'asset-index'",
      'Find-SampleDocumentSnapshot',
      "'component-schema'",
      "'prefab-graph'",
      "'scan-project'",
      'Assert-Phase1ReportSchema',
      'git-status-after'
    ];
    for (let index = 1; index < orderedMarkers.length; index += 1) {
      expect(mainFlow.indexOf(orderedMarkers[index - 1])).toBeGreaterThanOrEqual(0);
      expect(mainFlow.indexOf(orderedMarkers[index])).toBeGreaterThan(
        mainFlow.indexOf(orderedMarkers[index - 1])
      );
    }

    const reportSchemaFunction = script.slice(
      script.indexOf('function Assert-Phase1ReportSchema'),
      script.indexOf('function Wait-ScanCheckpointProgress')
    );
    const artifactValidationFunction = script.slice(
      script.indexOf('function Resolve-ManifestArtifactPath'),
      script.indexOf('function Invoke-NativeCommand')
    );
    expect(reportSchemaFunction).toContain('$Checkpoint');
    expect(reportSchemaFunction).toContain('$ReportPath');
    expect(reportSchemaFunction).toContain('snapshotPath');
    expect(reportSchemaFunction).toContain('snapshotHash');
    expect(reportSchemaFunction).toContain('Get-FileHash');
    expect(reportSchemaFunction).toContain('$maximumManifestBytes');
    expect(reportSchemaFunction).toContain('formatVersion');
    expect(reportSchemaFunction).toContain('artifacts');
    expect(reportSchemaFunction).toContain('Resolve-ManifestArtifactPath');
    expect(artifactValidationFunction).toContain('sha256');
    expect(artifactValidationFunction).toContain('bytes');
    expect(artifactValidationFunction).toContain('json-gzip');
    expect(reportSchemaFunction).toContain('Read-JsonFile -Path $ReportPath');
    expect(reportSchemaFunction).not.toContain('Get-Content -LiteralPath $ReportPath');
    expect(reportSchemaFunction).toContain('$ExpectedProjectId');
    expect(reportSchemaFunction).toContain('$ExpectedProjectPath');
    expect(reportSchemaFunction).toContain('$ExpectedCreatorVersion');
    expect(reportSchemaFunction).toContain('$gapEvidenceCount');
    expect(mainFlow).toContain('Read-JsonFile -Path $scanReportPath');
    expect(mainFlow).toContain('$scanManifest.data.artifacts.checkpoint.path');
    expect(mainFlow).not.toContain('$scanReportName.Substring');
    expect(mainFlow).toContain('Read-JsonFile -Path $checkpointPath');
  });

  it('从资产索引和完整文档快照自动选择样本', async () => {
    const script = await readValidationScript();

    expect(script).toContain('documents');
    expect(script).toContain('assetUuid');
    expect(script).toContain("'document-snapshot'");
    expect(script).toContain("'full'");
    expect(script).toContain('componentSchemas');
    expect(script).toContain('scriptUuid');
    expect(script).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );
    expect(script).not.toContain('a19Wdy0rtHhZ1xMnnGwsqU');
  });

  it('为每次运行创建唯一且不可覆盖的证据集合', async () => {
    const script = await readValidationScript();

    expect(script).toContain('$runId');
    expect(script).toContain('CocosAiProbe_');
    expect(script).toContain('[IO.FileMode]::CreateNew');
    expect(script).not.toContain('[IO.File]::WriteAllText');
    expect(script).toContain('git-status-before');
    expect(script).toContain('git-status-after');
    expect(script).toContain('Assert-UnchangedStatus');
    expect(script).toContain('summary');
    expect(script).toContain('finally');
  });

  it('忽略扫描 checkpoint 的文档快照证据目录', async () => {
    const gitignore = await readFile(gitignorePath, 'utf8');

    expect(gitignore.split(/\r?\n/)).toContain('reports/*.json.documents/');
    expect(gitignore.split(/\r?\n/)).toContain('reports/*.json.gz');
  });

  it('清理中断种子扫描遗留的原子写临时文件', async () => {
    const script = await readValidationScript();

    const recoveryFunction = script.slice(
      script.indexOf('function Invoke-ServerInterruptRecovery'),
      script.indexOf('Assert-Condition -Condition (Test-Path -LiteralPath $project -PathType Container)')
    );
    expect(recoveryFunction).toContain('$reportPrefix-interrupt-seed.*.tmp');
    expect(recoveryFunction).toContain('Remove-Item');
    expect(recoveryFunction).toContain('finally');

    const gitignore = await readFile(gitignorePath, 'utf8');
    expect(gitignore.split(/\r?\n/)).toContain('reports/*.tmp');
  });

  it('保留可重复的 Server 中断和同 checkpoint 恢复证据', async () => {
    const script = await readValidationScript();

    expect(script).toContain('server-interrupt-recovery');
    expect(script).toContain('beforeInterruptionRequest');
    expect(script).toContain('cliInterruptionError');
    expect(script).toContain('editorReconnect');
    expect(script).toContain('resumeCheckpointResult');
    expect(script).toContain('$checkpointPath');
    expect(script).toContain("'--resume'");
    expect(script).toContain('Start-ProbeServerProcess');
    expect(script).toContain('Stop-ProbeServerProcess');
    expect(script).toContain('Wait-ScanCheckpointProgress');
    expect(script).toContain("'-SkipBuild'");

    const stopFunction = script.slice(
      script.indexOf('function Stop-ProbeServerProcess'),
      script.indexOf('function Get-ServerEvidence')
    );
    expect(stopFunction).toContain('Wait-Process -Id $Control.wrapperProcess.Id');
    expect(stopFunction).toContain('$current.parentProcessId -eq $Control.wrapperProcess.Id');
    expect(stopFunction).toContain('if (-not $Control.wrapperProcess.WaitForExit(10000))');

    const readyFunction = script.slice(
      script.indexOf('function Wait-ProbeServerReady'),
      script.indexOf('function ConvertTo-StartProcessArgument')
    );
    expect(readyFunction).toContain('$lastListenerError');
    expect(readyFunction).toContain("try {\n                    $ready = $readyLine | ConvertFrom-Json");

    const interruptFunction = script.slice(
      script.indexOf('function Invoke-ServerInterruptRecovery'),
      script.indexOf('\ntry {', script.indexOf('function Invoke-ServerInterruptRecovery'))
    );
    expect(interruptFunction).toContain('$seedScanCompleted');
    expect(interruptFunction).toMatch(/finally\s*\{/);
    expect(interruptFunction).toContain('种子扫描清理失败');
    expect(interruptFunction).not.toContain('Read-JsonFile -Path $resumeReportPath');
    expect(interruptFunction).not.toContain('$resumeReport =');
    expect(interruptFunction).toContain('$resume.data.status');

    const processFunctions = script.slice(
      script.indexOf('function Invoke-NativeCommand'),
      script.indexOf('function Add-PassedStep')
    );
    expect(processFunctions).not.toContain('$process.WaitForExit()');
    expect(processFunctions).toContain('无法终止');

    const quotingFunction = script.slice(
      script.indexOf('function ConvertTo-StartProcessArgument'),
      script.indexOf('function Start-ProbeServerProcess')
    );
    expect(quotingFunction).toContain('$trailingBackslashCount');

    const startFunction = script.slice(
      script.indexOf('function Start-ProbeServerProcess'),
      script.indexOf('function Stop-ProbeServerProcess')
    );
    expect(startFunction).toContain('Probe Server Ready 失败');
    expect(startFunction).toContain('$wrapper.Kill($true)');
    expect(startFunction).toContain('$wrapper.WaitForExit(10000)');
    expect(startFunction).toContain('Get-ProbeServerListener -AllowMissing');
    expect(startFunction).toContain('Stop-ProbeServerProcess -Control $failedStartControl');

    const summaryWrite = script.slice(script.indexOf('$summary = [ordered]@{'));
    expect(summaryWrite).toContain('写入 Phase 1 summary 失败');
    expect(summaryWrite).toContain('Write-Warning');
  });

  it('已有 Probe Server 也会在验证前换成当前构建并等待真实 Ready', async () => {
    const script = await readValidationScript();
    const mainFlow = script.slice(script.indexOf('\ntry {'));
    const serverStartup = mainFlow.slice(
      mainFlow.indexOf('$existingListener'),
      mainFlow.indexOf('$initialReconnect')
    );

    expect(serverStartup).toContain('Stop-ProbeServerProcess');
    expect(serverStartup).toContain('Start-ProbeServerProcess -Generation 1');
    expect(serverStartup).not.toContain('adopted = $true');
  });

  it('为真实项目长耗时只读请求统一配置端到端超时', async () => {
    const script = await readValidationScript();

    expect(script).toMatch(/\[int\]\$RequestTimeoutSeconds = 120\b/);
    expect(script).toContain(
      "$env:COCOS_AI_PROBE_TIMEOUT_MS = [string]($RequestTimeoutSeconds * 1000)"
    );
  });

  it('以 Hashtable 解析包含空键的 Creator 原始 JSON', async () => {
    const script = await readValidationScript();
    const propertyFunction = script.slice(
      script.indexOf('function Test-ObjectProperty'),
      script.indexOf('function Write-ReportFile')
    );
    const rawReportFunction = script.slice(
      script.indexOf('function Write-RawJsonReport'),
      script.indexOf('function Read-JsonFile')
    );
    const readJsonFunction = script.slice(
      script.indexOf('function Read-JsonFile'),
      script.indexOf('function Invoke-NativeCommand')
    );
    const cliJsonFunction = script.slice(
      script.indexOf('function Invoke-CliJson'),
      script.indexOf('function Start-NativeCommandProcess')
    );

    expect(rawReportFunction).toContain('ConvertFrom-Json -AsHashtable');
    expect(readJsonFunction).toContain('ConvertFrom-Json -AsHashtable');
    expect(readJsonFunction).toContain('GZipStream');
    expect(readJsonFunction).toContain("EndsWith('.gz'");
    expect(cliJsonFunction).toContain('ConvertFrom-Json -AsHashtable');
    expect(propertyFunction).toContain('$Value -is [Collections.IDictionary]');
    expect(propertyFunction).toContain('$Value.Contains($Name)');
  });

  it('解包 CLI component probe 后分别校验组件身份和类型 Schema', async () => {
    const script = await readValidationScript();
    const componentSchemaValidation = script.slice(
      script.indexOf("$componentSchema = Invoke-CliJson"),
      script.indexOf("$prefabGraph = Invoke-CliJson")
    );

    expect(componentSchemaValidation).toContain("$componentPayload = $componentSchema.data['data']");
    expect(componentSchemaValidation).toContain(
      "$componentIdentity = $componentPayload['identity']"
    );
    expect(componentSchemaValidation).toContain(
      "$componentTypeSchema = $componentPayload['schema']"
    );
    expect(componentSchemaValidation).toContain(
      "[string]$componentIdentity['objectUuid'] -eq [string]$sample.componentSchema.componentUuid"
    );
    expect(componentSchemaValidation).toContain("[string]$componentTypeSchema['scriptUuid']");
    expect(componentSchemaValidation).toContain(
      "Test-ObjectProperty -Value $componentTypeSchema -Name 'properties'"
    );
    expect(componentSchemaValidation).not.toContain('$componentSchema.data.schema');
    expect(componentSchemaValidation).not.toContain('$componentSchema.data.componentUuid');
  });

  it('为 Probe Server 重启和真实 Creator 验证提供公开入口', async () => {
    const [serverScript, readme] = await Promise.all([
      readFile(probeServerScriptPath, 'utf8'),
      readFile(readmePath, 'utf8')
    ]);

    expect(serverScript).toMatch(/\[switch\]\$SkipBuild\b/);
    expect(serverScript).toContain('probe-server.ready');
    expect(readme).toContain('run-phase-1-readonly-validation.ps1');
    expect(readme).toContain('Creator 3.8.8');
    expect(readme).toContain('server-interrupt-recovery');
    expect(readme).toContain('不保留原 PID 或自定义环境变量');
  });
});
