const KNOWN_ASSET_FIELDS = new Set([
  'name', 'displayName', 'source', 'path', 'url', 'file', 'uuid', 'importer',
  'imported', 'invalid', 'type', 'isDirectory', 'isSubAsset', 'library',
  'subAssets', 'visible', 'readonly', 'instantiation', 'redirect', 'extends',
  'meta', 'fatherInfo', 'mtime', 'depends', 'dependeds'
]);

export interface NormalizedAssetInfo {
  uuid: string | null;
  url: string | null;
  file: string | null;
  type: string | null;
  importer: string | null;
  isSubAsset: boolean | null;
  name: string | null;
  source: string | null;
  path: string | null;
  displayName: string | null;
  imported: boolean | null;
  invalid: boolean | null;
  isDirectory: boolean | null;
  unknownFieldCount: number;
  raw: Record<string, unknown>;
}

export function normalizeAssetInfo(value: Record<string, unknown>): NormalizedAssetInfo {
  return {
    uuid: readString(value.uuid),
    url: readString(value.url),
    file: readString(value.file),
    type: readString(value.type),
    importer: readString(value.importer),
    isSubAsset: readBoolean(value.isSubAsset),
    name: readString(value.name),
    source: readString(value.source),
    path: readString(value.path),
    displayName: readString(value.displayName),
    imported: readBoolean(value.imported),
    invalid: readBoolean(value.invalid),
    isDirectory: readBoolean(value.isDirectory),
    unknownFieldCount: Object.keys(value).filter((key) => !KNOWN_ASSET_FIELDS.has(key)).length,
    raw: value
  };
}

export async function probeAssets(request: unknown): Promise<unknown> {
  const input = readObject(request);
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
  const uuid = typeof input.uuid === 'string' ? input.uuid : undefined;
  const options = pattern ? { pattern } : undefined;
  const dataKeys = [
    'name', 'displayName', 'source', 'path', 'url', 'file', 'uuid', 'importer',
    'imported', 'invalid', 'type', 'isDirectory', 'isBundle', 'visible', 'readonly',
    'subAssets', 'meta', 'fatherInfo', 'extends', 'mtime', 'depends', 'dependeds'
  ];
  const rawAssets = await Editor.Message.request('asset-db', 'query-assets', options, dataKeys as never);
  const assets = (rawAssets as unknown[])
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    .map(normalizeAssetInfo);

  if (!uuid) {
    return { assets, details: null, meta: null, dependencies: null, users: null, unresolved: [] };
  }

  const unresolved: Array<{ path: string; reason: string }> = [];
  const details = await Editor.Message.request('asset-db', 'query-asset-info', uuid, dataKeys as never);
  const meta = await Editor.Message.request('asset-db', 'query-asset-meta', uuid);
  const dependencies = await optionalAssetQuery('query-asset-dependencies', uuid, unresolved);
  const users = await optionalAssetQuery('query-asset-users', uuid, unresolved);
  return {
    assets,
    details: details && typeof details === 'object' ? normalizeAssetInfo(details as unknown as Record<string, unknown>) : null,
    meta,
    dependencies,
    users,
    unresolved
  };
}

async function optionalAssetQuery(
  method: 'query-asset-dependencies' | 'query-asset-users',
  uuid: string,
  unresolved: Array<{ path: string; reason: string }>
): Promise<string[] | null> {
  try {
    return await Editor.Message.request('asset-db', method, uuid, 'all');
  } catch (error) {
    unresolved.push({
      path: method,
      reason: error instanceof Error ? error.message : 'MESSAGE_API_UNAVAILABLE'
    });
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
