import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProbeError } from './probe-errors';

/**
 * 导入外部文件为项目资产：复制到 assets 目标路径并触发 AssetDB 导入。
 * 目标资产已存在时拒绝覆盖，导入完成后返回 AssetDB 分配的资产身份。
 *
 * @param payload 请求载荷：sourceFilePath 源文件磁盘路径；assetUrl 目标 db://assets/ URL（含文件名）。
 * @returns 新资产的 uuid、类型和 URL。
 */
export async function importAsset(payload: unknown): Promise<unknown> {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const sourceFilePath = typeof input.sourceFilePath === 'string' && input.sourceFilePath ? input.sourceFilePath : '';
  const assetUrl = typeof input.assetUrl === 'string' ? input.assetUrl : '';
  if (!sourceFilePath) throw new ProbeError('SOURCE_FILE_PATH_REQUIRED');
  if (!assetUrl.startsWith('db://assets/') || assetUrl.includes('\\') || assetUrl.split('/').includes('..')) {
    throw new ProbeError('ASSET_URL_INVALID', { assetUrl });
  }

  const existing = await Editor.Message.request('asset-db', 'query-asset-info', assetUrl).catch(() => null);
  if (existing && typeof existing === 'object' && typeof (existing as { uuid?: unknown }).uuid === 'string') {
    throw new ProbeError('ASSET_ALREADY_EXISTS', { assetUrl });
  }

  const assetsRoot = await Editor.Message.request('asset-db', 'query-path', 'db://assets');
  if (typeof assetsRoot !== 'string' || !assetsRoot) {
    throw new ProbeError('ASSETS_ROOT_UNAVAILABLE');
  }
  const targetPath = join(assetsRoot, assetUrl.slice('db://assets/'.length));
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourceFilePath, targetPath);
  await Editor.Message.request('asset-db', 'refresh-asset', assetUrl);

  const created = await Editor.Message.request('asset-db', 'query-asset-info', assetUrl).catch(() => null);
  const record = created && typeof created === 'object' && !Array.isArray(created)
    ? created as unknown as Record<string, unknown>
    : null;
  if (!record || typeof record.uuid !== 'string' || !record.uuid) {
    throw new ProbeError('ASSET_IMPORT_POSTVERIFY_FAILED', { assetUrl });
  }
  return {
    uuid: record.uuid,
    type: typeof record.type === 'string' ? record.type : null,
    assetUrl
  };
}
