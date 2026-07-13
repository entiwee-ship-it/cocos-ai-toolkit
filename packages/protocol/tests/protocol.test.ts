import { describe, expect, it } from 'vitest';
import { ProbeResponseSchema } from '../src/index.js';

const validResponse = {
  protocolVersion: '0.1.0',
  creatorVersion: '3.8.8',
  editorInstanceId: 'editor-1',
  projectId: 'project-1',
  requestId: 'request-1',
  ok: true,
  data: {
    kind: 'node',
    identity: {
      sessionId: 'session-object-1',
      objectUuid: 'node-uuid',
      assetUuid: null,
      fileId: 'file-id',
      typeId: null,
      scriptUuid: null
    }
  },
  coverage: {
    nodes: { total: 1, decoded: 1 },
    components: { total: 0, decoded: 0 },
    properties: { total: 0, decoded: 0 },
    references: { total: 0, resolved: 0 },
    prefabInstances: { total: 1, resolved: 1 },
    overrides: { total: 1, decoded: 0 }
  },
  unresolved: [{ path: 'prefab.overrides[0]', reason: 'unknown-shape' }],
  diagnostics: []
};

describe('ProbeResponseSchema', () => {
  it('保留对象不同身份和未解析字段', () => {
    const result = ProbeResponseSchema.parse(validResponse);

    expect(result.data).toMatchObject({
      identity: {
        objectUuid: 'node-uuid',
        fileId: 'file-id'
      }
    });
    expect(result.unresolved).toHaveLength(1);
  });

  it('拒绝缺少 objectUuid 字段的身份对象', () => {
    const response = structuredClone(validResponse);
    delete (response.data.identity as { objectUuid?: string | null }).objectUuid;

    expect(() => ProbeResponseSchema.parse(response)).toThrow();
  });

  it('拒绝解码数量大于总数', () => {
    const response = structuredClone(validResponse);
    response.coverage.nodes.decoded = 2;

    expect(() => ProbeResponseSchema.parse(response)).toThrow('decoded 不能大于 total');
  });

  it('拒绝解析数量大于引用总数', () => {
    const response = structuredClone(validResponse);
    response.coverage.references.resolved = 1;

    expect(() => ProbeResponseSchema.parse(response)).toThrow('resolved 不能大于 total');
  });

  it('拒绝实例链中缺少 depth 的 Prefab 上下文', () => {
    const response = structuredClone(validResponse);
    Object.assign(response.data, {
      prefabContext: {
        ownerDocumentAssetUuid: 'owner-prefab',
        sourcePrefabAssetUuid: 'source-prefab',
        instanceRootObjectUuid: 'instance-root',
        sourceObjectFileId: 'source-file-id',
        instanceChain: [{ assetUuid: 'source-prefab', instanceNodeUuid: 'instance-root' }]
      }
    });

    expect(() => ProbeResponseSchema.parse(response)).toThrow();
  });
});
