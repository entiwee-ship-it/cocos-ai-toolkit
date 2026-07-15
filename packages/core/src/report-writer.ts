import {
  DocumentSnapshotSchema,
  ProjectScanReportSchema,
  type DocumentSnapshot
} from '@cocos-ai/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import { z } from 'zod';
import {
  type ScanCheckpoint,
  type ScanCheckpointDocument
} from './scan-checkpoint.js';

const ProjectScanReportMetadataSchema = ProjectScanReportSchema
  .omit({ documents: true })
  .strip();

/** Windows 短时文件锁允许的原子重命名最大尝试次数。 */
const ATOMIC_RENAME_MAX_ATTEMPTS = 10;

/** 原子重命名首次退避毫秒数。 */
const ATOMIC_RENAME_RETRY_BASE_MS = 25;

/** 原子重命名单次退避的最大毫秒数。 */
const ATOMIC_RENAME_RETRY_MAX_MS = 250;

/** 只对可能由短时文件锁触发的错误码重试。 */
const RETRIABLE_ATOMIC_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export type ProjectScanReportMetadata = z.infer<typeof ProjectScanReportMetadataSchema>;

export interface ScanReportWriter {
  writeDocument(snapshot: DocumentSnapshot): Promise<ScanCheckpointDocument>;
  readDocument(document: ScanCheckpointDocument): Promise<DocumentSnapshot>;
  writeCheckpoint(checkpoint: ScanCheckpoint): Promise<string | null>;
  writeReport(
    report: ProjectScanReportMetadata,
    documents: ScanCheckpointDocument[]
  ): Promise<string | null>;
}

/**
 * 不写磁盘的报告写入器，供测试和只需要进程内结果的调用方使用。
 */
export class NoopScanReportWriter implements ScanReportWriter {
  private readonly snapshots = new Map<string, DocumentSnapshot>();

  async writeDocument(snapshot: DocumentSnapshot): Promise<ScanCheckpointDocument> {
    const document = createDocumentReference(snapshot, `memory/${randomUUID()}.json`);
    this.snapshots.set(document.snapshotPath, structuredClone(snapshot));
    return document;
  }

  async readDocument(document: ScanCheckpointDocument): Promise<DocumentSnapshot> {
    const snapshot = this.snapshots.get(document.snapshotPath);
    if (!snapshot) throw new Error('SCAN_SNAPSHOT_NOT_FOUND');
    return structuredClone(snapshot);
  }

  async writeCheckpoint(_checkpoint: ScanCheckpoint): Promise<string | null> {
    return null;
  }

  async writeReport(
    _report: ProjectScanReportMetadata,
    _documents: ScanCheckpointDocument[]
  ): Promise<string | null> {
    return null;
  }
}

/**
 * 使用独立文档快照文件、轻量 checkpoint 和流式最终 JSON 报告保存扫描产物。
 *
 * @param reportPath 最终项目报告路径。
 * @param checkpointPath 最终 checkpoint 路径。
 * @param reportRoot 调用方授权的报告根目录；提供后每次写入前重新验证边界。
 */
export class JsonScanReportWriter implements ScanReportWriter {
  constructor(
    private readonly reportPath: string,
    private readonly checkpointPath: string,
    private readonly reportRoot?: string
  ) {}

  /**
   * 把单个完整文档快照原子写入 checkpoint 同目录下的受控快照目录。
   *
   * @param snapshot 已完成分页合并和协议校验的完整文档快照。
   * @returns checkpoint 可持久化的轻量引用、摘要和覆盖率。
   */
  async writeDocument(snapshot: DocumentSnapshot): Promise<ScanCheckpointDocument> {
    const assetUuid = snapshot.document.assetUuid;
    if (!assetUuid) throw new Error('SCAN_SNAPSHOT_IDENTITY_MISSING');
    const snapshotDirectory = `${this.checkpointPath}.documents`;
    await ensureAuthorizedDirectory(snapshotDirectory, this.reportRoot);
    const fileName = `${createHash('sha256').update(assetUuid).digest('hex')}.json`;
    const snapshotPath = join(snapshotDirectory, fileName);
    const serialized = `${JSON.stringify(snapshot)}\n`;
    await writeTextAtomically(snapshotPath, serialized, this.reportRoot);
    return createDocumentReference(
      snapshot,
      normalizeRelativePath(relative(dirname(this.checkpointPath), snapshotPath)),
      hashText(serialized)
    );
  }

