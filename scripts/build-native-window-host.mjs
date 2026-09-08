import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'packages', 'bridge-extension', 'native', 'SimulatorEmbedHost.cs');
const output = join(repoRoot, 'packages', 'bridge-extension', 'dist', 'native', 'simulator-embed-host.exe');
const windowsRoot = process.env.WINDIR ?? 'C:\\Windows';
const candidates = [
  join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
];
const compiler = await firstExisting(candidates);
if (!compiler) throw new Error(`CSC_NOT_FOUND:${candidates.join(';')}`);
await mkdir(dirname(output), { recursive: true });
await run(compiler, [
  '/nologo',
  '/target:exe',
  '/platform:x64',
  '/optimize+',
  `/out:${output}`,
  source
]);
process.stdout.write(`${output}\n`);

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // 继续尝试 32 位 .NET Framework 编译器。
    }
  }
  return null;
}

function run(file, args) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(`NATIVE_WINDOW_HOST_BUILD_FAILED:${stderr || stdout || error.message}`));
        return;
      }
      resolveRun();
    });
  });
}
