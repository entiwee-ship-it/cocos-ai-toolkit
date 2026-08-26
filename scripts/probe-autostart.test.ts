import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const installPath = new URL('./install-probe-autostart.ps1', import.meta.url);
const removePath = new URL('./remove-probe-autostart.ps1', import.meta.url);
const startPath = new URL('./start-probe-server.ps1', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

describe('Probe Server 登录自启合同', () => {
  it('使用当前用户计划任务并复用固定运行时启动脚本', async () => {
    const [install, remove, start, readme] = await Promise.all([
      readFile(installPath, 'utf8'),
      readFile(removePath, 'utf8'),
      readFile(startPath, 'utf8'),
      readFile(readmePath, 'utf8')
    ]);

    expect(install).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(install).toContain('New-ScheduledTaskPrincipal');
    expect(install).toContain('-LogonType Interactive');
    expect(install).toContain('-RunLevel Limited');
    expect(install).toContain('-RestartCount 3');
    expect(install).toContain('-MultipleInstances IgnoreNew');
    expect(install).toContain('start-probe-server.ps1');
    expect(install).toContain('-SkipBuild');
    expect(install).toContain('-NodePath');
    expect(remove).toContain('Unregister-ScheduledTask');
    expect(start).toContain('COCOS_AI_CAPTURE_ROOT');
    expect(start).toContain('& $NodePath $serverEntry');
    expect(readme).toContain('install-probe-autostart.ps1');
    expect(readme).toContain('remove-probe-autostart.ps1');
  });
});
