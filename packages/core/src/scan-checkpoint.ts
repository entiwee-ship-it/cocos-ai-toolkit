import { createHash } from 'node:crypto';
import type {
  DocumentSnapshot,
  UnresolvedItem
} from '@cocos-ai/protocol';

export interface ScanParameters {
  pageSize: number;
  includeRaw: boolean;
  concurrency: number;
}

export interface ScanCheckpointFailure {
  assetUuid: string;
  code: string;
  message: string;
  details?: unknown;
}

export interface ScanCheckpoint {
  version: 1;
  scanId: string;
  projectId: string;
  editorInstanceId: string;
  projectPath: string;
  creatorVersion: string;
  bridgeVersion: string;
  protocolVersion: string;
  parameters: ScanParameters;
  parametersHash: string;
  assetManifestHash: string;
  assetUuids: string[];
  completedAssetUuids: string[];
  failures: ScanCheckpointFailure[];
  documents: DocumentSnapshot[];
  unresolved: UnresolvedItem[];
  updatedAt: string;
}

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
  documents?: DocumentSnapshot[];
  completedAssetUuids?: string[];
  failures?: ScanCheckpointFailure[];
  unresolved?: UnresolvedItem[];
  updatedAt?: string;
}): ScanCheckpoint {
  return {
    version: 1,
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
  if (checkpoint.version !== 1) mismatches.push('version');
  if (checkpoint.projectId !== context.projectId) mismatches.push('projectId');
  if (checkpoint.editorInstanceId !== context.editorInstanceId) mismatches.push('editorInstanceId');
  if (checkpoint.projectPath !== context.projectPath) mismatches.push('projectPath');
  if (checkpoint.creatorVersion !== context.creatorVersion) mismatches.push('creatorVersion');
  if (checkpoint.bridgeVersion !== context.bridgeVersion) mismatches.push('bridgeVersion');
  if (checkpoint.protocolVersion !== context.protocolVersion) mismatches.push('protocolVersion');
  if (checkpoint.parametersHash !== createParametersHash(context.parameters)) mismatches.push('parameters');
  if (checkpoint.assetManifestHash !== context.assetManifestHash) mismatches.push('assetManifestHash');
  if (JSON.stringify(checkpoint.assetUuids) !== JSON.stringify(context.assetUuids)) {
    mismatches.push('assetUuids');
  }
  if (mismatches.length > 0) {
    throw new Error(`SCAN_CHECKPOINT_STALE:${mismatches.join(',')}`);
  }
}

function toManifestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    assetUuid: record.assetUuid ?? record.uuid ?? null,
    url: record.url ?? null,
    filePath: record.filePath ?? record.file ?? null,
    type: record.type ?? null,
    importer: record.importer ?? null,
    isSubAsset: record.isSubAsset ?? null,
    isDirectory: record.isDirectory ?? null,
    invalid: record.invalid ?? null
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
