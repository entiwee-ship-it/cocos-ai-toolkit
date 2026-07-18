import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const validationScriptPath = fileURLToPath(
  new URL('../../../scripts/run-phase-3-prefab-validation.ps1', import.meta.url)
);
const gitignorePath = fileURLToPath(new URL('../../../.gitignore', import.meta.url));

/**
 * 通过 pwsh 解析脚本 AST，返回语法错误数与消息。
 * 阶段三脚本强制 pwsh 7+ 运行，开发与验证环境必然具备 pwsh；
 * AST 解析替肉眼兜底语法错误，保持合同测试离线可过。
 */
function parsePowerShellAst(scriptPath: string): { errorCount: number; messages: string[] } {
  // pwsh -Command 会把命令字符串后的尾随参数拼进命令文本（位置参数绑定冲突），
  // 因此脚本路径转义后直接内联进命令字符串，不走 $args。
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

describe('Phase 3 预制体统一写入验证脚本', () => {
  it('通过 PowerShell AST 解析，无语法错误', { timeout: 90000 }, () => {
    const parseResult = parsePowerShellAst(validationScriptPath);

    expect(parseResult.errorCount).toBe(0);
    expect(parseResult.messages).toEqual([]);
  });

  it('以 fail-fast 顺序执行静态检查、夹具自举、预制体写入、回滚、中断恢复、清理和 Git 对比', async () => {
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
      '夹具自举：Card 根节点',
      '夹具自举：Card 内嵌实例',
      '夹具自举：Card 生成预制体',
      '夹具自举：Page 根节点',
      '夹具自举：Page 内嵌实例',
      '夹具自举：Page 生成预制体',
      "'transaction-list'",
      '实例化事务',
      '覆盖事务',
      '还原事务',
      '应用到源事务',
      '解除关联事务',
      '解除关联回滚',
      '覆盖事务回滚',
      '实例化事务回滚',
      '回滚后层级复查干净',
      'Invoke-WriteInterruptRecovery',
      '夹具清理',
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

  it('预制体写操作覆盖实例化、生成、还原覆盖、应用到源、解除关联和资产删除，提交必有重读验证', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain("'prefab.instantiate'");
    expect(script).toContain("'prefab.create_from_node'");
    expect(script).toContain("'prefab.revert_override'");
    expect(script).toContain("'prefab.apply_to_source'");
    expect(script).toContain("'prefab.unlink_instance'");
    expect(script).toContain("'prefab.delete_asset'");
    expect(script).toContain('write-prepare');
    expect(script).toContain('write-confirm');
    expect(script).toContain("verification.passed -eq $true");
    // 事务式写入前置：scope 三值、幂等键与 Undo 组名
    expect(script).toContain("'current-document'");
    expect(script).toContain("'apply-to-source'");
    expect(script).toContain('idempotencyKey');
    expect(script).toContain('undoGroup');
  });

  it('整事务回滚要求 verifiedClean，回滚后层级复查干净', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toContain('transaction-rollback');
    expect(script).toContain('rollbackEvidence.verifiedClean');
    expect(script).toContain('回滚后仍存在场景实例节点');
    expect(script).toContain('回滚后夹具自举节点缺失');
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
    expect(script).toContain('phase-3-');
    expect(script).toContain('Phase3Card_');
    expect(script).toContain('Phase3Page_');
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

  it('按文档身份钉住快照并读取规范化节点与预制体实例证据', async () => {
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
    // 三层嵌套夹具的底层资产：healthDialog.prefab 必须存在于空白项目资产索引
    expect(script).toContain('healthDialog.prefab');
    // 实例身份证据来自 probe.node 原始 Dump 的 __prefab__ 结构
    expect(script).toContain('__prefab__');
  });

  it('应用到源事务携带 prefabGraph 指纹与内联影响分析，并用 Git 兜底还原', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    // prefab.apply_to_source 要求 revision.prefabGraph 前置指纹（协议门禁）：
    // 指纹与 Bridge collectPrefabInstanceMarks 同构，由只读 hierarchy 原始节点树推导
    expect(script).toContain('Get-PrefabGraphFingerprint');
    expect(script).toContain('prefabGraph');
    expect(script).toContain('SHA256');
    // scope=apply-to-source 必须携带内联影响分析（源资产、受影响文档、覆盖层与风险）
    expect(script).toContain('impactAnalysis');
    expect(script).toContain('sourceAssetUuid');
    expect(script).toContain('affectedDocuments');
    expect(script).toContain('totalInstanceCount');
    expect(script).toContain('overrideLayers');
    expect(script).toContain('risks');
    // 应用到源改写源预制体磁盘文件：已跟踪文件 git checkout 还原，未跟踪夹具资产由清理步骤删除兜底
    expect(script).toContain('Restore-ProjectFileFromGit');
    expect(script).toContain('ls-files');
    expect(script).toContain("'checkout', '--'");
  });

  it('为真实项目长耗时请求统一配置端到端超时', async () => {
    const script = await readFile(validationScriptPath, 'utf8');

    expect(script).toMatch(/\[int\]\$RequestTimeoutSeconds = 120\b/);
    expect(script).toContain(
      '$env:COCOS_AI_PROBE_TIMEOUT_MS = [string]($RequestTimeoutSeconds * 1000)'
    );
  });
});
