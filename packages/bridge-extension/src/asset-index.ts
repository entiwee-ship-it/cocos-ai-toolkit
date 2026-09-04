import { createHash } from 'node:crypto';
import { normalizeAssetInfo } from './asset-probe';

/**
 * 全量资产索引查询的精简字段集：只取 buildAssetIndex 实际消费的字段。
 * 完整 ASSET_DATA_KEYS 里的 meta/depends/dependeds/subAssets 等重字段
 * 会让大项目的 query-assets 超过 Creator IPC 请求超时。
 */
const ASSET_INDEX_DATA_KEYS = [
  'name', 'displayName', 'source', 'path', 'url', 'file', 'uuid', 'importer',
  'imported', 'invalid', 'type', 'isDirectory', 'isBundle', 'visible', 'readonly'
] as const;

const ASSET_INDEX_CACHE_TTL_MS = 5_000;

interface CachedAssetIndexValue {
  index: AssetIndexResult;
  revision: string;
  scriptPathsByUuid: Array<[string, string]>;
}

let assetIndexCacheGeneration = 0;
let cachedAssetIndex: { expiresAt: number; value: CachedAssetIndexValue } | null = null;
let assetIndexInFlight: Promise<CachedAssetIndexValue> | null = null;

export interface AssetIndexInput {
  uuid?: string | null;
  url?: string | null;
  file?: string | null;
  type?: string | null;
  importer?: string | null;
  isSubAsset?: boolean | null;
  isBundle?: boolean | null;
  imported?: boolean | null;
  isDirectory?: boolean | null;
  visible?: boolean | null;
  readonly?: boolean | null;
  displayName?: string | null;
  source?: string | null;
  path?: string | null;
  name?: string | null;
  invalid?: boolean | null;
  raw?: Record<string, unknown>;
}

export interface IndexedAsset {
  assetUuid: string;
  url: string | null;
  filePath: string | null;
  type: string | null;
  importer: string | null;
  name: string | null;
  displayName: string | null;
  source: string | null;
  path: string | null;
  isSubAsset: boolean | null;
  isBundle: boolean | null;
  imported: boolean | null;
  invalid: boolean | null;
  isDirectory: boolean | null;
  visible: boolean | null;
  readonly: boolean | null;
  available: boolean;
  raw: Record<string, unknown>;
}

export interface IndexedScript {
  assetUuid: string;
  scriptPath: string | null;
  filePath: string | null;
  classNames: string[];
  available: boolean;
  raw: Record<string, unknown>;
}

export interface IndexedDocument {
  assetUuid: string;
  path: string | null;
  filePath: string | null;
  documentType: 'scene' | 'prefab';
  available: boolean;
  raw: Record<string, unknown>;
}

export interface AssetIndexResult {
  assets: IndexedAsset[];
  scripts: IndexedScript[];
  documents: IndexedDocument[];
  assetsByUuid: Map<string, IndexedAsset>;
  scriptsByUuid: Map<string, IndexedScript>;
  unresolved: Array<{ path: string; reason: string; details?: unknown }>;
}

/**
 * 把 AssetDB 资源列表整理为稳定 UUID 索引、脚本表和项目可扫描文档表。
 *
 * @param values AssetDB 已规范化资源记录。
 * @returns 包含资产、脚本、文档、UUID Map 和未解析项的索引。
 */
