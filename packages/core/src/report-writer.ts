import {
  DocumentSnapshotSchema,
  ProjectScanAssetIndexArtifactSchema,
  ProjectScanReportManifestSchema,
  ProjectScanReportSchema,
  type DocumentSnapshot,
  type ProjectScanArtifactReference
} from '@cocos-ai/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { z } from 'zod';
import {
  parseScanCheckpoint,
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
 * 使用压缩文档快照、轻量 checkpoint 和有界 manifest 保存扫描产物。
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
    const fileName = `${createHash('sha256').update(assetUuid).digest('hex')}.json.gz`;
    const snapshotPath = join(snapshotDirectory, fileName);
    const serialized = `${JSON.stringify(snapshot)}\n`;
    const digest = await writeGzipTextAtomically(
      snapshotPath,
      serialized,
      this.reportRoot
    );
    return createDocumentReference(
      snapshot,
      normalizeRelativePath(relative(dirname(this.checkpointPath), snapshotPath)),
      digest.sha256
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
   * 读取最终 checkpoint，写入独立压缩资产索引，并以小型 manifest 收口扫描产物。
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
    const checkpointPath = await resolveExistingArtifactPath(
      this.checkpointPath,
      this.reportRoot
    );
    const checkpointSource = await readTextArtifact(checkpointPath, false);
    const checkpoint = parseScanCheckpoint(JSON.parse(checkpointSource.raw));
    const result = assertFinalCheckpointMatchesReport(checkpoint, metadata, documents);

    const assetIndex = ProjectScanAssetIndexArtifactSchema.parse({
      formatVersion: 1,
      scanId: checkpoint.scanId,
      assets: metadata.assets,
      scripts: metadata.scripts
    });
    const assetIndexPath = createAssetIndexPath(this.reportPath);
    const assetIndexDigest = await writeGzipTextAtomically(
      assetIndexPath,
      `${JSON.stringify(assetIndex)}\n`,
      this.reportRoot
    );
    const snapshotEncodings = countSnapshotEncodings(checkpoint.documents);
    const manifest = ProjectScanReportManifestSchema.parse({
      formatVersion: 2,
      scanId: checkpoint.scanId,
      status: result.status,
      project: result.project,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      scanParameters: checkpoint.parameters,
      summary: {
        assets: result.assetCount,
        scripts: result.scriptCount,
        documents: checkpoint.assetUuids.length,
        completedDocuments: checkpoint.documents.length,
        failedDocuments: checkpoint.failures.length,
        prefabGraphNodes: result.prefabGraph.nodes.length,
        prefabGraphEdges: result.prefabGraph.edges.length,
        prefabGraphBlocked: result.prefabGraph.blocked,
        unresolved: result.unresolvedCount,
        diagnostics: result.diagnostics.length
      },
      coverage: result.coverage,
      artifacts: {
        checkpoint: createArtifactReference(
          this.reportPath,
          this.checkpointPath,
          checkpointSource,
          'json'
        ),
        assetIndex: createArtifactReference(
          this.reportPath,
          assetIndexPath,
          assetIndexDigest,
          'json-gzip'
        ),
        documentSnapshots: {
          count: checkpoint.documents.length,
          gzipCount: snapshotEncodings.gzip,
          jsonCount: snapshotEncodings.json
        }
      }
    });
    await writeJsonAtomically(this.reportPath, manifest, this.reportRoot);
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
    const source = await readTextArtifact(
      snapshotPath,
      document.snapshotPath.toLowerCase().endsWith('.gz')
    );
    if (source.sha256 !== document.snapshotHash) {
      throw new Error('SCAN_SNAPSHOT_HASH_MISMATCH');
    }
    const raw = source.raw;
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

interface ArtifactDigest {
  /** 文件原始字节的 SHA-256。 */
  sha256: string;

  /** 文件实际写入或读取的原始字节数。 */
  bytes: number;
}

interface TextArtifactSource extends ArtifactDigest {
  /** JSON 文本；gzip 文件在返回前已经完成解压。 */
  raw: string;
}

/**
 * 确认最终 checkpoint 与待写 manifest 的内存结果完全对应。
 *
 * @param checkpoint 已经原子落盘并重新解析的最终 checkpoint。
 * @param report 扫描器生成的不含文档快照的报告元数据。
 * @param documents 本次扫描按资产顺序生成的文档快照引用。
 * @returns checkpoint 内可用于生成 manifest 的最终结果。
 */
function assertFinalCheckpointMatchesReport(
  checkpoint: ScanCheckpoint,
  report: ProjectScanReportMetadata,
  documents: ScanCheckpointDocument[]
): NonNullable<ScanCheckpoint['result']> {
  const result = checkpoint.result;
  if (!result) throw new Error('SCAN_CHECKPOINT_RESULT_MISSING');
  const documentMismatch = checkpoint.documents.length !== documents.length
    || checkpoint.documents.some((document, index) => {
      const expected = documents[index];
      return !expected
        || document.assetUuid !== expected.assetUuid
        || document.revision !== expected.revision
        || document.snapshotPath !== expected.snapshotPath
        || document.snapshotHash !== expected.snapshotHash;
    });
  if (
    checkpoint.scanId !== report.scanId
    || result.status !== report.status
    || JSON.stringify(result.project) !== JSON.stringify(report.project)
    || result.startedAt !== report.startedAt
    || result.finishedAt !== report.finishedAt
    || result.assetCount !== report.assets.length
    || result.scriptCount !== report.scripts.length
    || result.unresolvedCount !== report.unresolved.length
    || result.diagnostics.length !== report.diagnostics.length
    || JSON.stringify(result.prefabGraph) !== JSON.stringify(report.prefabGraph)
    || JSON.stringify(result.coverage) !== JSON.stringify(report.coverage)
    || documentMismatch
  ) {
    throw new Error('SCAN_REPORT_CHECKPOINT_MISMATCH');
  }
  return result;
}

/**
 * 为主报告生成同目录、同前缀的压缩资产索引路径。
 *
 * @param reportPath 主报告目标路径。
 * @returns 压缩资产索引目标路径。
 */
function createAssetIndexPath(reportPath: string): string {
  return reportPath.toLowerCase().endsWith('.json')
    ? `${reportPath.slice(0, -'.json'.length)}.assets.json.gz`
    : `${reportPath}.assets.json.gz`;
}

/**
 * 把已落盘产物转换为相对主报告目录的 manifest 引用。
 *
 * @param reportPath 主报告目标路径。
 * @param artifactPath 被引用产物的目标路径。
 * @param digest 被引用产物的真实摘要和字节数。
 * @param encoding 被引用产物的 JSON 编码方式。
 * @returns 可通过协议 Schema 校验的产物引用。
 */
function createArtifactReference(
  reportPath: string,
  artifactPath: string,
  digest: ArtifactDigest,
  encoding: ProjectScanArtifactReference['encoding']
): ProjectScanArtifactReference {
  return {
    path: normalizeRelativePath(relative(dirname(reportPath), artifactPath)),
    sha256: digest.sha256,
    bytes: digest.bytes,
    encoding
  };
}

/**
 * 统计 checkpoint 引用的新 gzip 分片和旧 JSON 分片数量。
 *
 * @param documents 最终 checkpoint 中的文档快照引用。
 * @returns gzip 为压缩分片数，json 为旧未压缩分片数。
 */
function countSnapshotEncodings(documents: ScanCheckpointDocument[]): {
  gzip: number;
  json: number;
} {
  let gzip = 0;
  let json = 0;
  for (const document of documents) {
    const path = document.snapshotPath.toLowerCase();
    if (path.endsWith('.json.gz')) {
      gzip += 1;
    } else if (path.endsWith('.json')) {
      json += 1;
    } else {
      throw new Error(`SCAN_SNAPSHOT_ENCODING_UNSUPPORTED:${document.snapshotPath}`);
    }
  }
  return { gzip, json };
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
 * 以 gzip 流写入文本，并在压缩字节进入磁盘前同步计算摘要。
 *
 * @param path 最终 gzip 文件路径。
 * @param value 待压缩的 UTF-8 文本。
 * @param reportRoot 调用方授权的报告根目录。
 * @returns 压缩文件的 SHA-256 和实际字节数。
 */
async function writeGzipTextAtomically(
  path: string,
  value: string,
  reportRoot?: string
): Promise<ArtifactDigest> {
  let written: ArtifactDigest | null = null;
  await writeAtomically(path, reportRoot, async (temporaryPath) => {
    const measured = createDigestTransform();
    await pipeline(
      Readable.from([value]),
      createGzip(),
      measured.stream,
      createWriteStream(temporaryPath, { flags: 'wx' })
    );
    written = measured.digest();
  });
  if (!written) throw new Error('REPORT_GZIP_WRITE_INCOMPLETE');
  return written;
}

/**
 * 流式读取 JSON 或 gzip JSON，并按磁盘原始字节计算摘要。
 *
 * @param path 待读取的产物路径。
 * @param gzip 是否在收集 UTF-8 文本前执行 gzip 解压。
 * @returns 解压后的文本以及磁盘文件的 SHA-256 和字节数。
 */
async function readTextArtifact(path: string, gzip: boolean): Promise<TextArtifactSource> {
  const measured = createDigestTransform();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(decoder.decode(chunk, { stream: true }));
      callback();
    },
    final(callback) {
      const tail = decoder.decode();
      if (tail) chunks.push(tail);
      callback();
    }
  });
  if (gzip) {
    await pipeline(
      createReadStream(path),
      measured.stream,
      createGunzip(),
      collector
    );
  } else {
    await pipeline(createReadStream(path), measured.stream, collector);
  }
  return {
    raw: chunks.join(''),
    ...measured.digest()
  };
}

/**
 * 创建透传字节且累计 SHA-256 和长度的流组件。
 *
 * @returns stream 为可插入 pipeline 的透传流，digest 用于在流结束后读取摘要。
 */
function createDigestTransform(): {
  stream: Transform;
  digest: () => ArtifactDigest;
} {
  const hash = createHash('sha256');
  let bytes = 0;
  return {
    stream: new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        bytes += buffer.byteLength;
        callback(null, buffer);
      }
    }),
    digest: () => ({
      sha256: hash.digest('hex'),
      bytes
    })
  };
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

/**
 * 解析已存在的报告产物，并在提供授权根时复核真实路径边界。
 *
 * @param path 待读取的现有产物路径。
 * @param reportRoot 调用方授权的报告根目录。
 * @returns 可安全读取的真实绝对路径。
 */
async function resolveExistingArtifactPath(
  path: string,
  reportRoot?: string
): Promise<string> {
  const target = resolve(path);
  if (!reportRoot) return target;
  const canonicalRoot = await realpath(reportRoot);
  const canonicalTarget = await realpath(target);
  assertWithinRoot(canonicalRoot, canonicalTarget);
  return canonicalTarget;
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
