import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  CoverageSchema,
  DiagnosticSchema,
  DocumentTypeSchema,
  PrefabGraphSchema,
  ProjectCoverageSchema,
  UnresolvedItemSchema,
  type UnresolvedItem
} from '@cocos-ai/protocol';

export const ScanParametersSchema = z.object({
  pageSize: z.number().int().min(1).max(500),
  includeRaw: z.boolean(),
  concurrency: z.number().int().min(1).max(4)
}).strict();

export const ScanCheckpointFailureSchema = z.object({
  assetUuid: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
}).strict();

export const ScanDocumentSummarySchema = z.object({
  path: z.string().nullable(),
  documentType: DocumentTypeSchema.nullable(),
  nodes: z.number().int().nonnegative(),
  components: z.number().int().nonnegative(),
  prefabInstances: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  diagnostics: z.number().int().nonnegative()
}).strict();

export const ScanCheckpointDocumentSchema = z.object({
  assetUuid: z.string().min(1),
  revision: z.string().min(1),
  snapshotPath: z.string().min(1),
  snapshotHash: z.string().min(1),
  summary: ScanDocumentSummarySchema,
  coverage: CoverageSchema
}).strict().superRefine((document, context) => {
  const segments = document.snapshotPath.split(/[\\/]+/);
  if (
    document.snapshotPath.includes('\0')
    || document.snapshotPath.includes(':')
    || isAbsolute(document.snapshotPath)
    || segments.includes('..')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['snapshotPath'],
      message: 'snapshotPath 必须是 checkpoint 目录内的安全相对路径'
    });
  }
});

export const ScanCheckpointResultSchema = z.object({
  status: z.enum(['completed', 'completed-with-gaps', 'failed']),
  project: z.object({
    projectId: z.string().min(1),
    projectPath: z.string().min(1),
    creatorVersion: z.string().min(1)
  }).strict(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  assetCount: z.number().int().nonnegative(),
  scriptCount: z.number().int().nonnegative(),
  prefabGraph: PrefabGraphSchema,
  coverage: ProjectCoverageSchema,
  unresolvedCount: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema)
}).strict();

export const ScanCheckpointSchema = z.object({
  version: z.literal(2),
  scanId: z.string().min(1),
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1),
  projectPath: z.string().min(1),
  creatorVersion: z.string().min(1),
  bridgeVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  parameters: ScanParametersSchema,
  parametersHash: z.string().min(1),
  assetManifestHash: z.string().min(1),
  assetUuids: z.array(z.string().min(1)),
  completedAssetUuids: z.array(z.string().min(1)),
  failures: z.array(ScanCheckpointFailureSchema),
  documents: z.array(ScanCheckpointDocumentSchema),
  unresolved: z.array(UnresolvedItemSchema),
  result: ScanCheckpointResultSchema.nullable(),
  updatedAt: z.string().datetime()
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.parametersHash !== createParametersHash(checkpoint.parameters)) {
    context.addIssue({
      code: 'custom',
      path: ['parametersHash'],
      message: 'parametersHash 与 parameters 不一致'
    });
  }
  if (new Set(checkpoint.assetUuids).size !== checkpoint.assetUuids.length) {
    context.addIssue({ code: 'custom', path: ['assetUuids'], message: 'assetUuids 存在重复值' });
  }
  if (new Set(checkpoint.completedAssetUuids).size !== checkpoint.completedAssetUuids.length) {
    context.addIssue({
      code: 'custom',
      path: ['completedAssetUuids'],
      message: 'completedAssetUuids 存在重复值'
    });
  }
  const assetUuids = new Set(checkpoint.assetUuids);
  const completedAssetUuids = new Set(checkpoint.completedAssetUuids);
  const documentAssetUuids = new Set<string>();
  for (const document of checkpoint.documents) {
    const assetUuid = document.assetUuid;
    if (
      !assetUuid
      || !assetUuids.has(assetUuid)
      || !completedAssetUuids.has(assetUuid)
      || documentAssetUuids.has(assetUuid)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `文档资产身份无效或重复: ${assetUuid ?? 'null'}`
      });
      continue;
    }
    documentAssetUuids.add(assetUuid);
  }
  const failureAssetUuids = new Set<string>();
  for (const failure of checkpoint.failures) {
    if (
      !assetUuids.has(failure.assetUuid)
      || !completedAssetUuids.has(failure.assetUuid)
      || failureAssetUuids.has(failure.assetUuid)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['failures'],
        message: `失败资产身份无效或重复: ${failure.assetUuid}`
      });
      continue;
    }
    failureAssetUuids.add(failure.assetUuid);
  }
  for (const assetUuid of checkpoint.completedAssetUuids) {
    if (!assetUuids.has(assetUuid)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAssetUuids'],
        message: `已完成资产不在清单中: ${assetUuid}`
      });
    }
    if (documentAssetUuids.has(assetUuid) === failureAssetUuids.has(assetUuid)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAssetUuids'],
        message: `已完成资产必须且只能对应快照或失败记录: ${assetUuid}`
      });
    }
  }
});

export type ScanParameters = z.infer<typeof ScanParametersSchema>;
export type ScanCheckpointFailure = z.infer<typeof ScanCheckpointFailureSchema>;
export type ScanDocumentSummary = z.infer<typeof ScanDocumentSummarySchema>;
export type ScanCheckpointDocument = z.infer<typeof ScanCheckpointDocumentSchema>;
export type ScanCheckpointResult = z.infer<typeof ScanCheckpointResultSchema>;
export type ScanCheckpoint = z.infer<typeof ScanCheckpointSchema>;

