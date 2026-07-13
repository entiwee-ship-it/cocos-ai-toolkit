import { createHash } from 'node:crypto';
import { ProbeError } from './probe-errors';
import type { ProbePrepareRequest } from './probe-operation';
import type { ProbeRevisionSnapshot } from './probe-transaction';

interface ProbeRevisionDependencies {
  queryAssetInfo: (documentAssetUuid: string) => Promise<unknown>;
  readFile: (filePath: string) => Promise<Buffer>;
  queryDirty: () => Promise<boolean>;
  queryNodeTree: () => Promise<unknown>;
}

interface ProbeAssetRestoreRequest {
  documentAssetUuid: string;
  baselineSha256: string;
  recoveryContent: string;
}

interface ProbeAssetRestoreDependencies {
  readCurrentContent: () => Promise<Buffer>;
  saveAsset: (documentAssetUuid: string, content: string) => Promise<unknown>;
}

/**
 * 读取 prepare/confirm 共用的不可变 Revision 输入。
 *
 * @param request 固定探针请求。
 * @param dependencies Creator 和文件系统只读入口。
 * @returns 可用于计算 Revision 的快照。
 */
export async function captureProbeRevision(
  request: ProbePrepareRequest,
  dependencies: ProbeRevisionDependencies
): Promise<ProbeRevisionSnapshot> {
  const [assetInfoValue, dirty, hierarchy] = await Promise.all([
    dependencies.queryAssetInfo(request.documentAssetUuid),
    dependencies.queryDirty(),
    dependencies.queryNodeTree()
  ]);
  const assetInfo = readObject(assetInfoValue);
  if (typeof assetInfo.file !== 'string' || !assetInfo.file) {
    throw new ProbeError('ASSET_FILE_PATH_UNAVAILABLE');
  }

  const documentState = findDocumentState(readObject(hierarchy), request.documentAssetUuid, request.probeName);
  if (!documentState.parentNodeUuid) {
    throw new ProbeError('PREFAB_ROOT_NOT_FOUND');
  }
  const assetContent = await dependencies.readFile(assetInfo.file);

  return {
    documentAssetUuid: request.documentAssetUuid,
    assetSha256: sha256(assetContent),
    hierarchySha256: sha256(Buffer.from(stableStringify(hierarchy))),
    dirty,
    parentNodeUuid: documentState.parentNodeUuid,
    existingProbeNodeUuid: documentState.existingProbeNodeUuid,
    recoveryContent: assetContent.toString('utf8')
  };
}

export async function restoreProbeAsset(
  request: ProbeAssetRestoreRequest,
  dependencies: ProbeAssetRestoreDependencies
): Promise<{
  recoveryMethod: 'none' | 'asset-db-save-asset';
  diskHashRestored: boolean;
  finalAssetSha256: string;
}> {
  const currentContent = await dependencies.readCurrentContent();
  const currentSha256 = sha256(currentContent);
  if (currentSha256 === request.baselineSha256) {
    return {
      recoveryMethod: 'none',
      diskHashRestored: true,
      finalAssetSha256: currentSha256
    };
  }

  const recoverySha256 = sha256(Buffer.from(request.recoveryContent));
  if (recoverySha256 !== request.baselineSha256) {
    throw new ProbeError('RECOVERY_CONTENT_HASH_MISMATCH', {
      baselineSha256: request.baselineSha256,
      recoverySha256
    });
  }
  await dependencies.saveAsset(request.documentAssetUuid, request.recoveryContent);
  const finalAssetSha256 = sha256(await dependencies.readCurrentContent());
  if (finalAssetSha256 !== request.baselineSha256) {
    throw new ProbeError('ASSET_DB_RECOVERY_FAILED', {
      baselineSha256: request.baselineSha256,
      finalAssetSha256
    });
  }
  return {
    recoveryMethod: 'asset-db-save-asset',
    diskHashRestored: true,
    finalAssetSha256
  };
}

function findDocumentState(
  root: Record<string, unknown>,
  documentAssetUuid: string,
  probeName: string
): { parentNodeUuid: string | null; existingProbeNodeUuid: string | null } {
  const documentRoot = findNode(root, (node) => readObject(node.prefab).assetUuid === documentAssetUuid);
  if (!documentRoot || typeof documentRoot.uuid !== 'string') {
    return { parentNodeUuid: null, existingProbeNodeUuid: null };
  }
  const existingProbe = findNode(documentRoot, (node) => node.name === probeName);
  return {
    parentNodeUuid: documentRoot.uuid,
    existingProbeNodeUuid: typeof existingProbe?.uuid === 'string' ? existingProbe.uuid : null
  };
}

function findNode(
  node: Record<string, unknown>,
  predicate: (node: Record<string, unknown>) => boolean
): Record<string, unknown> | null {
  if (predicate(node)) {
    return node;
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findNode(readObject(child), predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortValue(child)]));
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