  /**
   * 从受控快照目录读取单个文档，并复核内容哈希、资产身份和 Revision。
   *
   * @param document checkpoint 中的轻量文档引用。
   * @returns 经过协议校验的完整文档快照。
   */
  async readDocument(document: ScanCheckpointDocument): Promise<DocumentSnapshot> {
    const { snapshot } = await this.readDocumentSource(document);
    return snapshot;
  }

  /**
   * 写入最新 checkpoint。
   *
   * @param checkpoint 待保存的扫描进度。
   * @returns 实际写入路径。
   */
  async writeCheckpoint(checkpoint: ScanCheckpoint): Promise<string> {
    await writeJsonAtomically(this.checkpointPath, checkpoint, this.reportRoot);
    return this.checkpointPath;
  }

  /**
   * 逐个读取文档快照并流式拼装最终完整项目报告，避免创建整份巨大 JSON 字符串。
   *
   * @param report 不含 documents 的项目报告元数据。
   * @param documents 按资产清单顺序排列的文档快照引用。
   * @returns 实际写入路径。
   */
  async writeReport(
    report: ProjectScanReportMetadata,
    documents: ScanCheckpointDocument[]
  ): Promise<string> {
    const metadata = ProjectScanReportMetadataSchema.parse(report);
    await writeAtomically(this.reportPath, this.reportRoot, async (temporaryPath) => {
      const handle = await open(temporaryPath, 'wx');
      try {
        await handle.write('{\n  "documents": [');
        for (let index = 0; index < documents.length; index += 1) {
          const { raw } = await this.readDocumentSource(documents[index]);
          await handle.write(index === 0 ? '\n' : ',\n');
          await handle.write(raw.trimEnd());
        }
        if (documents.length > 0) await handle.write('\n');
        const metadataJson = JSON.stringify(metadata, null, 2);
        await handle.write(`  ],\n${metadataJson.slice(2, -2)}\n}\n`);
      } finally {
        await handle.close();
      }
    });
    return this.reportPath;
  }

  private async readDocumentSource(document: ScanCheckpointDocument): Promise<{
    raw: string;
    snapshot: DocumentSnapshot;
  }> {
    const snapshotPath = await resolveSnapshotPath(
      this.checkpointPath,
      document.snapshotPath,
      this.reportRoot
    );
    const raw = await readFile(snapshotPath, 'utf8');
    if (hashText(raw) !== document.snapshotHash) throw new Error('SCAN_SNAPSHOT_HASH_MISMATCH');
    const snapshot = DocumentSnapshotSchema.parse(JSON.parse(raw));
    if (
      snapshot.document.assetUuid !== document.assetUuid
      || snapshot.revision !== document.revision
    ) {
      throw new Error('SCAN_SNAPSHOT_IDENTITY_MISMATCH');
    }
    return { raw, snapshot };
  }
}

