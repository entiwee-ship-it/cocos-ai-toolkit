import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCreatorDocumentIdentity } from '../src/creator-document-identity.js';

const sceneSourcePath = fileURLToPath(new URL('../src/scene.ts', import.meta.url));

describe('Creator document identity', () => {
  it('从 SceneFacadeManager 独立读取当前文档 UUID 和编辑模式', async () => {
    const manager = {
      queryCurrentSceneUuid() {
        return 'current-prefab-uuid';
      },
      queryMode() {
        return 'prefab';
      }
    };

    await expect(resolveCreatorDocumentIdentity({
      cce: { SceneFacadeManager: manager }
    })).resolves.toEqual({
      assetUuid: 'current-prefab-uuid',
      mode: 'prefab',
      source: 'cce.SceneFacadeManager',
      failures: []
    });
  });

  it('内部入口不可用时保留失败证据而不伪造文档身份', async () => {
    const identity = await resolveCreatorDocumentIdentity({
      cce: {
        SceneFacadeManager: {
          queryCurrentSceneUuid() {
            throw new Error('FACADE_NOT_READY');
          }
        }
      }
    });

    expect(identity).toMatchObject({
      assetUuid: null,
      mode: null,
      source: null,
      failures: [{ source: 'cce.SceneFacadeManager', reason: 'FACADE_NOT_READY' }]
    });
  });

  it('当前文档 UUID 短暂为空时有限重试并读取恢复后的身份', async () => {
    let calls = 0;
    const identity = await resolveCreatorDocumentIdentity({
      cce: {
        SceneFacadeManager: {
          queryCurrentSceneUuid() {
            calls += 1;
            return calls === 1 ? null : 'scene-after-refresh';
          }
        }
      }
    });

    expect(identity).toMatchObject({
      assetUuid: 'scene-after-refresh',
      source: 'cce.SceneFacadeManager'
    });
    expect(calls).toBe(2);
  });

  it('Scene 快照只使用运行时 Facade 证据确认当前文档', async () => {
    const source = await readFile(sceneSourcePath, 'utf8');
    const snapshotFunction = source.slice(
      source.indexOf('async function probeDocumentSnapshot'),
      source.indexOf('/**\n * 读取当前节点的 Prefab')
    );

    expect(snapshotFunction).toContain('resolveCreatorDocumentIdentity(globalThis)');
    expect(snapshotFunction).toContain('documentIdentity');
  });
});
