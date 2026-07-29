import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  executeMainAssetWrite,
  rollbackMainAssetWrite,
  type MainAssetWriteDependencies
} from '../src/main-asset-write.js';
import { executeBridgeWrite } from '../src/main-write-router.js';

describe('executeBridgeWrite', () => {
  it('大型纯资产恢复事务在主进程执行，不进入 SceneFacade', async () => {
    const content = JSON.stringify({ nodes: Array.from({ length: 15_000 }, (_, index) => ({ index })) });
    const executeMainAssetWrite = vi.fn(async () => ({
      kind: 'success' as const,
      executedOps: 1,
      verification: { passed: true, verifiedAt: '2026-07-28T00:00:00.000Z', items: [] },
      evidence: []
    }));
    const executeSceneWrite = vi.fn(async () => {
      throw new Error('SceneFacadeManager.executeSceneScriptMethod timeout');
    });

    const outcome = await executeBridgeWrite({
      operations: [{
        type: 'asset.restore_content',
        assetUrl: 'db://assets/ui/Large.prefab',
        expectedAssetUuid: 'large-prefab',
        expectedCurrentSha256: 'a'.repeat(64),
        content,
        targetSha256: createHash('sha256').update(content).digest('hex')
      }],
      save: true,
      undoGroup: 'restore-large-prefab'
    }, {
      executeMainAssetWrite,
      executeSceneWrite
    });

    expect(content.length).toBeGreaterThan(200_000);
    expect(outcome.kind).toBe('success');
    expect(executeMainAssetWrite).toHaveBeenCalledOnce();
    expect(executeSceneWrite).not.toHaveBeenCalled();
  });

  it('主进程资产恢复通过 AssetDB 保存并按 SHA256 重读验证', async () => {
    let currentContent = 'current-content';
    const targetContent = JSON.stringify({ nodes: Array.from({ length: 15_000 }, (_, index) => ({ index })) });
    const dependencies = createAssetDependencies({
      readAssetContent: async () => currentContent,
      saveAssetContent: async (_assetUrl, content) => { currentContent = content; }
    });

    const outcome = await executeMainAssetWrite({
      operations: [{
        type: 'asset.restore_content',
        assetUrl: 'db://assets/ui/Large.prefab',
        expectedAssetUuid: 'large-prefab',
        expectedCurrentSha256: createHash('sha256').update(currentContent).digest('hex'),
        content: targetContent,
        targetSha256: createHash('sha256').update(targetContent).digest('hex')
      }],
      save: true,
      undoGroup: 'restore-large-prefab'
    }, dependencies);

    expect(outcome.kind).toBe('success');
    expect(outcome.verification?.passed).toBe(true);
    expect(currentContent).toBe(targetContent);
    expect(outcome.evidence?.[0].inverse).toEqual([expect.objectContaining({
      type: 'asset.restore_content',
      content: 'current-content'
    })]);
  });

  it('主进程资产事务的逆操作同样不进入 SceneFacade', async () => {
    let currentContent = 'changed-content';
    const dependencies = createAssetDependencies({
      readAssetContent: async () => currentContent,
      saveAssetContent: async (_assetUrl, content) => { currentContent = content; }
    });

    const result = await rollbackMainAssetWrite([{
      operation: {
        type: 'asset.restore_content',
        assetUrl: 'db://assets/ui/Large.prefab',
        expectedAssetUuid: 'large-prefab',
        expectedCurrentSha256: createHash('sha256').update('original-content').digest('hex'),
        content: 'changed-content',
        targetSha256: createHash('sha256').update('changed-content').digest('hex')
      },
      nodeUuid: null,
      assetUuid: 'large-prefab',
      before: null,
      after: null,
      inverse: [{
        type: 'asset.restore_content',
        assetUrl: 'db://assets/ui/Large.prefab',
        expectedAssetUuid: 'large-prefab',
        expectedCurrentSha256: createHash('sha256').update('changed-content').digest('hex'),
        content: 'original-content',
        targetSha256: createHash('sha256').update('original-content').digest('hex')
      }]
    }], dependencies);

    expect(result).toEqual({ succeeded: true, failedAt: null });
    expect(currentContent).toBe('original-content');
  });
});

function createAssetDependencies(
  overrides: Partial<MainAssetWriteDependencies> = {}
): MainAssetWriteDependencies {
  return {
    queryAssetInfo: async () => ({ uuid: 'large-prefab', type: 'cc.Prefab' }),
    createAsset: async () => ({ uuid: 'created-asset', type: 'cc.Asset' }),
    moveAsset: async () => undefined,
    readAssetMeta: async () => ({}),
    writeAssetMeta: async () => undefined,
    readAssetContent: async () => 'current-content',
    saveAssetContent: async () => undefined,
    deleteAsset: async () => undefined,
    ...overrides
  };
}