export function buildAssetIndex(values: AssetIndexInput[]): AssetIndexResult {
  const assets: IndexedAsset[] = [];
  const scripts: IndexedScript[] = [];
  const documents: IndexedDocument[] = [];
  const assetsByUuid = new Map<string, IndexedAsset>();
  const scriptsByUuid = new Map<string, IndexedScript>();
  const unresolved: AssetIndexResult['unresolved'] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const assetUuid = readString(value.uuid);
    if (!assetUuid) {
      unresolved.push({
        path: `assets.${index}.uuid`,
        reason: 'ASSET_UUID_MISSING',
        details: value.raw ?? value
      });
      continue;
    }

    if (assetsByUuid.has(assetUuid)) {
      unresolved.push({
        path: `assets.${index}.uuid`,
        reason: 'DUPLICATE_ASSET_UUID',
        details: { assetUuid }
      });
      continue;
    }

    const raw = value.raw ?? { ...value };
    const asset: IndexedAsset = {
      assetUuid,
      url: readString(value.url),
      filePath: readString(value.file),
      type: readString(value.type),
      importer: readString(value.importer),
      name: readString(value.name),
      displayName: readString(value.displayName),
      source: readString(value.source),
      path: readString(value.path),
      isSubAsset: readBoolean(value.isSubAsset),
      isBundle: readBoolean(value.isBundle),
      imported: readBoolean(value.imported),
      invalid: readBoolean(value.invalid),
      isDirectory: readBoolean(value.isDirectory),
      visible: readBoolean(value.visible),
      readonly: readBoolean(value.readonly),
      available: value.invalid !== true,
      raw
    };
    assets.push(asset);
    assetsByUuid.set(assetUuid, asset);

    if (isScriptAsset(asset)) {
      const script: IndexedScript = {
        assetUuid,
        scriptPath: asset.url,
        filePath: asset.filePath,
        classNames: [],
        available: asset.available,
        raw
      };
      scripts.push(script);
      scriptsByUuid.set(assetUuid, script);
    }

    const documentType = classifyDocumentType(asset);
    if (documentType.conflict) {
      unresolved.push({
        path: `assets.${index}`,
        reason: 'ASSET_DOCUMENT_TYPE_CONFLICT',
        details: documentType.signals
      });
      continue;
    }
    if (documentType.value && isProjectDocumentAsset(asset)) {
      documents.push({
        assetUuid,
        path: asset.url,
        filePath: asset.filePath,
        documentType: documentType.value,
        available: asset.available,
        raw
      });
    }
  }

  return { assets, scripts, documents, assetsByUuid, scriptsByUuid, unresolved };
}

/**
 * 移除运行期 Map，生成可通过 IPC JSON 序列化的资产索引。
 *
 * @param result 内部资产索引。
 * @returns 只包含数组和未解析项的资产索引。
 */
export function toSerializableAssetIndex(result: AssetIndexResult, includeRaw = false) {
  return {
    assets: result.assets.map((asset) => serializeIndexEntry(asset, includeRaw)),
    scripts: result.scripts.map((script) => serializeIndexEntry(script, includeRaw)),
    documents: result.documents.map((document) => serializeIndexEntry(document, includeRaw)),
    unresolved: result.unresolved
  };
}

/**
 * 从当前 Creator AssetDB 读取完整项目资源索引。
 *
 * @returns 可 JSON 序列化的资产、脚本、文档和未解析项。
 */
export async function probeAssetIndex(request?: unknown): Promise<unknown> {
  const includeRaw = readObject(request).includeRaw === true;
  return toSerializableAssetIndex((await readCachedAssetIndex()).index, includeRaw);
}

/**
 * 在 Bridge 内按 MCP 既有语义执行大小写无关的包含匹配，避免把全量索引传过 IPC。
 *
 * @param request 搜索文本和可选完整诊断标记。
 * @returns 已排序的命中资产、兼容旧 cursor 的全量清单 revision 和未解析项。
 */
export async function probeAssetSearch(request: unknown) {
  const input = readObject(request);
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim().toLowerCase() : '';
  const includeRaw = input.includeRaw === true;
  const offset = readNonnegativeInteger(input.offset, 0, 'offset');
  const pageSize = readPositiveInteger(input.pageSize, 50, 'pageSize');
  if (pageSize > 200) throw new Error('ASSET_SEARCH_PAGE_SIZE_INVALID');
  const cached = await readCachedAssetIndex();
  const matching = cached.index.assets.filter((asset) => matchesAsset(asset, pattern)).sort(compareAssets);
  return {
    assets: matching
      .slice(offset, offset + pageSize)
      .map((asset) => serializeIndexEntry(asset, includeRaw)),
    total: matching.length,
    revision: cached.revision,
    unresolved: cached.index.unresolved
  };
}

/** 读取组件 Schema 所需的脚本 UUID 路径；与全量索引共用 TTL、singleflight 和失效。 */
export async function probeScriptPathsByUuid(): Promise<Array<[string, string]>> {
  return (await readCachedAssetIndex()).scriptPathsByUuid;
}

/** 已知资产写入后主动失效；外部人工修改由短 TTL 收敛。 */
export function invalidateAssetIndexCache(): void {
  assetIndexCacheGeneration += 1;
  cachedAssetIndex = null;
  assetIndexInFlight = null;
}

async function readCachedAssetIndex(): Promise<CachedAssetIndexValue> {
  const now = Date.now();
  if (cachedAssetIndex && cachedAssetIndex.expiresAt > now) return cachedAssetIndex.value;
  if (assetIndexInFlight) return assetIndexInFlight;

  const generation = assetIndexCacheGeneration;
  const request = readAssetIndexFromCreator();
  assetIndexInFlight = request;
  try {
    const value = await request;
    if (generation === assetIndexCacheGeneration) {
      cachedAssetIndex = { expiresAt: Date.now() + ASSET_INDEX_CACHE_TTL_MS, value };
    }
    return value;
  } finally {
    if (assetIndexInFlight === request) assetIndexInFlight = null;
  }
}

