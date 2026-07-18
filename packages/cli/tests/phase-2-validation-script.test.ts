import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const validationScriptPath = fileURLToPath(
  new URL('../../../scripts/run-phase-2-write-validation.ps1', import.meta.url)
);
const gitignorePath = fileURLToPath(new URL('../../../.gitignore', import.meta.url));
const readmePath = fileURLToPath(new URL('../../../README.md', import.meta.url));

describe('Phase 2 统一写入验证脚本', () => {
  it('以 fail-fast 顺序执行静态检查、写入、回滚、中断恢复和 Git 对比', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

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
      "'open-asset'",
      '只读基线快照',
      'T1 节点原子写',
      'T2 组件原子写',
      'T3 自定义脚本挂载',
      "'transaction-list'",
      'T3 回滚',
      'T2 回滚',
      'T1 回滚',
      '回滚后层级复查干净',
      'Invoke-WriteInterruptRecovery',
      'git-status-after'
    ];
    for (let index = 1; index < orderedMarkers.length; index += 1) {
      expect(mainFlow.indexOf(orderedMarkers[index - 1])).toBeGreaterThanOrEqual(0);
      expect(mainFlow.indexOf(orderedMarkers[index])).toBeGreaterThan(
        mainFlow.indexOf(orderedMarkers[index - 1])
      );
    }
  });

  it('自检宿主为 pwsh 7+，拒绝 Windows PowerShell 5.1', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain('$PSVersionTable.PSVersion.Major -lt 7');
    expect(script).toContain('pwsh 7+');
  });

  it('写入事务覆盖节点、组件和脚本挂载，并要求提交必有重读验证', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain("'node.create'");
    expect(script).toContain("'node.rename'");
    expect(script).toContain("'node.set_transform'");
    expect(script).toContain("'component.add'");
    expect(script).toContain("'component.enable'");
    expect(script).toContain("'cc.Sprite'");
    expect(script).toContain('scriptUuid');
    expect(script).toContain('write-prepare');
    expect(script).toContain('write-confirm');
    expect(script).toContain("verification.passed -eq $true");
    // 事务式写入前置：scope 限当前文档、幂等键与 Undo 组名
    expect(script).toContain("'current-document'");
    expect(script).toContain('idempotencyKey');
    expect(script).toContain('undoGroup');
  });

  it('整事务回滚要求 verifiedClean，回滚后层级复查干净', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain('transaction-rollback');
    expect(script).toContain('rollbackEvidence.verifiedClean');
    expect(script).toContain('回滚后仍存在探针节点');
    expect(script).toContain('回滚后夹具节点名称未还原');
  });

  it('Server 中断恢复链路保留独立 JSON 证据且禁止盲目续写', async () => {
    const script = await readFile(validationScriptPath, 'utf8');
    const interruptFunction = script.slice(
      script.indexOf('function Invoke-WriteInterruptRecovery'),
      script.indexOf('\ntry {')
    );

    expect(script).toContain('write-interrupt-recovery');
    expect(interruptFunction).toContain('Stop-ProbeServerProcess');
    expect(interruptFunction).toContain('Start-ProbeServerProcess -Generation 2');
    expect(interruptFunction).toContain('Wait-EditorReconnect');
    expect(interruptFunction).toContain('transaction-status');
    expect(interruptFunction).toContain('beforeInterruptionRequest');
    expect(interruptFunction).toContain('cliInterruptionError');
    expect(interruptFunction).toContain('editorReconnect');
    expect(interruptFunction).toContain('statusAfterReconnect');
    expect(interruptFunction).toContain('transaction-rollback');
    expect(interruptFunction).toContain('禁止续写');
    expect(interruptFunction).toContain('-AllowFailure');
  });

  it('为每次运行创建唯一且不可覆盖的证据集合并清理临时文件', async () => {
    const [script, gitignore] = await Promise.all([
      readFile(validationScriptPath, 'utf8'),
      readFile(gitignorePath, 'utf8')
    ]);

    expect(script).toContain('$runId');
    expect(script).toContain('phase-2-');
    expect(script).toContain('CocosAiWrite_');
    expect(script).toContain('[IO.FileMode]::CreateNew');
    expect(script).not.toContain('[IO.File]::WriteAllText');
    expect(script).toContain('git-status-before');
    expect(script).toContain('git-status-after');
    expect(script).toContain('Assert-UnchangedStatus');
    expect(script).toContain('$reportPrefix-*.tmp');
    expect(script).toContain('summary');
    expect(script).toContain('finally');
    expect(gitignore.split(/\r?\n/)).toContain('reports/*.tmp');
  });

  it('按文档身份钉住快照并读取规范化节点 UUID', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    // 文档身份存在瞬时 CURRENT_DOCUMENT_UUID_EMPTY（Phase 1 实测），打开资产后按身份匹配重试
    expect(script).toContain('Read-CurrentDocumentSnapshot');
    expect(script).toContain('CURRENT_DOCUMENT_UUID_EMPTY');
    expect(script).toContain('$snapshot.data.document.assetUuid -eq $ExpectedAssetUuid');
    // 快照节点为规范化结构：UUID 在 identity.objectUuid
    expect(script).toContain('identity.objectUuid');
    // 写入草稿文档优先选场景：Prefab 编辑模式会把写入打到 should_hide_in_hierarchy 编辑容器上
    expect(script).toContain("$document.documentType -eq 'scene'");
    // 夹具节点必须带组件和局部变换（场景伪根没有 position dump，不能作为写入目标）
    expect(script).toContain('$null -ne $node.localTransform.position');
    // 组件与脚本样本来自快照 componentSchemas（componentUuid / nodeUuid / scriptUuid）
    expect(script).toContain('componentSchemas');
    expect(script).toContain("$_.className -ne 'cc.MissingScript'");
    // 空项目没有已注册自定义组件类时，回退到验证夹具脚本 Phase2Probe.ts
    expect(script).toContain('Phase2Probe.ts');
  });

  it('为真实项目长耗时请求统一配置端到端超时', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toMatch(/\[int\]\$RequestTimeoutSeconds = 120\b/);
    expect(script).toContain(
      '$env:COCOS_AI_PROBE_TIMEOUT_MS = [string]($RequestTimeoutSeconds * 1000)'
    );
  });

  it('README 提供阶段二统一写入验证入口', async () => {
    const readme = await readFile(readmePath, 'utf8');

    expect(readme).toContain('run-phase-2-write-validation.ps1');
    expect(readme).toContain('write-prepare');
    expect(readme).toContain('--enable-writes');
  });
});
