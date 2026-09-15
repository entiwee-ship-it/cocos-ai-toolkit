import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'packages', 'bridge-extension', 'native', 'SimulatorEmbedHost.cpp');
const output = join(repoRoot, 'packages', 'bridge-extension', 'dist', 'native', 'simulator-embed-host.exe');
const object = join(repoRoot, 'packages', 'bridge-extension', 'dist', 'native', 'simulator-embed-host.obj');
const obsoleteHookOutput = join(repoRoot, 'packages', 'bridge-extension', 'dist', 'native', 'simulator-frame-hook.dll');
const obsoleteDwmOutput = join(repoRoot, 'packages', 'bridge-extension', 'dist', 'native', 'simulator-dwm-host.node');
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const vswhere = await firstExisting([
  join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
]);
if (!vswhere) throw new Error('VSWHERE_NOT_FOUND');
const installationPath = (await run(vswhere, [
  '-latest', '-products', '*',
  '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property', 'installationPath'
])).trim();
if (!installationPath) throw new Error('MSVC_BUILD_TOOLS_NOT_FOUND');

const toolsVersion = (await readFile(
  join(installationPath, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'),
  'utf8'
)).trim();
const toolsRoot = join(installationPath, 'VC', 'Tools', 'MSVC', toolsVersion);
const sdkRoot = join(programFilesX86, 'Windows Kits', '10');
const sdkVersion = await latestSdkVersion(join(sdkRoot, 'Include'));
const compiler = join(toolsRoot, 'bin', 'Hostx64', 'x64', 'cl.exe');
await access(compiler);
await mkdir(dirname(output), { recursive: true });
await Promise.all([rm(obsoleteHookOutput, { force: true }), rm(obsoleteDwmOutput, { force: true })]);

const include = [
  join(toolsRoot, 'include'),
  join(sdkRoot, 'Include', sdkVersion, 'ucrt'),
  join(sdkRoot, 'Include', sdkVersion, 'shared'),
  join(sdkRoot, 'Include', sdkVersion, 'um'),
  join(sdkRoot, 'Include', sdkVersion, 'winrt'),
  join(sdkRoot, 'Include', sdkVersion, 'cppwinrt')
];
const library = [
  join(toolsRoot, 'lib', 'x64'),
  join(sdkRoot, 'Lib', sdkVersion, 'ucrt', 'x64'),
  join(sdkRoot, 'Lib', sdkVersion, 'um', 'x64')
];
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
const environment = {
  ...process.env,
  [pathKey]: [dirname(compiler), join(sdkRoot, 'bin', sdkVersion, 'x64'), process.env[pathKey] ?? ''].join(delimiter),
  INCLUDE: include.join(';'),
  LIB: library.join(';')
};
try {
  await run(compiler, [
    '/nologo', '/std:c++20', '/permissive-', '/EHsc', '/O2', '/MT', '/utf-8', '/W4',
    '/DUNICODE', '/D_UNICODE', `/Fe:${output}`, `/Fo:${object}`, source,
    'd3d11.lib', 'dxgi.lib', 'windowsapp.lib', 'dwmapi.lib', 'user32.lib', 'gdi32.lib', 'shlwapi.lib'
  ], environment);
} finally {
  await rm(object, { force: true });
}
process.stdout.write(`${output}\n`);

async function latestSdkVersion(includeRoot) {
  const versions = (await readdir(includeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^10\./.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    try {
      await access(join(includeRoot, version, 'um', 'windows.h'));
      return version;
    } catch {
      // Continue to the next installed Windows SDK.
    }
  }
  throw new Error('WINDOWS_SDK_NOT_FOUND');
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Continue to the next installed locator.
    }
  }
  return null;
}

function run(file, args, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, args, { env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(`NATIVE_WINDOW_HOST_BUILD_FAILED:${stderr || stdout || error.message}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}
