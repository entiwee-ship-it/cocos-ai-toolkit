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
});
