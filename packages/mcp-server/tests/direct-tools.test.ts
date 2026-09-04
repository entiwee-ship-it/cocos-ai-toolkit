import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCocosMcpServer } from '../src/server.js';
import { COCOS_DIRECT_WRITE_TOOL_NAMES, CocosDirectToolService } from '../src/direct-tools.js';
import { CocosReadonlyToolService, type ReadonlyCreatorClient } from '../src/tools.js';

interface ProbeRequest {
  method: string;
  payload: unknown;
}

class RecordingCreatorClient implements ReadonlyCreatorClient {
  readonly requests: ProbeRequest[] = [];

  constructor(
    private readonly respond: (method: string, payload: unknown) => unknown
  ) {}

  async request(method: string, payload: unknown): Promise<unknown> {
    this.requests.push({ method, payload });
    return this.respond(method, payload);
  }
}

const ONLINE_EDITOR = {
  editorInstanceId: 'proj1:1234',
  projectId: 'proj1',
  projectPath: 'E:/project',
  creatorVersion: '3.8.8',
  bridgeVersion: '0.7.0',
  bridgeBuildId: 'sha256:bridge-build',
  capabilities: [
    'probe.editorState',
    'probe.assetIndex',
    'probe.assetSearch',
    'probe.assets',
    'probe.openAsset',
    'probe.hierarchy',
    'probe.node',
    'probe.nodeSelect',
    'probe.extensionManagerOpen',
    'probe.managerPanelOpen',
    'probe.component'
  ]
};

const EDITOR_STATE = {
  creatorVersion: '3.8.8',
  projectPath: 'E:/project',
  projectId: 'proj1',
  document: { assetUuid: 'prefab-uuid-1', dirty: false },
  ready: { scene: true, assetDatabase: true },
  selection: { node: [], asset: [] },
  preview: null,
  unresolved: []
};

const PREFAB_ASSET = {
  assetUuid: 'prefab-uuid-1',
  url: 'db://assets/ui/Test.prefab',
  filePath: 'E:/project/assets/ui/Test.prefab',
  type: 'cc.Prefab',
  importer: 'prefab',
  name: 'Test',
  isSubAsset: false,
  isBundle: true,
  imported: true,
  invalid: false,
  isDirectory: false,
  visible: true,
  readonly: false,
  displayName: 'Test',
  source: 'assets/ui/Test.prefab',
  path: 'assets/ui/Test.prefab',
  available: true,
  raw: {}
};

const SCENE_ASSET = {
  ...PREFAB_ASSET,
  assetUuid: 'scene-uuid-1',
  url: 'db://assets/main.scene',
  filePath: 'E:/project/assets/main.scene',
  type: 'cc.SceneAsset',
  importer: 'scene',
  name: 'main',
  displayName: 'main',
  source: 'assets/main.scene',
  path: 'assets/main.scene'
};

const HIERARCHY_TREE = {
  identity: { objectUuid: 'root-uuid', fileId: null },
  name: 'Root',
  type: 'cc.Node',
  active: true,
  layer: null,
  siblingIndex: 0,
  parentUuid: null,
  path: 'Root',
  prefab: null,
  components: [],
  children: [{
    identity: { objectUuid: 'panel-uuid', fileId: null },
    name: 'Panel',
    type: 'cc.Node',
    active: true,
    layer: null,
    siblingIndex: 0,
    parentUuid: 'root-uuid',
    path: 'Root/Panel',
    prefab: null,
    components: [],
    children: [],
    raw: null
  }],
  raw: null
};

const NODE_DETAIL = {
  identity: { objectUuid: 'panel-uuid', fileId: null },
  name: 'Panel',
  type: 'cc.Node',
  active: true,
  layer: 33554432,
  siblingIndex: 0,
  parentUuid: 'root-uuid',
  childUuids: [],
  transform: { position: null, rotation: null, scale: null },
  prefabInstance: {
    isInstanceRoot: true,
    prefabAssetUuid: 'source-prefab',
    instanceFileId: 'instance-file-id',
    state: 2,
    sourceUrl: 'db://assets/ui/Source.prefab'
  },
  writeCapabilities: {
    assessment: 'confirmed',
    documentMode: 'prefab',
    ownerDocumentUuid: 'owner-prefab',
    ownerPrefabUuid: 'source-prefab',
    ownerSourceUrl: 'db://assets/ui/Source.prefab',
    sourceFileId: 'panel-file-id',
    isNestedPrefabContent: true,
    isInstanceRoot: true,
    canRename: true,
    canSetTransform: true,
    canDelete: true,
    canReparent: true,
    canDuplicate: true,
    canSetActive: false,
    canSetLayer: false,
    canCreateChild: false,
    canAddComponent: false,
    canRemoveComponent: false,
    canSetComponentProperty: false,
    reasonCode: 'NESTED_PREFAB_INSTANCE_ROOT_LIMITED',
    nextAction: { tool: 'cocos_prefab_open', arguments: { uuid: 'source-prefab' } }
  },
  components: [{
    identity: { objectUuid: 'label-comp-uuid', fileId: 'label-file-id' },
    class: {
      className: 'cc.Label',
      typeId: 'cc.Label',
      custom: false,
      scriptUuid: null,
      scriptPath: null,
      inheritance: ['cc.Label', 'cc.Component']
    },
    properties: {},
    schema: null,
    unresolved: [],
    raw: null
  }],
  unresolved: [],
  raw: null
};

const COMPONENT_SCHEMA = {
  className: 'cc.Label',
  qualifiedName: 'cc.Label',
  typeId: 'cc.Label',
  scriptUuid: null,
  scriptPath: null,
  inheritance: ['cc.Label', 'cc.Component'],
  executionOrder: 0,
  properties: [],
  rawClassAttributes: {},
  unresolved: []
};

const COMPONENT_SCHEMA_WITH_PROPERTIES = {
  ...COMPONENT_SCHEMA,
  properties: [{
    propertyPath: 'string',
    serializedName: '_string',
    displayName: 'String',
    declaredType: 'string',
    actualType: 'string',
    valueKind: 'string',
    nullable: false,
    serializable: true,
    visible: true,
    readonly: false,
    defaultValue: '',
    currentValue: '当前标题',
    references: [],
    inspectorMetadata: {},
    rawClassAttributes: {},
    rawConsumedKeys: []
  }]
};

const INSPECT_ASSET_RESPONSE = {
  assets: [],
  details: {
    uuid: 'prefab-uuid-1',
    url: 'db://assets/ui/Test.prefab',
    file: 'E:/project/assets/ui/Test.prefab',
    type: 'cc.Prefab',
    importer: 'prefab',
    isSubAsset: false,
    isBundle: true,
    name: 'Test',
    source: 'assets/ui/Test.prefab',
    path: 'assets/ui/Test.prefab',
    displayName: 'Test',
    imported: true,
    invalid: false,
    isDirectory: false,
    visible: true,
    readonly: false,
    unknownFieldCount: 0,
    raw: {}
  },
  meta: null,
  dependencies: [],
  users: [],
  unresolved: []
};

const DIRECT_WRITE_SUCCESS = {
  kind: 'success',
  executedOps: 1,
  verification: {
    passed: true,
    verifiedAt: '2026-07-30T00:00:00.000Z',
    items: [{ operationIndex: 0, description: '写入生效', expected: 'ok', actual: 'ok', passed: true }]
  }
};

const PREFAB_CREATE_SUCCESS = {
  kind: 'success',
  executedOps: 1,
  verification: {
    passed: true,
    verifiedAt: '2026-09-01T00:00:00.000Z',
    items: [{
      operationIndex: 0,
      description: '从节点生成预制体',
      expected: '节点已关联预制体资产',
      actual: 'new-prefab-uuid',
      passed: true
    }]
  },
  evidence: [{
    operation: {
      type: 'prefab.create_from_node',
      nodeUuid: 'panel-uuid',
      assetUrl: 'db://assets/ui/New.prefab',
      resultNodeUuid: 'rebuilt-node-uuid',
      resultAssetUuid: 'new-prefab-uuid'
    },
    nodeUuid: 'rebuilt-node-uuid',
    assetUuid: 'new-prefab-uuid',
    before: null,
    after: null
  }]
};

