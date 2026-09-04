import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const updaterPath = new URL('./update-runtime.ps1', import.meta.url);
const installerPath = new URL('./install-bridge.ps1', import.meta.url);
const removerPath = new URL('./remove-bridge.ps1', import.meta.url);
const cleanerPath = new URL('./clean-dist.mjs', import.meta.url);
const rootPackagePath = new URL('../package.json', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

describe('运行工作树同步合同', () => {
  it('始终以 detached HEAD 对齐目标提交，不创建额外本地分支', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const readme = await readFile(readmePath, 'utf8');

    expect(updater).toContain("Invoke-Git @('checkout', '--detach', $target)");
    expect(updater).not.toContain("checkout', '-B', 'runtime'");
    expect(updater).not.toContain("branch', '--set-upstream-to");
    expect(readme).toContain('detached HEAD');
    expect(readme).not.toContain('本地 `runtime` 分支');
  });

  it('安装示例与隔离 Worktree 安全边界一致', async () => {
    const installer = await readFile(installerPath, 'utf8');
    const readme = await readFile(readmePath, 'utf8');

    expect(readme).not.toContain("-ProjectPath 'E:/xile-workspace/qyProject/xy-client'");
    expect(readme).toContain("-ProjectPath 'E:/xile-workspace/worktrees/cocos-ai-blank/Cocos-ai'");
    expect(readme).toContain("-ToolkitPath 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0'");
    expect(installer).toContain('[string]$WorktreeRoot');
    expect(installer).toContain('[switch]$AllowSavedProject');
    expect(installer).not.toContain('$realProject');
  });

  it('Codex 与 Bridge 默认共用固定运行 Worktree', async () => {
    const [bridgeInstaller, codexInstaller, checker] = await Promise.all([
      readFile(installerPath, 'utf8'),
      readFile(new URL('./install-codex-mcp.ps1', import.meta.url), 'utf8'),
      readFile(new URL('./check-codex-mcp.ps1', import.meta.url), 'utf8')
    ]);
    const runtime = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0';
    expect(bridgeInstaller).toContain(runtime);
    expect(codexInstaller).toContain(runtime);
    expect(checker).toContain(runtime);
  });

  it('更新失败会恢复旧提交，且不再启动后台服务', async () => {
    const updater = await readFile(updaterPath, 'utf8');

    expect(updater).toContain("Invoke-Git @('checkout', '--detach', $old)");
    expect(updater).toContain('回滚失败');
    expect(updater).toContain('Named Pipe 无需启动服务');
    expect(updater).not.toContain('Start-Process');
    expect(updater).not.toContain('Get-NetTCPConnection');
    expect(updater).not.toContain('32188');
  });

  it('每次构建前清空所有 workspace 的旧 dist 产物', async () => {
    const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(rootPackage.scripts?.build).toContain('npm run clean');
    expect(rootPackage.scripts?.clean).toBe('node scripts/clean-dist.mjs');

    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-clean-dist-'));
    try {
      const staleDist = join(root, 'packages', 'bridge-extension', 'dist');
      const sourceDir = join(root, 'packages', 'bridge-extension', 'src');
      await mkdir(staleDist, { recursive: true });
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cocos-ai-toolkit' }));
      await writeFile(join(staleDist, 'deleted-module.js'), 'stale');
      await writeFile(join(sourceDir, 'main.ts'), 'export {};');

      execFileSync(process.execPath, [fileURLToPath(cleanerPath), root], { stdio: 'pipe' });

      await expect(stat(staleDist)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(sourceDir, 'main.ts'))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('安全移除 Bridge Junction 而不删除目标目录内容', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-remove-bridge-'));
    try {
      const toolkit = join(root, 'toolkit');
      const bridge = join(toolkit, 'packages', 'bridge-extension');
      const project = join(root, 'project');
      const extension = join(project, 'extensions', 'cocos-ai-bridge');
      await mkdir(bridge, { recursive: true });
      await mkdir(join(project, 'extensions'), { recursive: true });
      await writeFile(join(bridge, 'sentinel.txt'), 'keep');
      await symlink(bridge, extension, 'junction');

      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(removerPath),
        '-ProjectPath', project,
        '-ToolkitPath', toolkit
      ], { stdio: 'pipe' });

      await expect(stat(extension)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(bridge, 'sentinel.txt'))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
