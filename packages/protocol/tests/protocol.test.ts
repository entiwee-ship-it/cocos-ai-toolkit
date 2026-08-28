import { describe, expect, it } from 'vitest';
import {
  ComponentTypeSchemaSchema,
  ComponentPropertyDescriptorSchema,
  DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
  ProbeResponseSchema,
  PrefabProbeSchema,
  ProjectCoverageSchema,
  ReferenceSchema,
  createEmptyProjectCoverage,
  resolveWebSocketMaxPayload
} from '../src/index.js';

const validResponse = {
  protocolVersion: '0.6.0',
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
    },
    writeCapabilities: {
      assessment: 'confirmed',
      documentMode: 'prefab',
      ownerDocumentUuid: 'owner-prefab',
      ownerPrefabUuid: 'nested-prefab',
      ownerSourceUrl: 'db://assets/Nested.prefab',
      sourceFileId: 'file-id',
      isNestedPrefabContent: true,
      isInstanceRoot: false,
      canRename: false,
      canSetTransform: false,
      canDelete: false,
      canReparent: false,
      canDuplicate: false,
      canSetActive: false,
      canSetLayer: false,
      canCreateChild: false,
      canAddComponent: false,
      canRemoveComponent: false,
      canSetComponentProperty: false,
      reasonCode: 'NESTED_PREFAB_CONTENT_CLOSED',
      nextAction: { tool: 'cocos_prefab_open', arguments: { uuid: 'nested-prefab' } }
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
      },
      writeCapabilities: {
        isNestedPrefabContent: true,
        canSetTransform: false,
        ownerPrefabUuid: 'nested-prefab'
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

  it('保留 Prefab 探针中的完整实例来源链字段', () => {
    const result = PrefabProbeSchema.parse({
      ownerDocumentAssetUuid: 'owner-prefab',
      sourcePrefabAssetUuid: 'source-prefab',
      instanceRootObjectUuid: 'instance-root',
      sourceObjectFileId: 'source-file-id',
      instanceFileId: 'instance-file-id',
      prefabRootNodeUuid: 'root-node',
      sync: true,
      state: { state: 2 },
      instanceChain: [{
        depth: 1,
        assetUuid: 'source-prefab',
        instanceNodeUuid: 'instance-root',
        state: 2,
        isNested: true
      }],
      propertyOverrides: [],
      targetOverrides: [],
      mountedChildren: [],
      mountedComponents: [],
      removedComponents: [],
      unresolved: [],
      rawPrefabInfo: {}
    });

    expect(result.instanceChain[0]).toMatchObject({ state: 2, isNested: true });
  });
});

describe('阶段 1 只读协议', () => {
  it('为大文档传输使用有限的 256 MiB WebSocket 上限', () => {
    expect(DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES).toBe(256 * 1024 * 1024);
    expect(resolveWebSocketMaxPayload()).toBe(DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES);
    expect(resolveWebSocketMaxPayload(64)).toBe(64);
    expect(() => resolveWebSocketMaxPayload(0)).toThrow('INVALID_WEBSOCKET_MAX_PAYLOAD');
    expect(() => resolveWebSocketMaxPayload(Number.POSITIVE_INFINITY)).toThrow(
      'INVALID_WEBSOCKET_MAX_PAYLOAD'
    );
  });

  it('接受包含脚本路径、Inspector 元数据和原始字段消费状态的组件 Schema', () => {
    const result = ComponentTypeSchemaSchema.parse({
      className: 'VScrollViewMode',
      qualifiedName: 'VScrollViewMode',
      typeId: 'b9a82SIRzRA64VTpoykHpqL',
      scriptUuid: 'b9a82488-4734-40eb-8553-a68ca41e9a8b',
      scriptPath: 'db://assets/script/components/VScrollViewMode.ts',
      inheritance: ['VirtualScrollView', 'cc.Component', 'cc.Object'],
      executionOrder: 0,
      properties: [{
        propertyPath: 'content',
        serializedName: 'content',
        displayName: '内容节点',
        declaredType: 'cc.Node',
        actualType: 'cc.Node',
        valueKind: 'node-reference',
        nullable: true,
        serializable: true,
        visible: true,
        readonly: false,
        defaultValue: null,
        currentValue: { uuid: 'content-node-uuid' },
        references: [{
          kind: 'node',
          objectUuid: 'content-node-uuid',
          fileId: null,
          nodePath: null,
          available: true
        }],
        inspectorMetadata: {
          tooltip: '滚动内容根节点'
        },
        rawClassAttributes: {
          type: 'cc.Node'
        },
        rawConsumedKeys: ['type', 'tooltip']
      }],
      rawClassAttributes: {},
      unresolved: []
    });

    expect(result.scriptPath).toBe('db://assets/script/components/VScrollViewMode.ts');
    expect(result.properties[0]).toMatchObject({
      valueKind: 'node-reference',
      inspectorMetadata: {
        tooltip: '滚动内容根节点'
      }
    });
  });

  it('组件属性 Schema 必须显式携带当前值和引用列表', () => {
    const descriptor = {
      propertyPath: 'content',
      serializedName: 'content',
      displayName: '内容节点',
      declaredType: 'cc.Node',
      actualType: 'cc.Node',
      valueKind: 'node-reference',
      nullable: true,
      serializable: true,
      visible: true,
      readonly: false,
      defaultValue: null,
      inspectorMetadata: {},
      rawClassAttributes: {},
      rawConsumedKeys: []
    };

    expect(() => ComponentPropertyDescriptorSchema.parse({
      ...descriptor,
      references: []
    })).toThrow();
    expect(() => ComponentPropertyDescriptorSchema.parse({
      ...descriptor,
      currentValue: null
    })).toThrow();
  });

  it('区分可用资产引用和缺失组件引用', () => {
    expect(ReferenceSchema.parse({
      kind: 'asset',
      assetUuid: 'sprite-frame-uuid',
      subAssetUuid: null,
      assetType: 'cc.SpriteFrame',
      path: 'db://assets/ui/button/spriteFrame',
      available: true
    }).kind).toBe('asset');

    expect(ReferenceSchema.parse({
      kind: 'missing',
      expectedKind: 'component',
      serializedUuid: 'removed-component-uuid',
      serializedFileId: 'removed-component-file-id',
      reason: 'target-component-removed'
    }).kind).toBe('missing');
  });

  it('拒绝项目覆盖率中 resolved 大于 total', () => {
    expect(() => ProjectCoverageSchema.parse(createEmptyProjectCoverage({
      references: { total: 0, resolved: 1 }
    }))).toThrow('resolved 不能大于 total');
  });
});
