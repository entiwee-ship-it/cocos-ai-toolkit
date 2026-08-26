import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = resolve(process.argv[2] ?? join(repoRoot, 'packages', 'bridge-extension', 'dist'));
const manifest = JSON.parse(await readFile(join(repoRoot, 'packages', 'bridge-extension', 'package.json'), 'utf8'));
const files = (await listJavaScriptFiles(distDirectory)).sort();
if (files.length === 0) throw new Error(`BRIDGE_DIST_EMPTY:${distDirectory}`);

const hash = createHash('sha256');
for (const file of files) {
  hash.update(relative(distDirectory, file).replaceAll('\\', '/'));
  hash.update('\0');
  hash.update(await readFile(file));
  hash.update('\0');
}
const buildId = `sha256:${hash.digest('hex')}`;
await writeFile(join(distDirectory, 'build-info.json'), `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  buildId
}, null, 2)}\n`);
process.stdout.write(`${buildId}\n`);

async function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}