async function readAssetIndexFromCreator(): Promise<CachedAssetIndexValue> {
  const rawAssets = await Editor.Message.request(
    'asset-db',
    'query-assets',
    undefined,
    ASSET_INDEX_DATA_KEYS as never
  );
  const assetValues: unknown[] = Array.isArray(rawAssets) ? rawAssets : [];
  const values = assetValues
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    .map(normalizeAssetInfo);
  const index = buildAssetIndex(values);
  return {
    index,
    revision: createAssetManifestHash(index.assets, index.documents),
    scriptPathsByUuid: index.scripts.flatMap((script): Array<[string, string]> => {
      const scriptPath = script.scriptPath ?? script.filePath;
      return scriptPath ? [[script.assetUuid, scriptPath]] : [];
    })
  };
}

function serializeIndexEntry<T extends { raw: Record<string, unknown> }>(value: T, includeRaw: boolean) {
  if (includeRaw) return value;
  const { raw: _raw, ...compact } = value;
  return compact;
}

function matchesAsset(asset: IndexedAsset, pattern: string): boolean {
  return [
    asset.assetUuid,
    asset.url,
    asset.filePath,
    asset.type,
    asset.importer,
    asset.name,
    asset.displayName,
    asset.source,
    asset.path
  ].some((value) => value?.toLowerCase().includes(pattern));
}

function compareAssets(left: IndexedAsset, right: IndexedAsset): number {
  const leftKey = left.url ?? left.filePath ?? left.assetUuid;
  const rightKey = right.url ?? right.filePath ?? right.assetUuid;
  return leftKey.localeCompare(rightKey);
}

function createAssetManifestHash(assets: IndexedAsset[], documents: IndexedDocument[]): string {
  const assetKeys = assets
    .map((asset) => JSON.stringify([
      asset.assetUuid,
      asset.url,
      asset.filePath,
      asset.type,
      asset.importer,
      asset.name,
      asset.displayName,
      asset.source,
      asset.path,
      asset.isSubAsset,
      asset.isBundle,
      asset.imported,
      asset.invalid,
      asset.isDirectory,
      asset.visible,
      asset.readonly,
      asset.available
    ]))
    .sort();
  const documentKeys = documents.map((document) => document.assetUuid).sort();
  return createHash('sha256').update(JSON.stringify({ assets: assetKeys, documents: documentKeys })).digest('hex');
}

function isScriptAsset(asset: IndexedAsset): boolean {
  const url = asset.url?.toLowerCase() ?? '';
  const type = asset.type?.toLowerCase() ?? '';
  const importer = asset.importer?.toLowerCase() ?? '';
  return /\.(?:[cm]?js|ts)$/.test(url)
    || type.includes('script')
    || importer === 'typescript'
    || importer === 'javascript';
}

/**
 * 判断文档资产是否归当前项目所有，避免扫描 Creator 内置只读文档。
 *
 * @param asset AssetDB 中的完整资产记录。
 * @returns 资源是否位于当前项目的 db://assets 命名空间。
 */
function isProjectDocumentAsset(asset: IndexedAsset): boolean {
  return asset.url?.toLowerCase().startsWith('db://assets/') === true;
}

function classifyDocumentType(asset: IndexedAsset): {
  value: 'scene' | 'prefab' | null;
  conflict: boolean;
  signals: string[];
} {
  const signals = new Set<'scene' | 'prefab'>();
  const url = asset.url?.toLowerCase() ?? '';
  const type = asset.type?.toLowerCase() ?? '';
  const importer = asset.importer?.toLowerCase() ?? '';

  if (url.endsWith('.scene')) signals.add('scene');
  if (url.endsWith('.prefab')) signals.add('prefab');
  if (type.includes('scene')) signals.add('scene');
  if (type.includes('prefab')) signals.add('prefab');
  if (importer === 'scene') signals.add('scene');
  if (importer === 'prefab') signals.add('prefab');

  return {
    value: signals.size === 1 ? [...signals][0] : null,
    conflict: signals.size > 1,
    signals: [...signals]
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonnegativeInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`ASSET_SEARCH_${field.toUpperCase()}_INVALID`);
  return value as number;
}

function readPositiveInteger(value: unknown, fallback: number, field: string): number {
  const parsed = readNonnegativeInteger(value, fallback, field);
  if (parsed === 0) throw new Error(`ASSET_SEARCH_${field.toUpperCase()}_INVALID`);
  return parsed;
}
