import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export async function cleanWorkspaceDist(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'cocos-ai-toolkit') {
    throw new Error(`拒绝清理非 cocos-ai-toolkit 目录: ${root}`);
  }

  const packagesRoot = join(root, 'packages');
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = resolve(packagesRoot, entry.name, 'dist');
    const targetRelative = relative(root, target);
    if (!targetRelative || targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
      throw new Error(`拒绝清理工作区外路径: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const repositoryRoot = process.argv[2] ?? resolve(dirname(scriptPath), '..');
  await cleanWorkspaceDist(repositoryRoot);
}
