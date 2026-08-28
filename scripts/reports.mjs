import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const args = readArgs(process.argv.slice(2));
const command = args._[0] ?? 'doctor';
const reportRoot = resolve(args.root ?? join(process.cwd(), 'reports'));
const olderThanDays = readPositiveNumber(args.olderThanDays ?? '30', 'OLDER_THAN_DAYS_INVALID');
const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1_000;
const currentDocumentUuid = args.documentUuid ?? process.env.COCOS_AI_CURRENT_DOCUMENT_UUID ?? null;

if (!['doctor', 'archive', 'prune'].includes(command)) throw new Error(`REPORT_COMMAND_INVALID:${command}`);
const result = command === 'doctor'
  ? await doctorReports()
  : command === 'archive'
    ? await archiveReports(args.confirm === true)
    : await pruneArchive(args.confirm === true);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function doctorReports() {
  const files = await walkFiles(reportRoot);
  const categories = new Map();
  for (const file of files) {
    const category = classify(relative(reportRoot, file.path));
    const summary = categories.get(category) ?? {
      category,
      files: 0,
      bytes: 0,
      staleFiles: 0,
      referencedFiles: 0,
      oldestModifiedAt: null,
      newestModifiedAt: null
    };
    summary.files += 1;
    summary.bytes += file.size;
    if (file.mtimeMs <= cutoffMs) summary.staleFiles += 1;
    if (currentDocumentUuid && await containsDocumentUuid(file, currentDocumentUuid)) {
      summary.referencedFiles += 1;
    }
    const modifiedAt = new Date(file.mtimeMs).toISOString();
    if (!summary.oldestModifiedAt || modifiedAt < summary.oldestModifiedAt) summary.oldestModifiedAt = modifiedAt;
    if (!summary.newestModifiedAt || modifiedAt > summary.newestModifiedAt) summary.newestModifiedAt = modifiedAt;
    categories.set(category, summary);
  }
  return {
    command: 'doctor',
    reportRoot,
    olderThanDays,
    currentDocumentUuid,
    referenceStatus: currentDocumentUuid ? 'scanned-small-text-files' : 'document-uuid-not-provided',
    totals: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
      staleFiles: files.filter((file) => file.mtimeMs <= cutoffMs).length
    },
    categories: [...categories.values()].sort((left, right) => right.bytes - left.bytes)
  };
}

async function archiveReports(confirm) {
  const candidates = await collectArchiveCandidates();
  const archiveRoot = join(reportRoot, 'archive', new Date().toISOString().replace(/[^0-9]/g, ''));
  if (confirm) {
    for (const candidate of candidates) {
      const target = resolve(archiveRoot, candidate.relativePath);
      assertInside(archiveRoot, target);
      await mkdir(resolve(target, '..'), { recursive: true });
      await rename(candidate.path, target);
    }
  }
  return {
    command: 'archive',
    dryRun: !confirm,
    reportRoot,
    archiveRoot,
    olderThanDays,
    candidates: candidates.map(({ relativePath, bytes, modifiedAt }) => ({ relativePath, bytes, modifiedAt })),
    moved: confirm ? candidates.length : 0
  };
}

async function pruneArchive(confirm) {
  const archiveRoot = resolve(reportRoot, 'archive');
  assertInside(reportRoot, archiveRoot);
  const entries = await readDirectoryEntries(archiveRoot);
  const candidates = entries.filter((entry) => entry.mtimeMs <= cutoffMs);
  if (confirm) {
    for (const candidate of candidates) {
      assertInside(archiveRoot, candidate.path);
      await rm(candidate.path, { recursive: true, force: true });
    }
  }
  return {
    command: 'prune',
    dryRun: !confirm,
    archiveRoot,
    olderThanDays,
    candidates: candidates.map(({ name, modifiedAt }) => ({ name, modifiedAt })),
    removed: confirm ? candidates.length : 0
  };
}

async function collectArchiveCandidates() {
  const entries = await readDirectoryEntries(reportRoot);
  const candidates = [];
  for (const entry of entries) {
    if (entry.name === 'archive' || entry.name === 'mcp' || entry.mtimeMs > cutoffMs) continue;
    if (
      entry.name.startsWith('phase-')
      || entry.name.startsWith('debug-')
      || entry.name.endsWith('.log')
    ) candidates.push({ ...entry, relativePath: entry.name });
  }
  const captureRoot = join(reportRoot, 'runtime-captures');
  for (const entry of await readDirectoryEntries(captureRoot)) {
    if (entry.mtimeMs <= cutoffMs) {
      candidates.push({ ...entry, relativePath: join('runtime-captures', entry.name) });
    }
  }
  return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walkFiles(root) {
  const output = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        output.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };
  await visit(root);
  return output;
}

async function readDirectoryEntries(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
    const path = join(directory, entry.name);
    const info = await stat(path);
    return {
      name: entry.name,
      path,
      bytes: entry.isFile() ? info.size : 0,
      mtimeMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString()
    };
  }));
}

async function containsDocumentUuid(file, documentUuid) {
  if (file.size > 2 * 1024 * 1024) return false;
  if (!['.json', '.md', '.txt', '.log'].includes(extname(file.path).toLowerCase())) return false;
  return (await readFile(file.path, 'utf8')).includes(documentUuid);
}

function classify(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('runtime-captures/')) return 'runtime-captures';
  if (normalized.startsWith('mcp/')) return 'mcp';
  if (normalized.startsWith('archive/')) return 'archive';
  if (normalized.startsWith('phase-')) return 'phase';
  if (normalized.startsWith('debug-')) return 'debug';
  if (normalized.endsWith('.log')) return 'logs';
  return 'other';
}

function assertInside(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  if (!relativePath || relativePath === '.') return;
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath.split(sep).includes('..')) {
    throw new Error(`REPORT_PATH_OUTSIDE_ROOT:${target}`);
  }
}

function readArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (key === 'confirm') result.confirm = true;
    else result[key] = values[++index];
  }
  return result;
}

function readPositiveNumber(value, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(code);
  return number;
}
