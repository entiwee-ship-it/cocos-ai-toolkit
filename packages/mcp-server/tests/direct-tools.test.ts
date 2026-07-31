import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCocosMcpServer } from '../src/server.js';
import type { ReadonlyProbeClient } from '../src/tools.js';

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
    if (method === 'probe.deleteAsset') return { deleted: true, assetUrl: 'db://assets/ui/Test.prefab' };
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

    const names = (await client.listTools()).tools.map((tool) => tool.name);
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
      'cocos_node_delete',
      'cocos_node_reparent',
      'cocos_component_add',
      'cocos_component_set_property',
      'cocos_prefab_create',
      'cocos_prefab_save',
      'cocos_prefab_delete',
      'cocos_asset_import',
      'cocos_asset_refresh'
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

    const { client: writeClient } = await createHarness(probeClient, { enableWrites: true });
    const writeNames = (await writeClient.listTools()).tools.map((tool) => tool.name);
    for (const gated of [
      'cocos_node_create',
      'cocos_node_delete',
      'cocos_node_reparent',
      'cocos_component_add',
      'cocos_component_set_property',
      'cocos_prefab_create',
      'cocos_prefab_save',
      'cocos_prefab_delete',
      'cocos_asset_import',
      'cocos_asset_refresh'
    ]) {
      expect(writeNames).toContain(gated);
    }
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

  it('cocos_prefab_delete 查 URL 后转发 probe.deleteAsset', async () => {
    const probeClient = new RecordingProbeClient(createRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_prefab_delete',
      arguments: { projectId: 'proj1', uuid: 'prefab-uuid-1' }
    });
    expect(result.structuredContent).toMatchObject({
      assetUrl: 'db://assets/ui/Test.prefab',
      result: { deleted: true }
    });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'probe.deleteAsset',
      payload: {
        selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' },
        params: { assetUrl: 'db://assets/ui/Test.prefab' }
      }
    });
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
