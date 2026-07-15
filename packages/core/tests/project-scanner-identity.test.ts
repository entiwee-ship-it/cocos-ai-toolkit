import { describe, expect, it } from 'vitest';
import { ProjectScanner } from '../src/project-scanner.js';

describe('ProjectScanner document identity', () => {
  it('文档身份未由 Creator 独立确认时记录失败，不把快照归档到请求资产', async () => {
    const scanner = new ProjectScanner({
      async request(method) {
        if (method === 'server.editors') {
          return [{
            editorInstanceId: 'editor-1',
            projectId: 'project-1',
            projectPath: 'E:/project',
            creatorVersion: '3.8.8',
            bridgeVersion: '0.1.0',
            capabilities: [
              'probe.editorState',
              'probe.assetIndex',
              'probe.openAsset',
              'probe.documentSnapshot'
            ]
          }];
        }
        if (method === 'probe.assetIndex') {
          return {
            assets: [{
              assetUuid: 'scene-1',
              url: 'db://assets/Main.scene',
              filePath: 'E:/project/assets/Main.scene',
              type: 'cc.SceneAsset',
              importer: 'scene',
              name: 'Main',
              displayName: 'Main',
              source: null,
              path: 'db://assets/Main.scene',
              isSubAsset: false,
              isBundle: false,
              imported: true,
              invalid: false,
              isDirectory: false,
              visible: true,
              readonly: false,
              available: true,
              raw: {}
            }],
            scripts: [],
            documents: [{
              assetUuid: 'scene-1',
              path: 'db://assets/Main.scene',
              filePath: 'E:/project/assets/Main.scene',
              documentType: 'scene',
              available: true,
              raw: {}
            }],
            unresolved: []
          };
        }
        if (method === 'probe.openAsset') return { opened: true, uuid: 'scene-1' };
        if (method === 'probe.editorState') {
          return { ready: { scene: true, assetDatabase: true } };
        }
        if (method === 'probe.documentSnapshot') {
          return createUnconfirmedSnapshot();
        }
        throw new Error(`UNEXPECTED_METHOD:${method}`);
      }
    });

    const result = await scanner.scan({ projectId: 'project-1' });

    expect(result.status).toBe('completed-with-gaps');
    expect(result.documentSummaries).toEqual([]);
    expect(result.checkpoint.failures).toContainEqual(expect.objectContaining({
      assetUuid: 'scene-1',
      code: 'DOCUMENT_IDENTITY_UNCONFIRMED'
    }));
  });
});

function createUnconfirmedSnapshot() {
  return {
    document: {
      assetUuid: null,
      path: 'db://assets/Main.scene',
      filePath: 'E:/project/assets/Main.scene',
      documentType: 'scene',
      available: true,
      raw: {}
    },
    revision: 'revision-1',
    mode: 'full',
    page: { offset: 0, pageSize: 100, totalNodes: 0, nextCursor: null },
    nodes: [],
    componentSchemas: [],
    prefabInstances: [],
    coverage: {
      nodes: { total: 0, decoded: 0 },
      components: { total: 0, decoded: 0 },
      properties: { total: 0, decoded: 0 },
      references: { total: 0, resolved: 0 },
      prefabInstances: { total: 0, resolved: 0 },
      overrides: { total: 0, decoded: 0 }
    },
    unresolved: [{
      path: 'document.assetUuid',
      reason: 'DOCUMENT_IDENTITY_UNCONFIRMED',
      details: { requestedAssetUuid: 'scene-1' }
    }],
    diagnostics: []
  };
}
