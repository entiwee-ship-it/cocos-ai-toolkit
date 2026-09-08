import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = resolve(process.argv[2] ?? join(repoRoot, 'packages', 'bridge-extension', 'dist'));
const staticDirectory = resolve(process.argv[3] ?? join(repoRoot, 'packages', 'bridge-extension', 'static'));
const manifest = JSON.parse(await readFile(join(repoRoot, 'packages', 'bridge-extension', 'package.json'), 'utf8'));
const distFiles = (await listFiles(distDirectory)).filter((file) => /\.(?:exe|js)$/i.test(file));
if (!distFiles.some((file) => file.endsWith('.js'))) throw new Error(`BRIDGE_DIST_EMPTY:${distDirectory}`);
const files = [
  ...distFiles.map((file) => ({ file, key: `dist/${relative(distDirectory, file).replaceAll('\\', '/')}` })),
  ...(await listFiles(staticDirectory)).map((file) => ({
    file,
    key: `static/${relative(staticDirectory, file).replaceAll('\\', '/')}`
  }))
].sort((left, right) => left.key.localeCompare(right.key));

const hash = createHash('sha256');
for (const { file, key } of files) {
  hash.update(key);
  hash.update('\0');
  hash.update(await readHashContent(file));
  hash.update('\0');
}
const buildId = `sha256:${hash.digest('hex')}`;
await writeFile(join(distDirectory, 'build-info.json'), `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  buildId
}, null, 2)}\n`);
process.stdout.write(`${buildId}\n`);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function readHashContent(file) {
  const content = await readFile(file);
  return ['.css', '.html', '.js', '.json', '.map', '.svg', '.txt'].includes(extname(file).toLowerCase())
    ? Buffer.from(content.toString('utf8').replaceAll('\r\n', '\n'))
    : content;
}