function createRespond(overrides: Record<string, unknown> = {}) {
  return (method: string, _payload?: unknown): unknown => {
    if (method === 'server.editors') return [ONLINE_EDITOR];
    if (method in overrides) return overrides[method];
    if (method === 'probe.assetIndex') {
      return { assets: [PREFAB_ASSET], scripts: [], documents: [], unresolved: [] };
    }
    if (method === 'probe.assetSearch') {
      return { assets: [PREFAB_ASSET], total: 1, revision: 'asset-revision-1', unresolved: [] };
    }
    if (method === 'probe.editorState') return EDITOR_STATE;
    if (method === 'probe.openAsset') return { opened: true, uuid: 'prefab-uuid-1' };
    if (method === 'probe.hierarchy') return { data: HIERARCHY_TREE, raw: null, source: 'message-api' };
    if (method === 'probe.node') return { data: NODE_DETAIL, raw: null, source: 'message-api' };
  if (method === 'probe.nodeSelect') return { nodeUuid: 'panel-uuid', selected: true, selection: ['panel-uuid'] };
  if (method === 'probe.extensionManagerOpen') return { opened: true, panel: 'extension.manager' };
  if (method === 'probe.managerPanelOpen') return { opened: true, panel: 'cocos-ai-bridge' };
    if (method === 'probe.component') {
      return { data: { schema: COMPONENT_SCHEMA, raw: null }, raw: null, source: 'message-api' };
    }
    if (method === 'probe.assets') return INSPECT_ASSET_RESPONSE;
    if (method === 'probe.directWrite') return DIRECT_WRITE_SUCCESS;
    if (method === 'probe.deleteAsset') return { deleted: true, assetUrl: 'db://assets/ui/Test.prefab', verified: true };
    if (method === 'probe.saveDocument') return { saved: true };
    if (method === 'probe.importAsset') {
      return { uuid: 'imported-uuid', type: 'cc.Texture2D', assetUrl: 'db://assets/ui/icon.png' };
    }
    if (method === 'probe.refreshAsset') {
      return { refreshed: true, assetUrl: 'db://assets/script/A.ts', compileTriggered: true };
    }
    return {};
  };
}

const harnesses: Array<{ server: McpServer; client: Client }> = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

