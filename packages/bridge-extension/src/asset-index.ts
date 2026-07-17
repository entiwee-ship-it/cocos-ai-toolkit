import { ASSET_DATA_KEYS, normalizeAssetInfo } from './asset-probe';

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
 * 移除运行期 Map，生成可通过 WebSocket JSON 序列化的资产索引。
 *
 * @param result 内部资产索引。
 * @returns 只包含数组和未解析项的资产索引。
 */
export function toSerializableAssetIndex(result: AssetIndexResult): Omit<
  AssetIndexResult,
  'assetsByUuid' | 'scriptsByUuid'
> {
  return {
    assets: result.assets,
    scripts: result.scripts,
    documents: result.documents,
    unresolved: result.unresolved
  };
}

/**
 * 从当前 Creator AssetDB 读取完整项目资源索引。
 *
 * @returns 可 JSON 序列化的资产、脚本、文档和未解析项。
 */
export async function probeAssetIndex(): Promise<unknown> {
  const rawAssets = await Editor.Message.request(
    'asset-db',
    'query-assets',
    undefined,
    ASSET_DATA_KEYS as never
  );
  const assetValues: unknown[] = Array.isArray(rawAssets) ? rawAssets : [];
  const values = assetValues
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    .map(normalizeAssetInfo);
  return toSerializableAssetIndex(buildAssetIndex(values));
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
