import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../../scripts/run-phase-0-validation.ps1', import.meta.url)
);
const findingsPath = fileURLToPath(
  new URL('../../../docs/phase-0-findings.md', import.meta.url)
);

describe('Phase 0 统一验证脚本', () => {
  it('以 fail-fast 方式覆盖静态检查和全部只读探针', async () => {
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('Invoke-NativeCommand');
    expect(script).toContain('$process.ExitCode');
    expect(script).toMatch(/@\('test'\)/);
    expect(script).toMatch(/@\('run', 'typecheck'\)/);
    expect(script).toMatch(/@\('run', 'build'\)/);
    expect(script.indexOf("@('run', 'build')")).toBeLessThan(
      script.indexOf("Assert-Condition -Condition (Test-Path -LiteralPath $cliPath -PathType Leaf)")
    );

    for (const command of ['editors', 'state', 'assets', 'hierarchy', 'node', 'component', 'prefab']) {
      expect(script).toContain(`'${command}'`);
    }
  });

  it('要求运行期选择器和全部真实样本 UUID', async () => {
    const script = await readFile(scriptPath, 'utf8');

    for (const parameter of [
      'ProjectId',
      'EditorInstanceId',
      'SampleNodeUuid',
      'SampleComponentUuid',
      'NestedPrefabNodeUuid',
      'TestPrefabUuid'
    ]) {
      expect(script).toMatch(new RegExp(`\\[string\\]\\$${parameter}\\b`));
    }

    expect(script).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(script).not.toContain('a19Wdy0rtHhZ1xMnnGwsqU');
  });

  it('使用目标资产条件等待并验证两阶段 Undo 事务', async () => {
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('Wait-TargetAsset');
    expect(script).toContain('query-asset-info');
    const targetWait = script.slice(
      script.indexOf('function Wait-TargetAsset'),
      script.indexOf('function Wait-HierarchySample')
    );
    const hierarchyWait = script.slice(
      script.indexOf('function Wait-HierarchySample'),
      script.indexOf('\ntry {')
    );
    expect(targetWait).not.toContain('catch');
    expect(hierarchyWait).not.toContain('catch');
    expect(script).toContain('probe-undo-save-prepare');
    expect(script).toContain('probe-undo-save-confirm');
    expect(script).toContain('probe-undo-save-status');
    expect(script).not.toMatch(/['"]probe-undo-save['"]/);
    expect(script).toContain('transactionId');
    expect(script).toContain('revision');
    expect(script).toContain("'rolled-back'");
    expect(script).toContain('CocosAiProbe_');
    expect(script).toContain('Get-FileHash');
    expect(script).toContain('hasUITransform');
    expect(script).toContain('@($component.data.data.properties.PSObject.Properties).Count');
    expect(script).not.toContain('$component.data.data.properties.PSObject.Properties.Count');
  });

  it('只在 reports 下保留唯一命名报告并比较两个项目的前后状态', async () => {
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain("Join-Path $repoRoot 'reports'");
    expect(script).toContain('Write-JsonReport');
    expect(script).toContain('Write-RawJsonReport');
    expect(script).toContain('[IO.FileMode]::CreateNew');
    expect(script).not.toContain('[IO.File]::WriteAllText');
    expect(script).toContain('git-status-before');
    expect(script).toContain('git-status-after');
    expect(script).toContain('summary');
    expect(script).toContain('RealProjectPath');
    expect(script).toContain('IsolatedProjectPath');
    expect(script).toContain('Assert-UnchangedStatus');
    expect(script).toContain('$runId');
  });

  it('Findings 限定 3.8.8 结论并披露覆盖率和人工中断证据边界', async () => {
    const findings = await readFile(findingsPath, 'utf8');

    expect(findings).toContain('Creator 3.8.8');
    expect(findings).toContain('74/74');
    expect(findings).toContain('212/212');
    expect(findings).toContain('1/74');
    expect(findings).toContain('1/212');
    expect(findings).toContain('人工中断验证');
    expect(findings).toContain('没有保留独立 JSON');
  });
});