async function createHarness(
  creatorClient: ReadonlyCreatorClient,
  options: { enableWrites?: boolean } = {}
) {
  const server = createCocosMcpServer(
    { creatorClient },
    { enableWrites: options.enableWrites }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'direct-test-client', version: '0.7.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  harnesses.push({ server, client });
  return { client };
}

describe('直写档工具注册', () => {
  it('默认注册只读工具，写工具仅 enableWrites 时注册', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const readonlyTools = (await client.listTools()).tools;
    const names = readonlyTools.map((tool) => tool.name);
    for (const expected of [
      'cocos_editor_list',
      'cocos_editor_state',
      'cocos_extension_manager_open',
      'cocos_tool_manager_open',
      'cocos_asset_search',
      'cocos_asset_inspect',
      'cocos_hierarchy',
      'cocos_node_read',
      'cocos_nodes_read',
      'cocos_prefab_open',
      'cocos_scene_open'
    ]) {
      expect(names).toContain(expected);
    }
    for (const gated of [
      'cocos_node_create',
      'cocos_node_rename',
      'cocos_node_set_transform',
      'cocos_node_select',
      'cocos_node_delete',
      'cocos_node_reparent',
      'cocos_component_add',
      'cocos_component_set_property',
      'cocos_prefab_instantiate',
      'cocos_prefab_unpack',
      'cocos_prefab_create',
      'cocos_prefab_rename',
      'cocos_document_save',
      'cocos_prefab_delete',
      'cocos_asset_import',
      'cocos_asset_refresh',
      'cocos_batch_write'
    ]) {
      expect(names).not.toContain(gated);
    }
    const hierarchyTool = readonlyTools.find((tool) => tool.name === 'cocos_hierarchy');
    const nodeReadTool = readonlyTools.find((tool) => tool.name === 'cocos_node_read');
    expect(hierarchyTool?.description).toContain('结构/信封层重复 raw');
    expect(hierarchyTool?.description).toContain('Inspector 业务值内部的 raw');
    expect(nodeReadTool?.description).toContain('结构/信封层重复 raw');
    expect(nodeReadTool?.description).toContain('Inspector 业务值内部的 raw');

    const { client: writeClient } = await createHarness(creatorClient, { enableWrites: true });
    const writeTools = (await writeClient.listTools()).tools;
    const writeNames = writeTools.map((tool) => tool.name);
    for (const gated of [
      'cocos_node_create',
      'cocos_node_rename',
      'cocos_node_set_transform',
      'cocos_node_select',
      'cocos_node_delete',
      'cocos_node_reparent',
      'cocos_component_add',
      'cocos_component_set_property',
      'cocos_prefab_instantiate',
      'cocos_prefab_unpack',
      'cocos_prefab_create',
      'cocos_prefab_rename',
      'cocos_document_save',
      'cocos_prefab_delete',
      'cocos_asset_import',
      'cocos_asset_refresh',
      'cocos_batch_write'
    ]) {
      expect(writeNames).toContain(gated);
    }
    expect(writeNames.filter((name) => COCOS_DIRECT_WRITE_TOOL_NAMES.includes(
      name as (typeof COCOS_DIRECT_WRITE_TOOL_NAMES)[number]
    ))).toEqual([...COCOS_DIRECT_WRITE_TOOL_NAMES]);
    const batchTool = writeTools.find((tool) => tool.name === 'cocos_batch_write');
    expect(batchTool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(batchTool?.description).toContain('node.* / component.*');
    expect(batchTool?.description).toContain('asset.* / prefab.*');
    const batchSchema = JSON.stringify(batchTool?.inputSchema);
    expect(batchSchema).not.toContain('asset.delete');
    expect(batchSchema).not.toContain('prefab.delete_asset');
    expect(batchSchema).toContain('node.set_transform');
    expect(batchSchema).toContain('component.set_property');
    const transformTool = writeTools.find((tool) => tool.name === 'cocos_node_set_transform');
    expect(transformTool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const componentPropertyTool = writeTools.find((tool) => tool.name === 'cocos_component_set_property');
    expect(componentPropertyTool?.description).toContain('Button.clickEvents');
    expect(componentPropertyTool?.description).toContain('node.on');
  });
});

describe('直写档只读工具', () => {
  it('cocos_editor_list 返回已连接编辑器', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({ name: 'cocos_editor_list', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      editors: [{ projectId: 'proj1', editorInstanceId: 'proj1:1234' }]
    });
  });

  it('Creator Client 已关闭时 cocos_editor_list 仍成功返回固定结构和后端状态', async () => {
    const creatorClient: ReadonlyCreatorClient = {
      getStatus: () => ({
      transport: 'named-pipe',
      state: 'closed',
      endpointRoot: 'C:/CocosAI/creator-endpoints'
      }),
      async request() {
        throw new Error('REQUEST_SHOULD_NOT_RUN');
      }
    };
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({ name: 'cocos_editor_list', arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      editors: [],
      backend: {
        available: false,
        transport: 'named-pipe',
        state: 'closed'
      }
    });
  });

  it('cocos_editor_state 返回当前文档、就绪和 dirty 状态', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_editor_state',
      arguments: { projectId: 'proj1' }
    });
    expect(result.structuredContent).toMatchObject({
      editor: { projectId: 'proj1' },
      state: {
        document: { assetUuid: 'prefab-uuid-1', dirty: false },
        ready: { scene: true, assetDatabase: true }
      }
    });
    expect(creatorClient.requests.at(-1)?.method).toBe('probe.editorState');
  });

  it('cocos_extension_manager_open 直接打开 Creator 扩展管理器', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_extension_manager_open',
      arguments: { projectId: 'proj1' }
    });

    expect(result.structuredContent).toMatchObject({
      editor: { projectId: 'proj1' },
      opened: true,
      panel: 'extension.manager'
    });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.extensionManagerOpen',
      payload: { params: {} }
    });
  });

  it('cocos_tool_manager_open 直接打开 Cocos AI 工具管理面板', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_tool_manager_open',
      arguments: { projectId: 'proj1' }
    });

    expect(result.structuredContent).toMatchObject({
      editor: { projectId: 'proj1' },
      opened: true,
      panel: 'cocos-ai-bridge'
    });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.managerPanelOpen',
      payload: { params: {} }
    });
  });

  it('cocos_asset_search 在 Bridge 内过滤资产，不拉取全量索引', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_asset_search',
      arguments: { projectId: 'proj1', pattern: '  TEST  ' }
    });

    expect(result.structuredContent).toMatchObject({
      query: { pattern: '  TEST  ' },
      page: { total: 1, items: [{ assetUuid: 'prefab-uuid-1' }] }
    });
    expect(creatorClient.requests).toContainEqual(expect.objectContaining({
      method: 'probe.assetSearch',
      payload: expect.objectContaining({
        params: { pattern: 'test', includeRaw: false, offset: 0, pageSize: 50 }
      })
    }));
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.assetIndex');
  });

  it('cocos_asset_search cursor 只向 Bridge 请求下一页', async () => {
    const fallback = createRespond();
    const creatorClient = new RecordingCreatorClient((method, payload) => {
      if (method !== 'probe.assetSearch') return fallback(method, payload);
      const params = (payload as { params: { offset: number } }).params;
      return {
        assets: [params.offset === 0 ? PREFAB_ASSET : SCENE_ASSET],
        total: 2,
        revision: 'asset-revision-1',
        unresolved: []
      };
    });
    const { client } = await createHarness(creatorClient);

    const first = await client.callTool({
      name: 'cocos_asset_search',
      arguments: { projectId: 'proj1', pattern: 'asset', pageSize: 1 }
    });
    const nextCursor = (first.structuredContent as { page: { nextCursor: string } }).page.nextCursor;
    const second = await client.callTool({
      name: 'cocos_asset_search',
      arguments: { projectId: 'proj1', pattern: 'asset', pageSize: 1, cursor: nextCursor }
    });

    expect(second.structuredContent).toMatchObject({
      page: { offset: 1, total: 2, items: [{ assetUuid: 'scene-uuid-1' }] }
    });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.assetSearch',
      payload: { params: { pattern: 'asset', includeRaw: false, offset: 1, pageSize: 1 } }
    });
  });

  it('cocos_asset_inspect 返回资产详情和引用关系', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.assets': { ...INSPECT_ASSET_RESPONSE, dependencies: ['script-uuid-1'], users: ['scene-uuid-1'] }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_asset_inspect',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.structuredContent).toMatchObject({
      asset: { uuid: 'prefab-uuid-1', type: 'cc.Prefab' },
      page: {
        total: 2,
        items: expect.arrayContaining([
          { kind: 'dependency', assetUuid: 'script-uuid-1' },
          { kind: 'user', assetUuid: 'scene-uuid-1' }
        ])
      }
    });
    expect(creatorClient.requests).toContainEqual(expect.objectContaining({
      method: 'probe.assets',
      payload: expect.objectContaining({ params: { uuid: 'prefab-uuid-1' } })
    }));
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.assetIndex');
  });

  it('cocos_scene_open 打开 Scene 并等待文档身份就绪', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.assets': {
        ...INSPECT_ASSET_RESPONSE,
        details: {
          ...INSPECT_ASSET_RESPONSE.details,
          uuid: SCENE_ASSET.assetUuid,
          url: SCENE_ASSET.url,
          file: SCENE_ASSET.filePath,
          type: SCENE_ASSET.type,
          importer: SCENE_ASSET.importer,
          name: SCENE_ASSET.name,
          displayName: SCENE_ASSET.displayName,
          source: SCENE_ASSET.source,
          path: SCENE_ASSET.path
        }
      },
      'probe.openAsset': { opened: true, uuid: 'scene-uuid-1' },
      'probe.editorState': { ...EDITOR_STATE, document: { assetUuid: 'scene-uuid-1', dirty: false } }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_scene_open',
      arguments: { projectId: 'proj1', uuid: 'scene-uuid-1' }
    });
    expect(result.structuredContent).toMatchObject({
      opened: true,
      asset: { assetUuid: 'scene-uuid-1', type: 'cc.SceneAsset' }
    });
  });

  it('cocos_prefab_open 打开资产并轮询文档身份就绪', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_prefab_open',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.structuredContent).toMatchObject({ opened: true });
    const methods = creatorClient.requests.map((request) => request.method);
    expect(methods).toContain('probe.openAsset');
    expect(methods).toContain('probe.editorState');
    expect(methods).toContain('probe.assets');
    expect(methods).not.toContain('probe.assetIndex');
    expect(creatorClient.requests).toContainEqual(expect.objectContaining({
      method: 'probe.assets',
      payload: expect.objectContaining({ params: { uuid: 'prefab-uuid-1', detailsOnly: true } })
    }));
  });

  it('cocos_prefab_open 在当前文档 dirty 时拒绝切换且不读取目标资产', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.editorState': {
        ...EDITOR_STATE,
        document: { assetUuid: 'dirty-scene-uuid', dirty: true }
      }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_prefab_open',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'DOCUMENT_SAVE_REQUIRED',
        details: {
          currentDocumentUuid: 'dirty-scene-uuid',
          targetDocumentUuid: 'prefab-uuid-1'
        },
        nextAction: expect.stringContaining('cocos_document_save')
      }
    });
    const methods = creatorClient.requests.map((request) => request.method);
    expect(methods).not.toContain('probe.openAsset');
    expect(methods).not.toContain('probe.assets');
  });

  it('cocos_prefab_open 对非 Prefab 资产拒绝', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.assets': {
        ...INSPECT_ASSET_RESPONSE,
        details: { ...INSPECT_ASSET_RESPONSE.details, type: 'cc.ImageAsset' }
      }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_prefab_open',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ASSET_NOT_PREFAB');
  });

  it('cocos_hierarchy 转发层级请求', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', depth: 6 }
    });
    expect(result.structuredContent).toMatchObject({ hierarchy: { data: { name: 'Root' } } });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.hierarchy',
      payload: { selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' }, params: { depth: 6 } }
    });
    expect((creatorClient.requests.at(-1)?.payload as { params: unknown }).params).toEqual({ depth: 6 });
    expect(JSON.stringify(result.structuredContent)).toContain('raw');
  });

  it('cocos_hierarchy 和 cocos_node_read 把完整读取预算转发给 Bridge', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', maxOutputBytes: 64 * 1024 }
    });
    await client.callTool({
      name: 'cocos_node_read',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', maxOutputBytes: 64 * 1024 }
    });

    const hierarchyRequest = creatorClient.requests.find((request) => request.method === 'probe.hierarchy');
    const nodeRequest = creatorClient.requests.find((request) => request.method === 'probe.node');
    expect(hierarchyRequest).toMatchObject({ payload: { params: { maxOutputBytes: 64 * 1024 } } });
    expect(nodeRequest).toMatchObject({ payload: { params: { uuid: 'panel-uuid', maxOutputBytes: 64 * 1024 } } });
  });

  it('cocos_hierarchy 的紧凑参数按子树和查询投影并移除所有 raw', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: {
        projectId: 'proj1',
        rootPath: 'Root',
        query: 'Panel',
        fields: ['name', 'identity.objectUuid'],
        summary: true
      }
    });
    expect(result.structuredContent).toMatchObject({
      hierarchy: {
        rootPath: 'Root',
        summary: { scopedNodeCount: 2, matchedNodeCount: 1 },
        nodes: [{ path: 'Root/Panel', name: 'Panel', identity: { objectUuid: 'panel-uuid' } }]
      }
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"raw"');
    const hierarchyRequests = creatorClient.requests.filter((request) => request.method === 'probe.hierarchy');
    expect(hierarchyRequests).toHaveLength(2);
    expect(hierarchyRequests[0]).toMatchObject({ payload: { params: { depth: 50, compact: true } } });
    expect(hierarchyRequests[1]).toMatchObject({
      payload: { params: { depth: 50, rootUuid: 'root-uuid', compact: true } }
    });
  });

  it('cocos_hierarchy 深层 rootPath 原生读取子树并保留截断', async () => {
    const creatorClient = new RecordingCreatorClient((method, payload) => {
      if (method === 'server.editors') return [ONLINE_EDITOR];
      if (method === 'probe.hierarchy') {
        const params = (payload as { params?: { rootUuid?: string } }).params ?? {};
        return params.rootUuid ? {
          data: {
            ...HIERARCHY_TREE.children[0],
            path: 'Panel',
            truncated: true
          },
          raw: null,
          source: 'message-api'
        } : { data: HIERARCHY_TREE, raw: null, source: 'message-api' };
      }
      return createRespond()(method, payload);
    });
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', rootPath: 'Root/Panel', depth: 2, fields: ['name'] }
    });

    expect(result.structuredContent).toMatchObject({
      hierarchy: {
        rootPath: 'Root/Panel',
        truncated: true,
        nodes: [{ path: 'Root/Panel', name: 'Panel', truncated: true }]
      }
    });
    const hierarchyRequests = creatorClient.requests.filter((request) => request.method === 'probe.hierarchy');
    expect(hierarchyRequests[1]).toMatchObject({
      payload: { params: { depth: 2, rootUuid: 'panel-uuid', compact: true } }
    });
  });

  it('cocos_hierarchy summary=false 保持完整旧返回', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', summary: false }
    });
    expect(result.structuredContent).toMatchObject({ hierarchy: { data: { name: 'Root' } } });
    expect(JSON.stringify(result.structuredContent)).toContain('"raw"');
    expect((creatorClient.requests.at(-1)?.payload as { params: unknown }).params).toEqual({});
  });

  it('cocos_hierarchy summary-only 不重复返回节点树', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', summary: true }
    });
    expect(result.structuredContent).toMatchObject({
      hierarchy: { summary: { totalNodeCount: 2, scopedNodeCount: 2 } }
    });
    expect((result.structuredContent as { hierarchy: Record<string, unknown> }).hierarchy).not.toHaveProperty('nodes');
    expect(creatorClient.requests.at(-1)).toMatchObject({ payload: { params: { compact: true } } });
  });

  it('cocos_node_read 提供 componentType 时返回组件完整属性', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', componentType: 'cc.Label' }
    });
    expect(result.structuredContent).toMatchObject({
      nodeUuid: 'panel-uuid',
      componentUuid: 'label-comp-uuid',
      component: { className: 'cc.Label' }
    });
    const nodeRequest = creatorClient.requests.find((request) => request.method === 'probe.node');
    expect((nodeRequest?.payload as { params: unknown }).params).toEqual({ uuid: 'panel-uuid' });
  });

  it('cocos_node_read 返回 Prefab 摘要并转发编辑态 bounds 选项', async () => {
    const bounds = {
      hasUiTransform: true,
      localRect: { x: -50, y: -50, width: 100, height: 100 },
      worldRect: { x: 10, y: 20, width: 100, height: 100 }
    };
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.node': { data: { ...NODE_DETAIL, bounds }, raw: null, source: 'message-api' }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        includeBounds: true,
        includeDescendantVisualUnion: true,
        relativeToPath: 'Root',
        summary: true
      }
    });

    expect(result.structuredContent).toMatchObject({
      prefabInstance: NODE_DETAIL.prefabInstance,
      writeCapabilities: NODE_DETAIL.writeCapabilities,
      bounds,
      summary: {
        prefabInstance: NODE_DETAIL.prefabInstance,
        writeCapabilities: NODE_DETAIL.writeCapabilities
      }
    });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.node',
      payload: {
        params: {
          uuid: 'panel-uuid',
          includeBounds: true,
          includeDescendantVisualUnion: true,
          relativeToUuid: 'root-uuid',
          relativeToPath: 'Root',
          compact: true
        }
      }
    });
  });

  it('cocos_nodes_read 保留顺序并隔离单项错误', async () => {
    const respond = createRespond();
    const creatorClient = new RecordingCreatorClient((method, payload) => {
      const uuid = (payload as { params?: { uuid?: string } }).params?.uuid;
      if (method === 'probe.node' && uuid === 'missing-uuid') throw new Error('NODE_NOT_FOUND:missing-uuid');
      return respond(method, payload);
    });
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_nodes_read',
      arguments: {
        projectId: 'proj1',
        nodeUuids: ['panel-uuid', 'missing-uuid'],
        paths: ['Root/Panel'],
        fields: ['name', 'prefabInstance']
      }
    });

    expect(result.structuredContent).toMatchObject({
      items: [
        { requestIndex: 0, requested: { nodeUuid: 'panel-uuid' }, found: true, node: { name: 'Panel' } },
        { requestIndex: 1, requested: { nodeUuid: 'missing-uuid' }, found: false, error: { code: 'NODE_NOT_FOUND' } },
        { requestIndex: 2, requested: { path: 'Root/Panel' }, nodeUuid: 'panel-uuid', found: true }
      ],
      count: { requested: 3, returned: 3, found: 2, errors: 1, omitted: 0 },
      output: { truncated: false }
    });
    const hierarchyRequests = creatorClient.requests.filter((request) => request.method === 'probe.hierarchy');
    expect(hierarchyRequests).toHaveLength(1);
    expect(hierarchyRequests[0]).toMatchObject({ payload: { params: { depth: 50, compact: true } } });
    const nodeRequests = creatorClient.requests.filter((request) => request.method === 'probe.node');
    expect(nodeRequests).toHaveLength(3);
    expect(nodeRequests.every((request) => (
      (request.payload as { params: { compact?: boolean } }).params.compact === true
    ))).toBe(true);
  });

  it('cocos_nodes_read 以并发 4 读取并保持输入顺序', async () => {
    const fallback = createRespond();
    let active = 0;
    let maxActive = 0;
    const creatorClient = new RecordingCreatorClient(async (method, payload) => {
      if (method !== 'probe.node') return fallback(method, payload);
      const uuid = (payload as { params: { uuid: string } }).params.uuid;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, (8 - Number(uuid.slice(5))) * 2));
      active -= 1;
      return {
        data: {
          ...NODE_DETAIL,
          identity: { ...NODE_DETAIL.identity, objectUuid: uuid },
          name: uuid
        },
        source: 'message-api'
      };
    });
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_nodes_read',
      arguments: {
        projectId: 'proj1',
        nodeUuids: Array.from({ length: 8 }, (_, index) => `node-${index}`),
        summary: true
      }
    });

    const items = (result.structuredContent as { items: Array<{ requestIndex: number; nodeUuid: string }> }).items;
    expect(maxActive).toBe(4);
    expect(items.map((item) => item.requestIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(items.map((item) => item.nodeUuid)).toEqual(Array.from({ length: 8 }, (_, index) => `node-${index}`));
  });

  it('cocos_nodes_read 超出输出预算时显式截断', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.node': {
        data: { ...NODE_DETAIL, name: 'x'.repeat(20_000) },
        raw: null,
        source: 'message-api'
      }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_nodes_read',
      arguments: { projectId: 'proj1', nodeUuids: ['panel-uuid'], maxOutputBytes: 16 * 1024 }
    });

    expect(result.structuredContent).toMatchObject({
      count: { requested: 1, returned: 0, omitted: 1 },
      output: { truncated: true }
    });
  });

  it('cocos_node_read 组件类型未命中时给出可用清单', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', componentType: 'cc.Button' }
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'COMPONENT_NOT_FOUND', retryable: false }
    });
    expect(JSON.stringify(result.content)).toContain('COMPONENT_NOT_FOUND');
    expect(JSON.stringify(result.content)).toContain('cc.Label');
  });

  it('cocos_node_read propertyPaths 只返回指定组件属性并移除 raw', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.component': { data: { schema: COMPONENT_SCHEMA_WITH_PROPERTIES, raw: { duplicate: true } }, raw: { envelope: true }, source: 'message-api' }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: {
        projectId: 'proj1',
        path: 'Root/Panel',
        componentType: 'cc.Label',
        fields: ['name', 'transform.position'],
        propertyPaths: ['string'],
        summary: true,
        includeRaw: true
      }
    });
    expect(result.structuredContent).toMatchObject({
      nodeUuid: 'panel-uuid',
      componentUuid: 'label-comp-uuid',
      node: { name: 'Panel', transform: { position: null } },
      component: {
        className: 'cc.Label',
        propertyCount: 1,
        properties: [{ propertyPath: 'string', currentValue: '当前标题' }]
      }
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"raw"');
  });

  it('cocos_node_read 紧凑投影保留业务 currentValue 内的 raw 字段', async () => {
    const schema = {
      ...COMPONENT_SCHEMA_WITH_PROPERTIES,
      properties: [{
        ...COMPONENT_SCHEMA_WITH_PROPERTIES.properties[0],
        currentValue: { raw: 'keep-me', nested: { raw: 'keep-nested' } },
        raw: { inspectorDuplicate: true }
      }]
    };
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.component': { data: { schema, raw: { duplicate: true } }, raw: { envelope: true }, source: 'message-api' }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        componentType: 'cc.Label',
        propertyPaths: ['string']
      }
    });
    expect(result.structuredContent).toMatchObject({
      component: {
        properties: [{
          currentValue: { raw: 'keep-me', nested: { raw: 'keep-nested' } }
        }]
      }
    });
    expect(result.structuredContent).not.toHaveProperty('raw');
  });

  it('cocos_node_read fields 支持数组下标投影', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        fields: ['components[0].class.className']
      }
    });
    expect(result.structuredContent).toMatchObject({
      node: { components: [{ class: { className: 'cc.Label' } }] }
    });
  });

  it('fields 拒绝原型链危险字段且不会污染 Object.prototype', async () => {
    const beforeToString = Object.prototype.toString;
    const beforeConstructor = Object.prototype.constructor;

    for (const testCase of [
      { name: 'cocos_hierarchy', arguments: { projectId: 'proj1', fields: ['__proto__.polluted'] } },
      { name: 'cocos_node_read', arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', fields: ['identity.prototype.polluted'] } },
      { name: 'cocos_node_read', arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', fields: ['identity.constructor'] } }
    ]) {
      const creatorClient = new RecordingCreatorClient(createRespond());
      const { client } = await createHarness(creatorClient);
      const result = await client.callTool(testCase);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('FIELD_PATH_FORBIDDEN');
      expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.hierarchy');
    }

    expect(Object.prototype.toString).toBe(beforeToString);
    expect(Object.prototype.constructor).toBe(beforeConstructor);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('cocos_node_read 对缺失 propertyPath 返回可用路径', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.component': { data: { schema: COMPONENT_SCHEMA_WITH_PROPERTIES, raw: null }, raw: null, source: 'message-api' }
    }));
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        componentType: 'cc.Label',
        propertyPaths: ['missing.path']
      }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PROPERTY_PATH_NOT_FOUND');
    expect(JSON.stringify(result.content)).toContain('string');
  });

  it('cocos_node_read 禁止在没有 componentType 时使用 propertyPaths', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', propertyPaths: ['string'] }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PROPERTY_PATHS_REQUIRE_COMPONENT_TYPE');
  });
});

