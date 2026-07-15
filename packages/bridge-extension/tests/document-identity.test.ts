import { describe, expect, it } from 'vitest';
import { scanCurrentDocument } from '../src/document-scan.js';

describe('document identity', () => {
  it('调用方提供的资产 UUID 仅作为提示，未独立观测时必须 unresolved', async () => {
    const hierarchy = {
      uuid: 'runtime-root',
      name: 'Main',
      type: 'cc.Scene',
      active: true,
      path: 'Main',
      children: [],
      components: []
    };
    const snapshot = await scanCurrentDocument({
      mode: 'full',
      document: {
        assetUuid: 'requested-scene',
        path: 'db://assets/Main.scene',
        filePath: 'E:/project/assets/Main.scene',
        documentType: 'scene'
      }
    }, {
      queryNodeTree: async () => hierarchy,
      queryNode: async () => ({
        uuid: { value: 'runtime-root' },
        name: { value: 'Main' },
        active: { value: true },
        children: [],
        __comps__: []
      }),
      queryComponent: async () => {
        throw new Error('UNEXPECTED_COMPONENT_QUERY');
      }
    });

    expect(snapshot.unresolved).toContainEqual({
      path: 'document.assetUuid',
      reason: 'DOCUMENT_IDENTITY_UNCONFIRMED',
      details: { requestedAssetUuid: 'requested-scene' }
    });
  });

  it('Creator Facade 确认 UUID 后保留匹配的 AssetDB 文档元数据', async () => {
    const hierarchy = {
      uuid: 'runtime-root',
      name: 'Loading',
      type: 'cc.Scene',
      active: true,
      path: 'Loading',
      children: [],
      components: []
    };
    const snapshot = await scanCurrentDocument({
      mode: 'full',
      document: {
        assetUuid: 'loading-prefab',
        path: 'db://assets/loading.prefab',
        filePath: 'E:/project/assets/loading.prefab',
        documentType: 'prefab'
      }
    }, {
      queryNodeTree: async () => hierarchy,
      queryNode: async () => ({
        uuid: { value: 'runtime-root' },
        name: { value: 'Loading' },
        active: { value: true },
        children: [],
        __comps__: []
      }),
      queryComponent: async () => {
        throw new Error('UNEXPECTED_COMPONENT_QUERY');
      }
    }, new Map(), {
      assetUuid: 'loading-prefab',
      mode: 'prefab',
      source: 'cce.SceneFacadeManager',
      failures: []
    });

    expect(snapshot.document).toMatchObject({
      assetUuid: 'loading-prefab',
      path: 'db://assets/loading.prefab',
      filePath: 'E:/project/assets/loading.prefab',
      documentType: 'prefab',
      raw: {
        identitySource: 'cce.SceneFacadeManager',
        mode: 'prefab'
      }
    });
    expect(snapshot.unresolved).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'document.assetUuid' })
    ]));
  });

  it('Creator Facade UUID 与请求不一致时返回实际身份并阻止元数据错配', async () => {
    const hierarchy = {
      uuid: 'runtime-root',
      name: 'Actual',
      type: 'cc.Scene',
      active: true,
      path: 'Actual',
      children: [],
      components: []
    };
    const snapshot = await scanCurrentDocument({
      mode: 'summary',
      document: {
        assetUuid: 'requested-prefab',
        path: 'db://assets/requested.prefab',
        filePath: 'E:/project/assets/requested.prefab',
        documentType: 'prefab'
      }
    }, {
      queryNodeTree: async () => hierarchy,
      queryNode: async () => ({}),
      queryComponent: async () => ({})
    }, new Map(), {
      assetUuid: 'actual-prefab',
      mode: 'prefab',
      source: 'cce.SceneFacadeManager',
      failures: []
    });

    expect(snapshot.document).toMatchObject({
      assetUuid: 'actual-prefab',
      path: null,
      filePath: null,
      documentType: 'prefab'
    });
    expect(snapshot.unresolved).toContainEqual({
      path: 'document.assetUuid',
      reason: 'DOCUMENT_IDENTITY_MISMATCH',
      details: {
        requestedAssetUuid: 'requested-prefab',
        observedAssetUuid: 'actual-prefab',
        source: 'cce.SceneFacadeManager'
      }
    });
  });
});
