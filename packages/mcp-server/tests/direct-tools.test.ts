import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCocosMcpServer } from '../src/server.js';
import { COCOS_DIRECT_WRITE_TOOL_NAMES, CocosDirectToolService } from '../src/direct-tools.js';
import { CocosReadonlyToolService, type ReadonlyProbeClient } from '../src/tools.js';

interface ProbeRequest {
  method: string;
  payload: unknown;
}

class RecordingProbeClient implements ReadonlyProbeClient {
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
  bridgeVersion: '0.3.0',
  capabilities: [
    'probe.editorState',
    'probe.assetIndex',
    'probe.assets',
    'probe.openAsset',
    'probe.hierarchy',
    'probe.node',
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

function createRespond(overrides: Record<string, unknown> = {}) {
  return (method: string): unknown => {
    if (method === 'server.editors') return [ONLINE_EDITOR];
    if (method in overrides) return overrides[method];
    if (method === 'probe.assetIndex') {
      return { assets: [PREFAB_ASSET], scripts: [], documents: [], unresolved: [] };
    }
    if (method === 'probe.editorState') return EDITOR_STATE;
    if (method === 'probe.openAsset') return { opened: true, uuid: 'prefab-uuid-1' };
    if (method === 'probe.hierarchy') return { data: HIERARCHY_TREE, raw: null, source: 'message-api' };
    if (method === 'probe.node') return { data: NODE_DETAIL, raw: null, source: 'message-api' };
    if (method === 'probe.component') {
      return { data: { schema: COMPONENT_SCHEMA, raw: null }, raw: null, source: 'message-api' };
    }
    if (method === 'probe.assets') return INSPECT_ASSET_RESPONSE;
    if (method === 'probe.directWrite') return DIRECT_WRITE_SUCCESS;
    if (method === 'probe.createPrefab') return { created: true, assetUuid: 'new-prefab-uuid' };
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
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHarness(
  probeClient: ReadonlyProbeClient,
  options: { enableWrites?: boolean } = {}
) {
  const reportRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-mcp-direct-'));
  temporaryRoots.push(reportRoot);
  const server = createCocosMcpServer(
    { probeClient, reportRoot },
    { enableWrites: options.enableWrites }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'direct-test-client', version: '0.1.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  harnesses.push({ server, client });
  return { client };
}

describe('直写档工具注册', () => {
  it('默认注册 5 个只读直写工具，写工具仅 enableWrites 时注册', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const readonlyTools = (await client.listTools()).tools;
    const names = readonlyTools.map((tool) => tool.name);
    for (const expected of [
      'cocos_editor_list',
      'cocos_asset_search',
      'cocos_hierarchy',
      'cocos_node_read',
      'cocos_prefab_open'
    ]) {
      expect(names).toContain(expected);
    }
    for (const gated of [
      'cocos_node_create',
      'cocos_node_rename',
      'cocos_node_set_transform',
      'cocos_node_delete',
      'cocos_node_reparent',
      'cocos_component_add',
      'cocos_component_set_property',
      'cocos_prefab_create',
      'cocos_prefab_rename',
      'cocos_prefab_save',
      'cocos_prefab_delete',
      'cocos_asset_import',
      'cocos_asset_refresh',
      'cocos_batch_write'
    ]) {
      expect(names).not.toContain(gated);
    }
    // 事务/声明式/全量扫描工具一律不再存在
    for (const removed of [
      'cocos_write_prepare',
      'cocos_write_confirm',
      'cocos_transaction_rollback',
      'cocos_design_apply',
      'cocos_prefab_edit',
      'cocos_project_scan',
      'cocos_prefab_graph',
      'cocos_document_snapshot',
      'cocos_asset_create',
      'cocos_asset_update_text'
    ]) {
      expect(names).not.toContain(removed);
    }
    const hierarchyTool = readonlyTools.find((tool) => tool.name === 'cocos_hierarchy');
    const nodeReadTool = readonlyTools.find((tool) => tool.name === 'cocos_node_read');
    expect(hierarchyTool?.description).toContain('结构/信封层重复 raw');
    expect(hierarchyTool?.description).toContain('Inspector 业务值内部的 raw');
    expect(nodeReadTool?.description).toContain('结构/信封层重复 raw');
    expect(nodeReadTool?.description).toContain('Inspector 业务值内部的 raw');

    const { client: writeClient } = await createHarness(probeClient, { enableWrites: true });
    const writeTools = (await writeClient.listTools()).tools;
    const writeNames = writeTools.map((tool) => tool.name);
    for (const gated of [
      'cocos_node_create',
      'cocos_node_rename',
      'cocos_node_set_transform',
      'cocos_node_delete',
      'cocos_node_reparent',
      'cocos_component_add',
      'cocos_component_set_property',
      'cocos_prefab_create',
      'cocos_prefab_rename',
      'cocos_prefab_save',
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
  });
});

describe('直写档只读工具', () => {
  it('cocos_editor_list 返回已连接编辑器', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({ name: 'cocos_editor_list', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      editors: [{ projectId: 'proj1', editorInstanceId: 'proj1:1234' }]
    });
  });

  it('cocos_prefab_open 打开资产并轮询文档身份就绪', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_prefab_open',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.structuredContent).toMatchObject({ opened: true });
    const methods = probeClient.requests.map((request) => request.method);
    expect(methods).toContain('probe.openAsset');
    expect(methods).toContain('probe.editorState');
  });

  it('cocos_prefab_open 对非 Prefab 资产拒绝', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.assetIndex': {
        assets: [{ ...PREFAB_ASSET, type: 'cc.ImageAsset' }],
        scripts: [],
        documents: [],
        unresolved: []
      }
    }));
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_prefab_open',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ASSET_NOT_PREFAB');
  });

  it('cocos_hierarchy 转发层级请求', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', depth: 6 }
    });
    expect(result.structuredContent).toMatchObject({ hierarchy: { data: { name: 'Root' } } });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'probe.hierarchy',
      payload: { selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' }, params: { depth: 6 } }
    });
    expect(JSON.stringify(result.structuredContent)).toContain('raw');
  });

  it('cocos_hierarchy 的紧凑参数按子树和查询投影并移除所有 raw', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

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
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'probe.hierarchy',
      payload: { params: { depth: 50 } }
    });
  });

  it('cocos_hierarchy summary=false 保持完整旧返回', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', summary: false }
    });
    expect(result.structuredContent).toMatchObject({ hierarchy: { data: { name: 'Root' } } });
    expect(JSON.stringify(result.structuredContent)).toContain('"raw"');
  });

  it('cocos_hierarchy summary-only 不重复返回节点树', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_hierarchy',
      arguments: { projectId: 'proj1', summary: true }
    });
    expect(result.structuredContent).toMatchObject({
      hierarchy: { summary: { totalNodeCount: 2, scopedNodeCount: 2 } }
    });
    expect((result.structuredContent as { hierarchy: Record<string, unknown> }).hierarchy).not.toHaveProperty('nodes');
  });

  it('cocos_node_read 提供 componentType 时返回组件完整属性', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', componentType: 'cc.Label' }
    });
    expect(result.structuredContent).toMatchObject({
      nodeUuid: 'panel-uuid',
      componentUuid: 'label-comp-uuid',
      component: { className: 'cc.Label' }
    });
  });

  it('cocos_node_read 组件类型未命中时给出可用清单', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_node_read',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid', componentType: 'cc.Button' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('COMPONENT_NOT_FOUND');
    expect(JSON.stringify(result.content)).toContain('cc.Label');
  });

  it('cocos_node_read propertyPaths 只返回指定组件属性并移除 raw', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.component': { data: { schema: COMPONENT_SCHEMA_WITH_PROPERTIES, raw: { duplicate: true } }, raw: { envelope: true }, source: 'message-api' }
    }));
    const { client } = await createHarness(probeClient);

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
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.component': { data: { schema, raw: { duplicate: true } }, raw: { envelope: true }, source: 'message-api' }
    }));
    const { client } = await createHarness(probeClient);

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
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

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
      const probeClient = new RecordingProbeClient(createRespond());
      const { client } = await createHarness(probeClient);
      const result = await client.callTool(testCase);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('FIELD_PATH_FORBIDDEN');
      expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.hierarchy');
    }

    expect(Object.prototype.toString).toBe(beforeToString);
    expect(Object.prototype.constructor).toBe(beforeConstructor);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('cocos_node_read 对缺失 propertyPath 返回可用路径', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.component': { data: { schema: COMPONENT_SCHEMA_WITH_PROPERTIES, raw: null }, raw: null, source: 'message-api' }
    }));
    const { client } = await createHarness(probeClient);

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
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient);

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
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_create',
      arguments: { projectId: 'proj1', parentPath: 'Root/Panel', name: 'NewChild' }
    });
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'success', executedOps: 1 }
    });
    const write = probeClient.requests.at(-1);
    expect(write?.method).toBe('probe.directWrite');
    const payload = write?.payload as {
      params: { operations: Array<Record<string, unknown>>; save: boolean; undoGroup: string }
    };
    expect(payload.params.save).toBe(true);
    expect(payload.params.undoGroup).toContain('node-create');
    expect(payload.params.operations).toEqual([{
      type: 'node.create',
      parentNodeUuid: 'panel-uuid',
      name: 'NewChild'
    }]);
  });

  it('cocos_node_create 路径未命中时报 NODE_NOT_FOUND', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_create',
      arguments: { projectId: 'proj1', parentPath: 'Root/Nope', name: 'X' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('NODE_NOT_FOUND');
  });

  it('cocos_node_delete 直写 node.delete', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    const write = probeClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>> } };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.operations).toEqual([{ type: 'node.delete', nodeUuid: 'panel-uuid' }]);
  });

  it('cocos_node_rename 按 path 直写 node.rename', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_rename',
      arguments: { projectId: 'proj1', path: 'Root/Panel', name: 'RenamedPanel' }
    });
    expect(result.structuredContent).toMatchObject({
      outcome: { kind: 'success', executedOps: 1 }
    });
    const write = probeClient.requests.at(-1);
    const payload = write?.payload as {
      params: { operations: Array<Record<string, unknown>>; save: boolean; undoGroup: string }
    };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.save).toBe(true);
    expect(payload.params.undoGroup).toContain('node-rename');
    expect(payload.params.operations).toEqual([{
      type: 'node.rename',
      nodeUuid: 'panel-uuid',
      name: 'RenamedPanel'
    }]);
  });

  it('cocos_node_rename 严格要求 nodeUuid 或 path 二选一', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_node_set_transform 按 path 直写 node.set_transform', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    await client.callTool({
      name: 'cocos_node_set_transform',
      arguments: {
        projectId: 'proj1',
        path: 'Root/Panel',
        localTransform: { position: { x: 12, y: 34, z: 0 } }
      }
    });
    const write = probeClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>> } };
    expect(payload.params.operations).toEqual([{
      type: 'node.set_transform',
      nodeUuid: 'panel-uuid',
      localTransform: { position: { x: 12, y: 34, z: 0 } }
    }]);
  });

  it('cocos_node_set_transform 严格要求 nodeUuid 或 path 二选一', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_node_reparent 按 UUID 和 parentPath 直写 node.reparent', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    const write = probeClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>>; save: boolean; undoGroup: string } };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.save).toBe(true);
    expect(payload.params.undoGroup).toContain('node-reparent');
    expect(payload.params.operations).toEqual([{
      type: 'node.reparent',
      nodeUuid: 'panel-uuid',
      newParentUuid: 'root-uuid',
      siblingIndex: 2
    }]);
  });

  it('cocos_node_reparent 拒绝同一组中同时提供 UUID 和路径', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_component_add 携带脚本 UUID 直写 component.add', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    await client.callTool({
      name: 'cocos_component_add',
      arguments: {
        projectId: 'proj1',
        path: 'Root/Panel',
        componentType: 'LobbyView',
        scriptUuid: 'script-uuid-9'
      }
    });
    const write = probeClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: Array<Record<string, unknown>> } };
    expect(payload.params.operations).toEqual([{
      type: 'component.add',
      nodeUuid: 'panel-uuid',
      componentType: 'LobbyView',
      scriptUuid: 'script-uuid-9'
    }]);
  });

  it('cocos_component_set_property 解析组件后直写 component.set_property', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    const write = probeClient.requests.at(-1);
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
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.directWrite': {
        kind: 'operation-failed',
        executedOps: 0,
        failure: { code: 'WRITE_OPERATION_FAILED', message: 'WRITE_OPERATION_FAILED', operationIndex: 0 }
      }
    }));
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.directWrite': { kind: 'operation-failed', executedOps: 1 }
    }));
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_OUTCOME_INVALID:MISSING_FAILURE');
  });

  it('直写 unknown 结果保留证据并禁止按验证失败重试', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
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
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_node_delete',
      arguments: { projectId: 'proj1', nodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_OUTCOME_UNKNOWN');
    expect(JSON.stringify(result.content)).toContain('evidence');
  });

  it('直写重读不符抛 DIRECT_WRITE_VERIFY_FAILED', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
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
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.directWrite': { kind: 'success', executedOps: 1, verification: null }
    }));
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
      const probeClient = new RecordingProbeClient(createRespond({ 'probe.directWrite': outcome }));
      const { client } = await createHarness(probeClient, { enableWrites: true });
      const result = await client.callTool({
        name: 'cocos_batch_write',
        arguments: { projectId: 'proj1', operations }
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('DIRECT_WRITE_VERIFY_FAILED');
    }
  });

  it('cocos_batch_write 复用直写通道并原样转发协议操作', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
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
    const { client } = await createHarness(probeClient, { enableWrites: true });
    const operations = [
      { type: 'node.set_active', nodeUuid: 'panel-uuid', active: true },
      { type: 'node.set_transform', nodeUuid: 'panel-uuid', localTransform: { position: { x: 12, y: 34, z: 0 } } }
    ];

    const result = await client.callTool({
      name: 'cocos_batch_write',
      arguments: { projectId: 'proj1', operations }
    });
    expect(result.structuredContent).toMatchObject({ outcome: { executedOps: 2 } });
    const write = probeClient.requests.at(-1);
    const payload = write?.payload as { params: { operations: unknown[]; undoGroup: string } };
    expect(payload.params.operations).toEqual(operations);
    expect(payload.params.undoGroup).toContain('batch-write');
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
      const probeClient = new RecordingProbeClient(createRespond());
      const { client } = await createHarness(probeClient, { enableWrites: true });
      const result = await client.callTool({
        name: 'cocos_batch_write',
        arguments: { projectId: 'proj1', operations: [operation] }
      });

      expect(result.isError).toBe(true);
      expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
    }
  });

  it('cocos_batch_write 服务层仍以 allowlist 拒绝绕过公开 Schema 的危险操作', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const reportRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-mcp-batch-allowlist-'));
    temporaryRoots.push(reportRoot);
    const serviceOptions = { probeClient, reportRoot };
    const readonlyService = new CocosReadonlyToolService(serviceOptions);
    const service = new CocosDirectToolService(serviceOptions, readonlyService);

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
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.directWrite');
  });

  it('cocos_prefab_create 转发 probe.createPrefab', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: {
        projectId: 'proj1',
        assetUrl: 'db://assets/ui/New.prefab',
        sourcePath: 'Root/Panel'
      }
    });
    expect(result.structuredContent).toMatchObject({ result: { created: true } });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'probe.createPrefab',
      payload: {
        selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' },
        params: { nodeUuid: 'panel-uuid', assetUrl: 'db://assets/ui/New.prefab' }
      }
    });
  });

  it('cocos_prefab_create 拒绝非 prefab 后缀的 URL', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_create',
      arguments: { projectId: 'proj1', assetUrl: 'db://assets/ui/New.png', sourceNodeUuid: 'panel-uuid' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ASSET_URL_TYPE_INVALID');
  });

  it('cocos_prefab_rename 按 UUID 在同目录内直写 asset.move 并保持 UUID', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    const write = probeClient.requests.at(-1);
    const payload = write?.payload as {
      params: { operations: Array<Record<string, unknown>>; save: boolean; undoGroup: string }
    };
    expect(write?.method).toBe('probe.directWrite');
    expect(payload.params.save).toBe(true);
    expect(payload.params.undoGroup).toContain('prefab-rename');
    expect(payload.params.operations).toEqual([{
      type: 'asset.move',
      sourceUrl: 'db://assets/ui/Test.prefab',
      targetUrl: 'db://assets/ui/RenamedPrefab.prefab',
      expectedAssetUuid: 'prefab-uuid-1'
    }]);
  });

  it('cocos_prefab_rename 拒绝非 Prefab 资产和路径型名称', async () => {
    const nonPrefabProbe = new RecordingProbeClient(createRespond({
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

    const invalidNameProbe = new RecordingProbeClient(createRespond());
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
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('PREFAB_DELETE_CONFIRMATION_REQUIRED');
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.deleteAsset');
  });

  it('cocos_prefab_delete 有引用但未显式确认时拒绝删除', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.assets': { ...INSPECT_ASSET_RESPONSE, users: ['scene-uuid-1'] }
    }));
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.deleteAsset');
  });

  it('cocos_prefab_delete 引用查询不可用时默认拒绝删除', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.assets': {
        ...INSPECT_ASSET_RESPONSE,
        users: null,
        unresolved: [{ path: 'query-asset-users', reason: 'MESSAGE_API_UNAVAILABLE' }]
      }
    }));
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.deleteAsset');
  });

  it('cocos_prefab_delete 精确确认无引用目标后删除并返回验证结果', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'probe.deleteAsset',
      payload: {
        selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' },
        params: { assetUrl: 'db://assets/ui/Test.prefab' }
      }
    });
  });

  it('cocos_prefab_delete 引用确认后允许删除', async () => {
    const probeClient = new RecordingProbeClient(createRespond({
      'probe.assets': { ...INSPECT_ASSET_RESPONSE, users: ['scene-uuid-1'] }
    }));
    const { client } = await createHarness(probeClient, { enableWrites: true });

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
    expect(probeClient.requests.at(-1)?.method).toBe('probe.deleteAsset');
  });

  it('cocos_prefab_save 转发 probe.saveDocument', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_save',
      arguments: { projectId: 'proj1' }
    });
    expect(result.structuredContent).toMatchObject({ result: { saved: true } });
    expect(probeClient.requests.at(-1)?.method).toBe('probe.saveDocument');
  });

  it('cocos_asset_import 校验 URL 并转发 probe.importAsset', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_asset_import',
      arguments: {
        projectId: 'proj1',
        sourceFilePath: 'E:/downloads/icon.png',
        assetUrl: 'db://assets/ui/icon.png'
      }
    });
    expect(result.structuredContent).toMatchObject({ result: { uuid: 'imported-uuid' } });
    expect(probeClient.requests.at(-1)).toMatchObject({
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
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_asset_refresh',
      arguments: { projectId: 'proj1', assetUrl: 'db://assets/script/A.ts' }
    });
    expect(result.structuredContent).toMatchObject({ result: { refreshed: true, compileTriggered: true } });
    expect(probeClient.requests.at(-1)?.method).toBe('probe.refreshAsset');
  });
});