describe('直写档写工具', () => {
  it('cocos_node_create 按 parentPath 解析父节点并直写 node.create', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_create',
      arguments: { projectId: 'proj1', parentPath: 'Root/Panel', name: 'NewChild' }
    });
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'success', executedOps: 1 }
    });
    const write = creatorClient.requests.at(-1);
    expect(write?.method).toBe('probe.directWrite');
    const payload = write?.payload as {
      params: { operations: Array<Record<string, unknown>>; save: boolean }
    };
    expect(payload.params.save).toBe(true);
    expect(payload.params.operations).toEqual([{
      type: 'node.create',
      parentNodeUuid: 'panel-uuid',
      name: 'NewChild'
    }]);
  });

  it('cocos_node_create 路径未命中时报 NODE_NOT_FOUND', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_create',
      arguments: { projectId: 'proj1', parentPath: 'Root/Nope', name: 'X' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('NODE_NOT_FOUND');
  });

  it('cocos_prefab_instantiate 按 parentPath 直写并返回重开后的稳定实例证据', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': {
        kind: 'success',
        executedOps: 1,
        verification: {
          passed: true,
          verifiedAt: '2026-08-26T00:00:00.000Z',
          items: [{
            operationIndex: 0,
            description: '实例化 Prefab avatar-prefab',
            expected: '实例已建立且源资产一致',
            actual: {
              nodeUuid: 'avatar-node-reloaded',
              stablePath: '/Root~0/Panel~0/Avatar~0',
              prefabAssetUuid: 'avatar-prefab',
              instanceFileId: 'avatar-instance'
            },
            passed: true
          }]
        },
        evidence: [{
          operation: {
            type: 'prefab.instantiate',
            prefabAssetUuid: 'avatar-prefab',
            parentNodeUuid: 'panel-uuid',
            name: 'Avatar',
            resultNodeUuid: 'avatar-node-created',
            resultNodeStablePath: '/Root~0/Panel~0/Avatar~0',
            resultPrefabAssetUuid: 'avatar-prefab',
            resultPrefabInstanceFileId: 'avatar-instance'
          }
        }]
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_instantiate',
      arguments: {
        projectId: 'proj1',
        prefabUuid: 'avatar-prefab',
        parentPath: 'Root/Panel',
        name: 'Avatar'
      }
    });

    expect(result.structuredContent).toMatchObject({
      nodeUuid: 'avatar-node-reloaded',
      prefabAssetUuid: 'avatar-prefab',
      instanceFileId: 'avatar-instance',
      stablePath: '/Root~0/Panel~0/Avatar~0',
      verification: { passed: true }
    });
    const write = creatorClient.requests.at(-1);
    expect(write?.method).toBe('probe.directWrite');
    const payload = write?.payload as {
      params: { operations: Array<Record<string, unknown>>; save: boolean };
    };
    expect(payload.params).toEqual({
      operations: [{
        type: 'prefab.instantiate',
        prefabAssetUuid: 'avatar-prefab',
        parentNodeUuid: 'panel-uuid',
        name: 'Avatar'
      }],
      save: true
    });
  });

  it('cocos_prefab_instantiate 保留 Bridge 的资产和父节点结构化错误', async () => {
    for (const code of [
      'PREFAB_ASSET_NOT_FOUND',
      'PREFAB_ASSET_TYPE_MISMATCH',
      'NODE_NOT_FOUND'
    ]) {
      const creatorClient = new RecordingCreatorClient(createRespond({
        'probe.directWrite': {
          kind: 'operation-failed',
          executedOps: 0,
          failure: { code, message: code, operationIndex: 0 }
        }
      }));
      const { client } = await createHarness(creatorClient, { enableWrites: true });

      const result = await client.callTool({
        name: 'cocos_prefab_instantiate',
        arguments: { projectId: 'proj1', prefabUuid: 'avatar-prefab', parentUuid: 'panel-uuid' }
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(code);
    }
  });

  it('cocos_prefab_instantiate 对 unknown 和 verify-fail 都失败且不包装成成功', async () => {
    const outcomes = [
      {
        kind: 'unknown',
        executedOps: 1,
        failure: {
          code: 'DIRECT_WRITE_VERIFICATION_UNKNOWN',
          message: 'DIRECT_WRITE_VERIFICATION_UNKNOWN',
          operationIndex: null,
          stage: 'unknown'
        }
      },
      {
        kind: 'success',
        executedOps: 1,
        verification: {
          passed: false,
          verifiedAt: '2026-08-26T00:00:00.000Z',
          items: [{
            operationIndex: 0,
            description: '实例化 Prefab avatar-prefab',
            expected: '实例已建立且源资产一致',
            actual: null,
            passed: false
          }]
        }
      }
    ];

    for (const [index, outcome] of outcomes.entries()) {
      const creatorClient = new RecordingCreatorClient(createRespond({ 'probe.directWrite': outcome }));
      const { client } = await createHarness(creatorClient, { enableWrites: true });

      const result = await client.callTool({
        name: 'cocos_prefab_instantiate',
        arguments: { projectId: 'proj1', prefabUuid: 'avatar-prefab', parentUuid: 'panel-uuid' }
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        index === 0 ? 'DIRECT_WRITE_OUTCOME_UNKNOWN' : 'DIRECT_WRITE_VERIFY_FAILED'
      );
    }
  });

  it('cocos_prefab_unpack 按 path 直写 complete 并返回重开后的节点身份', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': {
        kind: 'success',
        executedOps: 1,
        verification: {
          passed: true,
          verifiedAt: '2026-08-26T00:00:00.000Z',
          items: [{
            operationIndex: 0,
            description: '完全移除 Prefab 关联',
            expected: { mode: 'complete' },
            actual: {
              nodeUuid: 'panel-reloaded',
              stablePath: '/Root~0/Panel~0',
              prefabAssetUuid: null,
              subtreePreserved: true,
              componentsPreserved: true,
              allAssociationsRemoved: true
            },
            passed: true
          }]
        },
        evidence: [{
          operation: {
            type: 'prefab.unlink_instance',
            instanceRootUuid: 'panel-uuid',
            removeNested: true,
            expectedPrefabAssetUuid: 'panel-prefab',
            resultNodeStablePath: '/Root~0/Panel~0'
          }
        }]
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_unpack',
      arguments: {
        projectId: 'proj1',
        path: 'Root/Panel',
        mode: 'complete',
        expectedPrefabAssetUuid: 'panel-prefab'
      }
    });

    expect(result.structuredContent).toMatchObject({
      oldNodeUuid: 'panel-uuid',
      nodeUuid: 'panel-reloaded',
      uuidChanged: true,
      stablePath: '/Root~0/Panel~0',
      mode: 'complete',
      verification: { passed: true }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: unknown[]; save: boolean } };
    expect(payload.params).toEqual({
      operations: [{
        type: 'prefab.unlink_instance',
        instanceRootUuid: 'panel-uuid',
        removeNested: true,
        expectedPrefabAssetUuid: 'panel-prefab'
      }],
      save: true
    });
  });

  it('cocos_prefab_unpack 保留源 Prefab 身份锁错误', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': {
        kind: 'operation-failed',
        executedOps: 0,
        failure: {
          code: 'PREFAB_IDENTITY_MISMATCH',
          message: 'PREFAB_IDENTITY_MISMATCH',
          operationIndex: 0
        }
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_unpack',
      arguments: {
        projectId: 'proj1', nodeUuid: 'panel-uuid', mode: 'current',
        expectedPrefabAssetUuid: 'other-prefab'
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PREFAB_IDENTITY_MISMATCH');
  });

  it('cocos_node_delete 直写 node.delete', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>> } };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.operations).toEqual([{ type: 'node.delete', nodeUuid: 'panel-uuid' }]);
  });

  it('cocos_node_rename 按 path 直写 node.rename', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_rename',
      arguments: { projectId: 'proj1', path: 'Root/Panel', name: 'RenamedPanel' }
    });
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'success', executedOps: 1 }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as {
      params: { operations: Array<Record<string, unknown>>; save: boolean }
    };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.save).toBe(true);
    expect(payload.params.operations).toEqual([{
      type: 'node.rename',
      nodeUuid: 'panel-uuid',
      name: 'RenamedPanel'
    }]);
  });

  it('cocos_node_rename 严格要求 nodeUuid 或 path 二选一', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    for (const address of [
      {},
      { nodeUuid: 'panel-uuid', path: 'Root/Panel' }
    ]) {
      const result = await client.callTool({
        name: 'cocos_node_rename',
        arguments: { projectId: 'proj1', ...address, name: 'RenamedPanel' }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('NODE_ADDRESS_EXCLUSIVE');
    }
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('所有节点寻址入口都拒绝同时提供 UUID 和路径', async () => {
    const cases = [
      { name: 'cocos_node_read', arguments: { nodeUuid: 'panel-uuid', path: 'Root/Panel' } },
      { name: 'cocos_node_delete', arguments: { nodeUuid: 'panel-uuid', path: 'Root/Panel' } },
      {
        name: 'cocos_component_add',
        arguments: { nodeUuid: 'panel-uuid', path: 'Root/Panel', componentType: 'cc.Button' }
      },
      {
        name: 'cocos_component_set_property',
        arguments: {
          nodeUuid: 'panel-uuid', path: 'Root/Panel', componentType: 'cc.Label', propertyPath: 'string', value: 'x'
        }
      },
      {
        name: 'cocos_node_create',
        arguments: { parentUuid: 'root-uuid', parentPath: 'Root', name: 'Child' }
      },
      {
        name: 'cocos_prefab_instantiate',
        arguments: {
          prefabUuid: 'avatar-prefab', parentUuid: 'root-uuid', parentPath: 'Root', name: 'Avatar'
        }
      },
      {
        name: 'cocos_prefab_unpack',
        arguments: {
          nodeUuid: 'panel-uuid', path: 'Root/Panel', mode: 'current',
          expectedPrefabAssetUuid: 'panel-prefab'
        }
      },
      {
        name: 'cocos_prefab_create',
        arguments: {
          assetUrl: 'db://assets/ui/New.prefab', sourceNodeUuid: 'panel-uuid', sourcePath: 'Root/Panel'
        }
      }
    ];
    for (const testCase of cases) {
      const creatorClient = new RecordingCreatorClient(createRespond());
      const { client } = await createHarness(creatorClient, { enableWrites: true });
      const result = await client.callTool({
        name: testCase.name,
        arguments: { projectId: 'proj1', ...testCase.arguments }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('NODE_ADDRESS_EXCLUSIVE');
      expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
    }
  });

  it('cocos_node_set_transform 按 path 直写 node.set_transform', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    await client.callTool({
      name: 'cocos_node_set_transform',
      arguments: {
        projectId: 'proj1',
        path: 'Root/Panel',
        localTransform: { position: { x: 12, y: 34, z: 0 } }
      }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>> } };
    expect(payload.params.operations).toEqual([{
      type: 'node.set_transform',
      nodeUuid: 'panel-uuid',
      localTransform: { position: { x: 12, y: 34, z: 0 } }
    }]);
  });

  it('cocos_node_set_transform 严格要求 nodeUuid 或 path 二选一', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    for (const address of [
      {},
      { nodeUuid: 'panel-uuid', path: 'Root/Panel' }
    ]) {
      const result = await client.callTool({
        name: 'cocos_node_set_transform',
        arguments: {
          projectId: 'proj1',
          ...address,
          localTransform: { position: { x: 1, y: 2, z: 3 } }
        }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('NODE_ADDRESS_EXCLUSIVE');
    }
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('写入前适用性错误保持原错误码，不包装成 outcome 错误', async () => {
    const respond = createRespond();
    const creatorClient = new RecordingCreatorClient((method, payload) => {
      if (method === 'probe.directWrite') {
        throw new Error('NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT:db://assets/Nested.prefab');
      }
      return respond(method, payload);
    });
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_set_transform',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        localTransform: { position: { x: 1, y: 2, z: 3 } }
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT');
    expect(JSON.stringify(result.content)).not.toContain('DIRECT_WRITE_OUTCOME_INVALID');
  });

  it('cocos_node_select 按 path 选择唯一节点且不走保存写通道', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_select',
      arguments: { projectId: 'proj1', path: 'Root/Panel' }
    });

    expect(result.structuredContent).toMatchObject({
      nodeUuid: 'panel-uuid',
      selected: true,
      selection: ['panel-uuid']
    });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.nodeSelect',
      payload: { params: { uuid: 'panel-uuid' } }
    });
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_node_reparent 按 UUID 和 parentPath 直写 node.reparent', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_reparent',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        newParentPath: 'Root',
        siblingIndex: 2
      }
    });
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'success', executedOps: 1 }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>>; save: boolean } };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.save).toBe(true);
    expect(payload.params.operations).toEqual([{
      type: 'node.reparent',
      nodeUuid: 'panel-uuid',
      newParentUuid: 'root-uuid',
      siblingIndex: 2
    }]);
  });

  it('cocos_node_reparent 拒绝同一组中同时提供 UUID 和路径', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_reparent',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        path: 'Root/Panel',
        newParentUuid: 'root-uuid'
      }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('NODE_ADDRESS_EXCLUSIVE');
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_component_add 携带脚本 UUID 直写 component.add', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    await client.callTool({
      name: 'cocos_component_add',
      arguments: {
        projectId: 'proj1',
        path: 'Root/Panel',
        componentType: 'LobbyView',
        scriptUuid: 'script-uuid-9'
      }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>> } };
    expect(payload.params.operations).toEqual([{
      type: 'component.add',
      nodeUuid: 'panel-uuid',
      componentType: 'LobbyView',
      scriptUuid: 'script-uuid-9'
    }]);
  });

  it('cocos_component_set_property 解析组件后直写 component.set_property', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    await client.callTool({
      name: 'cocos_component_set_property',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        componentType: 'Label',
        propertyPath: 'string',
        value: '新标题',
        expectedOldValue: '旧标题'
      }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>> } };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.operations).toEqual([{
      type: 'component.set_property',
      componentUuid: 'label-comp-uuid',
      propertyPath: 'string',
      value: '新标题',
      expectedOldValue: '旧标题'
    }]);
  });

  it('直写操作级失败抛 DIRECT_WRITE_OPERATION_FAILED', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': {
        kind: 'operation-failed',
        executedOps: 0,
        failure: { code: 'WRITE_OPERATION_FAILED', message: 'WRITE_OPERATION_FAILED', operationIndex: 0 }
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_OPERATION_FAILED');
    expect(JSON.stringify(result.content)).toContain('executedOps');
    expect(JSON.stringify(result.content)).toContain('evidence');
  });

  it('直写 operation-failed 缺少 failure 时拒绝无效 Bridge 结果', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': { kind: 'operation-failed', executedOps: 1 }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_OUTCOME_INVALID:MISSING_FAILURE');
  });

  it('直写 unknown 结果保留证据并禁止按验证失败重试', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': {
        kind: 'unknown',
        executedOps: 1,
        failure: {
          code: 'DIRECT_WRITE_VERIFICATION_UNKNOWN',
          message: 'DIRECT_WRITE_VERIFICATION_UNKNOWN',
          operationIndex: null,
          stage: 'unknown'
        },
        evidence: [{ operation: { type: 'node.delete', nodeUuid: 'panel-uuid' } }]
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_OUTCOME_UNKNOWN');
    expect(JSON.stringify(result.content)).toContain('evidence');
  });

  it('直写重读不符抛 DIRECT_WRITE_VERIFY_FAILED', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': {
        kind: 'success',
        executedOps: 1,
        verification: {
          passed: false,
          verifiedAt: '2026-07-30T00:00:00.000Z',
          items: [{ operationIndex: 0, description: '属性写入', expected: '新标题', actual: '旧标题', passed: false }]
        }
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_component_set_property',
      arguments: {
        projectId: 'proj1',
        nodeUuid: 'panel-uuid',
        componentType: 'cc.Label',
        propertyPath: 'string',
        value: '新标题'
      }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_VERIFY_FAILED');
  });

  it('直写 success 但 verification=null 仍判定验证失败', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': { kind: 'success', executedOps: 1, verification: null }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_VERIFY_FAILED');
    expect(JSON.stringify(result.content)).toContain('verification');
  });

  it('直写 success 必须提供完整、有序且逐项通过的 verification', async () => {
    const passedItem = (operationIndex: number) => ({
      operationIndex,
      description: `operation-${operationIndex}`,
      expected: true,
      actual: true,
      passed: true
    });
    const operations = [
      { type: 'node.set_active' as const, nodeUuid: 'panel-uuid', active: true },
      { type: 'node.set_layer' as const, nodeUuid: 'panel-uuid', layer: 1 }
    ];
    const invalidOutcomes = [
      {
        kind: 'success',
        executedOps: 1,
        verification: { passed: true, verifiedAt: '2026-07-30T00:00:00.000Z', items: [passedItem(0), passedItem(1)] }
      },
      {
        kind: 'success',
        executedOps: 2,
        verification: { passed: true, verifiedAt: '2026-07-30T00:00:00.000Z', items: [passedItem(0)] }
      },
      {
        kind: 'success',
        executedOps: 2,
        verification: { passed: true, verifiedAt: '2026-07-30T00:00:00.000Z', items: [passedItem(0), passedItem(0)] }
      },
      {
        kind: 'success',
        executedOps: 2,
        verification: {
          passed: true,
          verifiedAt: '2026-07-30T00:00:00.000Z',
          items: [passedItem(0), { ...passedItem(1), passed: false }]
        }
      }
    ];

    for (const outcome of invalidOutcomes) {
      const creatorClient = new RecordingCreatorClient(createRespond({ 'probe.directWrite': outcome }));
      const { client } = await createHarness(creatorClient, { enableWrites: true });
      const result = await client.callTool({
        name: 'cocos_batch_write',
        arguments: { projectId: 'proj1', operations }
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_VERIFY_FAILED');
    }
  });

  it('cocos_batch_write 复用直写通道并原样转发协议操作', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': {
        kind: 'success',
        executedOps: 2,
        verification: {
          passed: true,
          verifiedAt: '2026-07-30T00:00:00.000Z',
          items: [
            { operationIndex: 0, description: 'active', expected: true, actual: true, passed: true },
            { operationIndex: 1, description: 'position', expected: 12, actual: 12, passed: true }
          ]
        }
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });
    const operations = [
      { type: 'node.set_active', nodeUuid: 'panel-uuid', active: true },
      { type: 'node.set_transform', nodeUuid: 'panel-uuid', localTransform: { position: { x: 12, y: 34, z: 0 } } }
    ];

    const result = await client.callTool({
      name: 'cocos_batch_write',
      arguments: { projectId: 'proj1', operations }
    });
    expect(result.structuredContent).toMatchObject({ outcome: { executedOps: 2 } });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: unknown[] } };
    expect(payload.params.operations).toEqual(operations);
  });

  it('cocos_batch_write 的公开 Schema 拒绝 asset.* 与 prefab.* 且不调用直写通道', async () => {
    for (const operation of [
      {
        type: 'asset.delete',
        assetUrl: 'db://assets/ui/icon.png',
        expectedAssetUuid: 'image-uuid-1'
      },
      {
        type: 'prefab.delete_asset',
        assetUrl: 'db://assets/ui/Test.prefab'
      }
    ]) {
      const creatorClient = new RecordingCreatorClient(createRespond());
      const { client } = await createHarness(creatorClient, { enableWrites: true });
      const result = await client.callTool({
        name: 'cocos_batch_write',
        arguments: { projectId: 'proj1', operations: [operation] }
      });

      expect(result.isError).toBe(true);
      expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
    }
  });

  it('cocos_batch_write 服务层仍以 allowlist 拒绝绕过公开 Schema 的危险操作', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const serviceOptions = { creatorClient };
    const readonlyService = new CocosReadonlyToolService(serviceOptions);
    const service = new CocosDirectToolService(readonlyService);

    for (const operation of [
      {
        type: 'asset.delete',
        assetUrl: 'db://assets/ui/icon.png',
        expectedAssetUuid: 'image-uuid-1'
      },
      {
        type: 'prefab.delete_asset',
        assetUrl: 'db://assets/ui/Test.prefab'
      }
    ]) {
      await expect(service.batchWrite({
        projectId: 'proj1',
        operations: [operation] as never
      })).rejects.toThrow('BATCH_WRITE_OPERATION_NOT_ALLOWED');
    }
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_prefab_create 复用直写链路并在重开后 dirty 时补保存', async () => {
    let savedAfterReload = false;
    const respond = createRespond({
      'probe.directWrite': PREFAB_CREATE_SUCCESS
    });
    const creatorClient = new RecordingCreatorClient((method, payload) => {
      if (method === 'probe.editorState') {
        return {
          ...EDITOR_STATE,
          document: { assetUuid: 'prefab-uuid-1', dirty: !savedAfterReload }
        };
      }
      if (method === 'probe.saveDocument') {
        savedAfterReload = true;
        return { saved: true };
      }
      return respond(method, payload);
    });
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'proj1',
        assetUrl: 'db://assets/ui/New.prefab',
        sourcePath: 'Root/Panel'
      }
    });

    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'success', verification: { passed: true } },
      result: {
        created: true,
        assetUuid: 'new-prefab-uuid',
        assetUrl: 'db://assets/ui/New.prefab',
        nodeUuid: 'rebuilt-node-uuid'
      },
      state: { document: { dirty: false } }
    });
    expect(creatorClient.requests).toContainEqual({
      method: 'probe.directWrite',
      payload: {
        selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' },
        params: {
          operations: [{
            type: 'prefab.create_from_node',
            nodeUuid: 'panel-uuid',
            assetUrl: 'db://assets/ui/New.prefab'
          }],
          save: true
        }
      }
    });
    const methods = creatorClient.requests.map((request) => request.method);
    expect(methods).toContain('probe.saveDocument');
    expect(methods.at(-1)).toBe('probe.editorState');
  });

  it('cocos_prefab_create 在创建后 dirty 未清除时返回稳定错误', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.directWrite': PREFAB_CREATE_SUCCESS,
      'probe.editorState': {
        ...EDITOR_STATE,
        document: { assetUuid: 'prefab-uuid-1', dirty: true }
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'proj1',
        assetUrl: 'db://assets/ui/New.prefab',
        sourceNodeUuid: 'panel-uuid'
      }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'DOCUMENT_DIRTY_AFTER_PREFAB_CREATE',
        details: {
          sourceNodeUuid: 'panel-uuid',
          assetUrl: 'db://assets/ui/New.prefab'
        },
        nextAction: expect.stringContaining('cocos_document_save')
      }
    });
    expect(creatorClient.requests.map((request) => request.method)).toContain('probe.saveDocument');
  });

  it('cocos_prefab_create 拒绝缺失资产或重建节点身份的成功证据', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'proj1',
        assetUrl: 'db://assets/ui/New.prefab',
        sourceNodeUuid: 'panel-uuid'
      }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'PREFAB_CREATE_RESULT_INVALID' }
    });
  });

  it('cocos_prefab_create 拒绝非 prefab 后缀的 URL', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: { projectId: 'proj1', assetUrl: 'db://assets/ui/New.png', sourceNodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ASSET_URL_TYPE_INVALID');
  });

  it('cocos_prefab_rename 按 UUID 在同目录内直写 asset.move 并保持 UUID', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_rename',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1', newName: 'RenamedPrefab' }
    });
    expect(result.structuredContent).toMatchObject({
      assetUuid: 'prefab-uuid-1',
      sourceUrl: 'db://assets/ui/Test.prefab',
      targetUrl: 'db://assets/ui/RenamedPrefab.prefab',
      outcome: { kind: 'success', executedOps: 1 }
    });
    const write = creatorClient.requests.at(-1);
    const payload = write?.payload as {
      params: { operations: Array<Record<string, unknown>>; save: boolean }
    };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.save).toBe(true);
    expect(payload.params.operations).toEqual([{
      type: 'asset.move',
      sourceUrl: 'db://assets/ui/Test.prefab',
      targetUrl: 'db://assets/ui/RenamedPrefab.prefab',
      expectedAssetUuid: 'prefab-uuid-1'
    }]);
  });

  it('cocos_prefab_rename 拒绝非 Prefab 资产和路径型名称', async () => {
    const nonPrefabProbe = new RecordingCreatorClient(createRespond({
      'probe.assets': {
        ...INSPECT_ASSET_RESPONSE,
        details: { ...INSPECT_ASSET_RESPONSE.details, type: 'cc.ImageAsset' }
      }
    }));
    const { client: nonPrefabClient } = await createHarness(nonPrefabProbe, { enableWrites: true });
    const nonPrefab = await nonPrefabClient.callTool({
      name: 'cocos_prefab_rename',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1', newName: 'RenamedPrefab' }
    });
    expect(nonPrefab.isError).toBe(true);
    expect(JSON.stringify(nonPrefab.content)).toContain('ASSET_NOT_PREFAB');
    expect(nonPrefabProbe.requests.map((request) => request.method)).not.toContain('probe.directWrite');

    const invalidNameProbe = new RecordingCreatorClient(createRespond());
    const { client: invalidNameClient } = await createHarness(invalidNameProbe, { enableWrites: true });
    const invalidName = await invalidNameClient.callTool({
      name: 'cocos_prefab_rename',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1', newName: '../RenamedPrefab' }
    });
    expect(invalidName.isError).toBe(true);
    expect(JSON.stringify(invalidName.content)).toContain('PREFAB_NAME_INVALID');
    expect(invalidNameProbe.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_prefab_delete 缺少精确 URL 确认时拒绝删除', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PREFAB_DELETE_CONFIRMATION_REQUIRED');
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.deleteAsset');
  });

  it('cocos_prefab_delete 有引用但未显式确认时拒绝删除', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.assets': { ...INSPECT_ASSET_RESPONSE, users: ['scene-uuid-1'] }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: {
        projectId: 'proj1',
        uuid: 'prefab-uuid-1',
        confirmAssetUrl: 'db://assets/ui/Test.prefab'
      }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PREFAB_REFERENCES_CONFIRMATION_REQUIRED');
    expect(JSON.stringify(result.content)).toContain('scene-uuid-1');
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.deleteAsset');
  });

  it('cocos_prefab_delete 引用查询不可用时默认拒绝删除', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.assets': {
        ...INSPECT_ASSET_RESPONSE,
        users: null,
        unresolved: [{ path: 'query-asset-users', reason: 'MESSAGE_API_UNAVAILABLE' }]
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: {
        projectId: 'proj1',
        uuid: 'prefab-uuid-1',
        confirmAssetUrl: 'db://assets/ui/Test.prefab'
      }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PREFAB_REFERENCES_UNRESOLVED');
    expect(creatorClient.requests.map((request) => request.method)).not.toContain('probe.deleteAsset');
  });

  it('cocos_prefab_delete 精确确认无引用目标后删除并返回验证结果', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: {
        projectId: 'proj1',
        uuid: 'prefab-uuid-1',
        confirmAssetUrl: 'db://assets/ui/Test.prefab'
      }
    });
    expect(result.structuredContent).toMatchObject({
      assetUrl: 'db://assets/ui/Test.prefab',
      references: { users: [], dependencies: [] },
      result: { deleted: true, verified: true }
    });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.deleteAsset',
      payload: {
        selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' },
        params: { assetUrl: 'db://assets/ui/Test.prefab' }
      }
    });
  });

  it('cocos_prefab_delete 引用确认后允许删除', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.assets': { ...INSPECT_ASSET_RESPONSE, users: ['scene-uuid-1'] }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: {
        projectId: 'proj1',
        uuid: 'prefab-uuid-1',
        confirmAssetUrl: 'db://assets/ui/Test.prefab',
        confirmReferenced: true
      }
    });
    expect(result.structuredContent).toMatchObject({ references: { users: ['scene-uuid-1'] } });
    expect(creatorClient.requests.at(-1)?.method).toBe('probe.deleteAsset');
  });

  it('cocos_document_save 保存后重读确认 dirty 已清除', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_document_save',
      arguments: { projectId: 'proj1' }
    });
    expect(result.structuredContent).toMatchObject({
      result: { saved: true },
      state: { document: { assetUuid: 'prefab-uuid-1', dirty: false } }
    });
    const methods = creatorClient.requests.map((request) => request.method);
    expect(methods.indexOf('probe.saveDocument')).toBeLessThan(methods.lastIndexOf('probe.editorState'));
    expect(creatorClient.requests.at(-1)?.method).toBe('probe.editorState');
  });

  it('cocos_document_save 在 dirty 未清除时返回稳定错误', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond({
      'probe.editorState': {
        ...EDITOR_STATE,
        document: { assetUuid: 'prefab-uuid-1', dirty: true }
      }
    }));
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_document_save',
      arguments: { projectId: 'proj1' }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'DOCUMENT_DIRTY_AFTER_SAVE',
        details: { currentDocumentUuid: 'prefab-uuid-1' }
      }
    });
  });

  it('cocos_asset_import 校验 URL 并转发 probe.importAsset', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_asset_import',
      arguments: {
        projectId: 'proj1',
        sourceFilePath: 'E:/downloads/icon.png',
        assetUrl: 'db://assets/ui/icon.png'
      }
    });
    expect(result.structuredContent).toMatchObject({ result: { uuid: 'imported-uuid' } });
    expect(creatorClient.requests.at(-1)).toMatchObject({
      method: 'probe.importAsset',
      payload: {
        selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' },
        params: { sourceFilePath: 'E:/downloads/icon.png', assetUrl: 'db://assets/ui/icon.png' }
      }
    });

    const invalid = await client.callTool({
      name: 'cocos_asset_import',
      arguments: { projectId: 'proj1', sourceFilePath: 'E:/a.png', assetUrl: 'http://x/a.png' }
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain('ASSET_URL_INVALID');
  });

  it('cocos_asset_refresh 转发 probe.refreshAsset', async () => {
    const creatorClient = new RecordingCreatorClient(createRespond());
    const { client } = await createHarness(creatorClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_asset_refresh',
      arguments: { projectId: 'proj1', assetUrl: 'db://assets/script/A.ts' }
    });
    expect(result.structuredContent).toMatchObject({ result: { refreshed: true, compileTriggered: true } });
    expect(creatorClient.requests.at(-1)?.method).toBe('probe.refreshAsset');
  });
});