function createDocumentReference(
  snapshot: DocumentSnapshot,
  snapshotPath: string,
  snapshotHash = hashText(`${JSON.stringify(snapshot)}\n`)
): ScanCheckpointDocument {
  const assetUuid = snapshot.document.assetUuid;
  if (!assetUuid) throw new Error('SCAN_SNAPSHOT_IDENTITY_MISSING');
  return {
    assetUuid,
    revision: snapshot.revision,
    snapshotPath,
    snapshotHash,
    summary: {
      path: snapshot.document.path,
      documentType: snapshot.document.documentType,
      nodes: snapshot.nodes.length,
      components: snapshot.componentSchemas.length,
      prefabInstances: snapshot.prefabInstances.length,
      unresolved: snapshot.unresolved.length,
      diagnostics: snapshot.diagnostics.length
    },
    coverage: snapshot.coverage
  };
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
  reportRoot?: string
): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`, reportRoot);
}

async function writeTextAtomically(
  path: string,
  value: string,
  reportRoot?: string
): Promise<void> {
  await writeAtomically(path, reportRoot, async (temporaryPath) => {
    await writeFile(temporaryPath, value, { encoding: 'utf8', flag: 'wx' });
  });
}

/**
 * 先写唯一临时文件，再在授权目录内原子替换目标文件。
 *
 * @param path 最终目标路径。
 * @param reportRoot 调用方授权的报告根目录。
 * @param writeTemporary 把完整内容写入唯一临时路径的回调。
 */
async function writeAtomically(
  path: string,
  reportRoot: string | undefined,
  writeTemporary: (temporaryPath: string) => Promise<void>
): Promise<void> {
  const targetPath = reportRoot
    ? await resolveAuthorizedTarget(path, reportRoot)
    : path;
  if (!reportRoot) await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeTemporary(temporaryPath);
    if (reportRoot) {
      const revalidatedTarget = await resolveAuthorizedTarget(path, reportRoot);
      if (!pathsEqual(targetPath, revalidatedTarget)) throw new Error('REPORT_PATH_OUTSIDE_ROOT');
    }
    await renameAtomicallyWithRetry(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 在 Windows 短时文件锁阻止替换时有限退避重试原子重命名。
 *
 * @param temporaryPath 已完整写入且句柄关闭的临时文件路径。
 * @param targetPath 要原子替换的最终文件路径。
 */
async function renameAtomicallyWithRetry(
  temporaryPath: string,
  targetPath: string
): Promise<void> {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (
        !isRetriableAtomicRenameError(error)
        || attempt === ATOMIC_RENAME_MAX_ATTEMPTS
      ) {
        throw error;
      }

      const delayMs = Math.min(
        ATOMIC_RENAME_RETRY_MAX_MS,
        ATOMIC_RENAME_RETRY_BASE_MS * (2 ** (attempt - 1))
      );
      await waitForAtomicRenameRetry(delayMs);
    }
  }
}

/**
 * 判断文件系统错误是否可能来自 Windows 短时文件锁。
 *
 * @param error 原子重命名抛出的未知错误。
 * @returns 是否允许保持临时文件并再次尝试重命名。
 */
function isRetriableAtomicRenameError(error: unknown): error is NodeJS.ErrnoException {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return RETRIABLE_ATOMIC_RENAME_CODES.has(
    String((error as NodeJS.ErrnoException).code)
  );
}

/**
 * 等待下一次原子重命名重试。
 *
 * @param delayMs 本次退避毫秒数。
 */
async function waitForAtomicRenameRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

async function ensureAuthorizedDirectory(path: string, reportRoot?: string): Promise<void> {
  if (!reportRoot) {
    await mkdir(path, { recursive: true });
    return;
  }
  const canonicalRoot = await realpath(reportRoot);
  const parent = dirname(path);
  const canonicalParent = await realpath(parent);
  assertWithinRoot(canonicalRoot, canonicalParent);
  await mkdir(path, { recursive: true });
  const canonicalDirectory = await realpath(path);
  assertWithinRoot(canonicalRoot, canonicalDirectory);
}

async function resolveSnapshotPath(
  checkpointPath: string,
  snapshotPath: string,
  reportRoot?: string
): Promise<string> {
  const target = resolve(dirname(checkpointPath), snapshotPath);
  if (reportRoot) {
    const canonicalRoot = await realpath(reportRoot);
    const canonicalTarget = await realpath(target);
    assertWithinRoot(canonicalRoot, canonicalTarget);
    return canonicalTarget;
  }
  const pathFromCheckpoint = relative(dirname(checkpointPath), target);
  if (
    pathFromCheckpoint === '..'
    || pathFromCheckpoint.startsWith(`..${sep}`)
    || isAbsolute(pathFromCheckpoint)
  ) {
    throw new Error('SCAN_SNAPSHOT_PATH_OUTSIDE_ROOT');
  }
  return target;
}

async function resolveAuthorizedTarget(path: string, reportRoot: string): Promise<string> {
  const canonicalRoot = await realpath(reportRoot);
  const canonicalParent = await realpath(dirname(path));
  assertWithinRoot(canonicalRoot, canonicalParent);
  return join(canonicalParent, basename(path));
}

function assertWithinRoot(root: string, target: string): void {
  const comparableRoot = normalizeComparablePath(root);
  const comparableTarget = normalizeComparablePath(target);
  const pathFromRoot = relative(comparableRoot, comparableTarget);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('REPORT_PATH_OUTSIDE_ROOT');
  }
}

function normalizeComparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
