import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands.js';
import { executeCommand } from '../src/index.js';

const TARGET_JSON = JSON.stringify({
  document: { scope: 'current-document' },
  tree: [{
    id: '$root', name: 'root',
    children: [{ id: '$label', name: 'label', components: [{ type: 'cc.Label', properties: { fontSize: 28 } }] }]
  }]
});

describe('声明式只读 CLI 命令', () => {
  it('解析 design-inspect / design-plan / design-preview', () => {
    expect(parseCommand([
      'design-inspect', '--project-id', 'project-1', '--root-uuid', 'node-root'
    ])).toEqual({
      command: 'design-inspect', projectId: 'project-1', rootUuid: 'node-root'
    });
    expect(parseCommand([
      'design-plan', '--project-id', 'project-1', '--target', TARGET_JSON
    ])).toMatchObject({ command: 'design-plan', projectId: 'project-1' });
    expect(parseCommand([
      'design-preview', '--project-id', 'project-1', '--target', TARGET_JSON
    ])).toMatchObject({ command: 'design-preview', projectId: 'project-1' });
  });

  it('拒绝非法目标 JSON 与不合规逻辑 ID', () => {
    expect(() => parseCommand([
      'design-plan', '--project-id', 'project-1', '--target', '{'
    ])).toThrow('INVALID_DESIGN_TARGET_JSON');
    expect(() => parseCommand([
      'design-plan', '--project-id', 'project-1', '--target', JSON.stringify({
        document: { scope: 'current-document' }, tree: [{ id: 'root', name: 'root' }]
      })
    ])).toThrow('INVALID_DESIGN_TARGET');
  });

  it('inspect 输出结构、组件、覆盖风险摘要，且只走只读请求', async () => {
    const client = createDesignClient();
    const result = await executeCommand(
      parseCommand(['design-inspect', '--project-id', 'project-1']),
      client
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      revision: 'revision-1',
      tree: [{
        uuid: 'node-root', name: 'root',
        children: [{
          uuid: 'node-label', name: 'label',
          components: [{ type: 'cc.Label', properties: { fontSize: 24 } }]
        }]
      }]
    });
    expect(client.methods).toEqual(['probe.documentSnapshot']);
  });

  it('plan 复用差异与排序引擎，preview 只渲染而不执行写请求', async () => {
    const planClient = createDesignClient();
    const plan = await executeCommand(
      parseCommand(['design-plan', '--project-id', 'project-1', '--target', TARGET_JSON]),
      planClient
    ) as { items: Array<Record<string, unknown>> };
    expect(plan.items).toContainEqual(expect.objectContaining({
      kind: 'component.set_property', target: '$label', propertyPath: 'fontSize', value: 28
    }));

    const previewClient = createDesignClient();
    const preview = await executeCommand(
      parseCommand(['design-preview', '--project-id', 'project-1', '--target', TARGET_JSON]),
      previewClient
    ) as { mode: string; operationCount: number; operations: Array<Record<string, unknown>> };
    expect(preview).toMatchObject({ mode: 'preview', operationCount: 1 });
    expect(preview.operations[0]).toMatchObject({
      kind: 'component.set_property', target: '$label'
    });
    expect([...planClient.methods, ...previewClient.methods]).not.toContain('probe.writePrepare');
    expect([...planClient.methods, ...previewClient.methods]).not.toContain('probe.writeConfirm');
  });
});

interface DesignClient {
  methods: string[];
  request(method: string, payload: unknown): Promise<unknown>;
}

/** 创建返回单页完整文档快照的只读 Client。 */
function createDesignClient(): DesignClient {
  const methods: string[] = [];
  return {
    methods,
    async request(method) {
      methods.push(method);
      if (method !== 'probe.documentSnapshot') throw new Error(`UNEXPECTED_METHOD:${method}`);
      return createSnapshot();
    }
  };
}

function createSnapshot() {
  const emptyIdentity = {
    sessionId: null, assetUuid: null, fileId: null, typeId: null, scriptUuid: null
  };
  return {
    document: {
      assetUuid: 'scene-1', path: 'db://assets/main.scene', filePath: 'E:/project/assets/main.scene',
      documentType: 'scene', available: true, raw: {}
    },
    revision: 'revision-1',
    mode: 'full',
    page: { offset: 0, pageSize: 500, totalNodes: 2, nextCursor: null },
    nodes: [
      {
        kind: 'node', identity: { ...emptyIdentity, objectUuid: 'node-root', fileId: 'file-root' },
        name: 'root', path: 'root', parentObjectUuid: null, childObjectUuids: ['node-label'], components: []
      },
      {
        kind: 'node', identity: { ...emptyIdentity, objectUuid: 'node-label', fileId: 'file-label' },
        name: 'label', path: 'root/label', parentObjectUuid: 'node-root', childObjectUuids: [],
        components: [{
          kind: 'component',
          identity: { ...emptyIdentity, objectUuid: 'component-label', typeId: 'cc.Label' },
          className: 'cc.Label',
          properties: [{
            propertyPath: 'fontSize', declaredType: 'number', valueKind: 'number',
            effectiveValue: 24, sourceValue: 24, overrideValue: null, valueSource: 'local'
          }],
          rawSerializedState: {}
        }]
      }
    ],
    componentSchemas: [], prefabInstances: [],
    coverage: {
      nodes: { total: 2, decoded: 2 }, components: { total: 1, decoded: 1 },
      properties: { total: 1, decoded: 1 }, references: { total: 0, resolved: 0 },
      prefabInstances: { total: 0, resolved: 0 }, overrides: { total: 0, decoded: 0 }
    },
    unresolved: [], diagnostics: []
  };
}
