export interface CreatorDocumentIdentityFailure {
  source: string;
  reason: string;
}

export interface CreatorDocumentIdentity {
  assetUuid: string | null;
  mode: string | null;
  source: string | null;
  failures: CreatorDocumentIdentityFailure[];
}

/**
 * 从 Creator Scene Facade 独立读取当前打开文档的资产 UUID。
 *
 * @param scope Creator Scene 进程的全局对象。
 * @returns 当前文档身份；内部入口不可用时保留失败证据并返回空身份。
 */
export async function resolveCreatorDocumentIdentity(
  scope: unknown
): Promise<CreatorDocumentIdentity> {
  const cce = readObject(readObject(scope).cce);
  const candidates: Array<[string, unknown]> = [
    ['cce.SceneFacadeManager', cce.SceneFacadeManager],
    ['cce.sceneFacadeManager', cce.sceneFacadeManager],
    ['cce.SceneFacade', cce.SceneFacade],
    ['cce.sceneFacade', cce.sceneFacade]
  ];
  const failures: CreatorDocumentIdentityFailure[] = [];

  for (const [source, candidate] of candidates) {
    if (!isObjectOrFunction(candidate)) continue;
    const owner = candidate as {
      queryCurrentSceneUuid?: () => unknown;
      queryMode?: () => unknown;
    };
    if (typeof owner.queryCurrentSceneUuid !== 'function') continue;

    try {
      const value = await owner.queryCurrentSceneUuid.call(owner);
      const assetUuid = typeof value === 'string' && value ? value : null;
      if (!assetUuid) {
        failures.push({ source, reason: 'CURRENT_DOCUMENT_UUID_EMPTY' });
        continue;
      }

      let mode: string | null = null;
      if (typeof owner.queryMode === 'function') {
        try {
          const modeValue = await owner.queryMode.call(owner);
          mode = typeof modeValue === 'string' && modeValue ? modeValue : null;
        } catch (error) {
          failures.push({ source: `${source}.queryMode`, reason: readReason(error) });
        }
      }
      return { assetUuid, mode, source, failures };
    } catch (error) {
      failures.push({ source, reason: readReason(error) });
    }
  }

  return { assetUuid: null, mode: null, source: null, failures };
}

function isObjectOrFunction(value: unknown): boolean {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