/*
 * 下面的类型只描述扫描器构造 checkpoint 所需的当前环境。
 */
export interface ScanCheckpointContext {
  projectId: string;
  editorInstanceId: string;
  projectPath: string;
  creatorVersion: string;
  bridgeVersion: string;
  protocolVersion: string;
  parameters: ScanParameters;
  assetManifestHash: string;
  assetUuids: string[];
}

/**
 * 把外部 JSON 收窄为可信 checkpoint。
 *
 * @param value 从报告目录读取的未知 JSON。
 * @returns 通过结构和内部一致性校验的 checkpoint。
 */
export function parseScanCheckpoint(value: unknown): ScanCheckpoint {
  const result = ScanCheckpointSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`SCAN_CHECKPOINT_INVALID:${result.error.message}`);
  }
  return result.data;
}

/**
 * 为资产清单生成与顺序无关的 SHA-256 指纹。
 *
 * @param assets AssetDB 返回的完整资产记录。
 * @param documents AssetDB 识别出的 Scene/Prefab 记录。
 * @returns 资产清单指纹。
 */
export function createAssetManifestHash(assets: unknown[], documents: unknown[]): string {
  return hashValue({
    assets: assets.map(toManifestRecord).sort(compareManifestRecords),
    documents: documents.map(toManifestRecord).sort(compareManifestRecords)
  });
}

/**
 * 为扫描参数生成稳定指纹，防止不同分页或原始数据选项混用 checkpoint。
 *
 * @param parameters 本次扫描的分页、原始数据和并发配置。
 * @returns 参数指纹。
 */
export function createParametersHash(parameters: ScanParameters): string {
  return hashValue(parameters);
}

/**
 * 创建新的项目扫描 checkpoint。
 *
 * @param input 扫描身份、版本、资产清单和参数。
 * @returns 可在每个资产完成后更新的 checkpoint。
 */
export function createScanCheckpoint(input: {
  scanId: string;
  context: ScanCheckpointContext;
  documents?: ScanCheckpointDocument[];
  completedAssetUuids?: string[];
  failures?: ScanCheckpointFailure[];
  unresolved?: UnresolvedItem[];
  result?: ScanCheckpointResult | null;
  updatedAt?: string;
}): ScanCheckpoint {
  return {
    version: 2,
    scanId: input.scanId,
    projectId: input.context.projectId,
    editorInstanceId: input.context.editorInstanceId,
    projectPath: input.context.projectPath,
    creatorVersion: input.context.creatorVersion,
    bridgeVersion: input.context.bridgeVersion,
    protocolVersion: input.context.protocolVersion,
    parameters: input.context.parameters,
    parametersHash: createParametersHash(input.context.parameters),
    assetManifestHash: input.context.assetManifestHash,
    assetUuids: [...input.context.assetUuids],
    completedAssetUuids: [...(input.completedAssetUuids ?? [])],
    failures: [...(input.failures ?? [])],
    documents: [...(input.documents ?? [])],
    unresolved: [...(input.unresolved ?? [])],
    result: input.result ?? null,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  };
}

/**
 * 校验 checkpoint 是否仍匹配当前编辑器、扫描参数和资产清单。
 *
 * @param checkpoint 待续扫的旧 checkpoint。
 * @param context 当前编辑器和扫描上下文。
 * @throws Error 当任一稳定身份或指纹发生变化时抛出 `SCAN_CHECKPOINT_STALE`。
 */
export function assertCheckpointCompatible(
  checkpoint: ScanCheckpoint,
  context: ScanCheckpointContext
): void {
  const mismatches: string[] = [];
  if (checkpoint.version !== 2) mismatches.push('version');
  if (checkpoint.projectId !== context.projectId) mismatches.push('projectId');
  if (checkpoint.editorInstanceId !== context.editorInstanceId) mismatches.push('editorInstanceId');
  if (checkpoint.projectPath !== context.projectPath) mismatches.push('projectPath');
  if (checkpoint.creatorVersion !== context.creatorVersion) mismatches.push('creatorVersion');
  if (checkpoint.bridgeVersion !== context.bridgeVersion) mismatches.push('bridgeVersion');
  if (checkpoint.protocolVersion !== context.protocolVersion) mismatches.push('protocolVersion');
  if (checkpoint.parametersHash !== createParametersHash(context.parameters)) mismatches.push('parameters');
  if (checkpoint.assetManifestHash !== context.assetManifestHash) mismatches.push('assetManifestHash');
  if (
    JSON.stringify([...checkpoint.assetUuids].sort())
    !== JSON.stringify([...context.assetUuids].sort())
  ) {
    mismatches.push('assetUuids');
  }
  if (mismatches.length > 0) {
    throw new Error(`SCAN_CHECKPOINT_STALE:${mismatches.join(',')}`);
  }
}

function toManifestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const raw = record.raw && typeof record.raw === 'object' && !Array.isArray(record.raw)
    ? record.raw as Record<string, unknown>
    : {};
  return {
    assetUuid: record.assetUuid ?? record.uuid ?? null,
    url: record.url ?? null,
    filePath: record.filePath ?? record.file ?? null,
    type: record.type ?? null,
    importer: record.importer ?? null,
    isSubAsset: record.isSubAsset ?? null,
    isDirectory: record.isDirectory ?? null,
    invalid: record.invalid ?? null,
    mtime: record.mtime ?? raw.mtime ?? null
  };
}

function compareManifestRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortValue(child)]));
}
