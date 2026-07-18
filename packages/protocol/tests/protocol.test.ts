import { describe, expect, it } from 'vitest';
import {
  ComponentTypeSchemaSchema,
  ComponentPropertyDescriptorSchema,
  DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
  ProbeResponseSchema,
  PrefabProbeSchema,
  PrefabGraphSchema,
  ProjectScanReportFileSchema,
  ProjectScanReportManifestSchema,
  ProjectScanReportSchema,
  ReferenceSchema,
  createEmptyProjectCoverage,
  resolveWebSocketMaxPayload
} from '../src/index.js';

const validResponse = {
  protocolVersion: '0.4.0',
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

  it('接受包含 Override 摘要、嵌套 TargetMap 和阻断诊断的 Prefab 图', () => {
    const result = PrefabGraphSchema.parse({
      nodes: [
        { assetUuid: 'page-prefab', path: 'db://assets/page.prefab', documentType: 'prefab' },
        { assetUuid: 'goods-prefab', path: 'db://assets/goods.prefab', documentType: 'prefab' }
      ],
      edges: [{
        fromAssetUuid: 'page-prefab',
        toAssetUuid: 'goods-prefab',
        kind: 'prefab-instance',
        hostNodePath: 'Page/Goods',
        instanceFileId: 'goods-instance',
        sourceObjectFileId: 'goods-root',
        depth: 1,
        overrideCount: 1,
        overrideSummary: {
          propertyOverrideCount: 1,
          targetOverrideCount: 0,
          mountedChildrenCount: 0,
          mountedComponentsCount: 0,
          removedComponentsCount: 0
        }
      }],
      targetMaps: {
        targets: {
          'goods-root': { assetUuid: 'goods-prefab', fileId: 'goods-root', nodePath: 'Page/Goods' }
        },
        children: {
          'goods-root': { targets: {}, children: {} }
        }
      },
      targetMapsByAsset: {},
      blocked: true,
      diagnostics: [{
        code: 'PREFAB_GRAPH_CYCLE',
        message: '检测到循环引用',
        severity: 'error',
        details: { cycle: ['page-prefab', 'goods-prefab', 'page-prefab'] }
      }]
    });

    expect(result.edges[0].overrideSummary?.propertyOverrideCount).toBe(1);
    expect(result.targetMaps?.children['goods-root']).toBeTruthy();
    expect(result.blocked).toBe(true);
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

  it('接受包含资产、脚本、文档和 Prefab 图的项目扫描报告', () => {
    const result = ProjectScanReportSchema.parse({
      scanId: 'scan-1',
      status: 'completed-with-gaps',
      project: {
        projectId: 'project-1',
        projectPath: 'E:/project',
        creatorVersion: '3.8.8'
      },
      startedAt: '2026-07-13T12:00:00.000Z',
      finishedAt: '2026-07-13T12:01:00.000Z',
      assets: [{
        assetUuid: 'prefab-uuid',
        url: 'db://assets/ui/Page.prefab',
        filePath: 'E:/project/assets/ui/Page.prefab',
        type: 'cc.Prefab',
        importer: 'prefab',
        name: 'Page',
        isSubAsset: false,
        isBundle: true,
        imported: true,
        invalid: false,
        isDirectory: false,
        visible: true,
        readonly: false,
        displayName: 'Page',
        source: 'assets/ui/Page.prefab',
        path: 'assets/ui/Page.prefab',
        available: true,
        raw: {}
      }],
      scripts: [{
        assetUuid: 'script-uuid',
        scriptPath: 'db://assets/script/Page.ts',
        filePath: 'E:/project/assets/script/Page.ts',
        classNames: ['Page'],
        available: true,
        raw: {}
      }],
      documents: [],
      prefabGraph: {
        nodes: [{
          assetUuid: 'prefab-uuid',
          path: 'db://assets/ui/Page.prefab',
          documentType: 'prefab'
        }],
        edges: []
      },
      coverage: createEmptyProjectCoverage({
        assets: { total: 1, decoded: 1 },
        scripts: { total: 1, decoded: 1 }
      }),
      unresolved: [{
        path: 'documents',
        reason: 'DOCUMENT_SCAN_NOT_STARTED'
      }],
      diagnostics: []
    });

    expect(result.coverage.assets).toEqual({ total: 1, decoded: 1 });
    expect(result.prefabGraph.nodes).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      isBundle: true,
      readonly: false,
      displayName: 'Page'
    });
  });

  it('接受有界项目扫描 manifest，并继续兼容旧完整报告', () => {
    const manifest = {
      formatVersion: 2,
      scanId: 'scan-1',
      status: 'completed-with-gaps',
      project: {
        projectId: 'project-1',
        projectPath: 'E:/project',
        creatorVersion: '3.8.8'
      },
      startedAt: '2026-07-13T12:00:00.000Z',
      finishedAt: '2026-07-13T12:01:00.000Z',
      scanParameters: {
        pageSize: 500,
        includeRaw: true,
        concurrency: 1
      },
      summary: {
        assets: 6711,
        scripts: 906,
        documents: 375,
        completedDocuments: 375,
        failedDocuments: 0,
        prefabGraphNodes: 375,
        prefabGraphEdges: 1200,
        prefabGraphBlocked: false,
        unresolved: 68349,
        diagnostics: 2048
      },
      coverage: createEmptyProjectCoverage(),
      artifacts: {
        checkpoint: {
          path: 'project-scan.checkpoint.json',
          sha256: 'a'.repeat(64),
          bytes: 69528704,
          encoding: 'json'
        },
        assetIndex: {
          path: 'project-scan.assets.json.gz',
          sha256: 'b'.repeat(64),
          bytes: 1234567,
          encoding: 'json-gzip'
        },
        documentSnapshots: {
          count: 375,
          gzipCount: 375,
          jsonCount: 0
        }
      }
    };

    expect(ProjectScanReportManifestSchema.parse(manifest).formatVersion).toBe(2);
    expect(ProjectScanReportFileSchema.parse(manifest)).not.toHaveProperty('documents');
    expect(ProjectScanReportFileSchema.parse({
      scanId: 'legacy-scan',
      status: 'completed',
      project: {
        projectId: 'project-1',
        projectPath: 'E:/project',
        creatorVersion: '3.8.8'
      },
      startedAt: '2026-07-13T12:00:00.000Z',
      finishedAt: '2026-07-13T12:01:00.000Z',
      assets: [],
      scripts: [],
      documents: [],
      prefabGraph: { nodes: [], edges: [] },
      coverage: createEmptyProjectCoverage(),
      unresolved: [],
      diagnostics: []
    })).toHaveProperty('documents');
  });

  it('拒绝项目覆盖率中 resolved 大于 total', () => {
    const report = {
      scanId: 'scan-1',
      status: 'completed',
      project: {
        projectId: 'project-1',
        projectPath: 'E:/project',
        creatorVersion: '3.8.8'
      },
      startedAt: '2026-07-13T12:00:00.000Z',
      finishedAt: '2026-07-13T12:01:00.000Z',
      assets: [],
      scripts: [],
      documents: [],
      prefabGraph: { nodes: [], edges: [] },
      coverage: createEmptyProjectCoverage({
        references: { total: 0, resolved: 1 }
      }),
      unresolved: [],
      diagnostics: []
    };

    expect(() => ProjectScanReportSchema.parse(report)).toThrow('resolved 不能大于 total');
  });
});
