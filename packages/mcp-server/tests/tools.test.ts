import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadonlyProbeClient } from '@cocos-ai/core';
import { ProjectScanReportManifestSchema } from '@cocos-ai/protocol';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COCOS_READONLY_TOOL_NAMES,
  COCOS_GATED_READONLY_TOOL_NAMES,
  COCOS_WRITE_TOOL_NAMES,
  createCocosMcpServer
} from '../src/server.js';

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

interface McpHarness {
  server: McpServer;
  client: Client;
}

const harnesses: McpHarness[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true
  })));
});

describe('Cocos readonly MCP tools', () => {
  it('只注册基础只读工具和三个声明式只读工具，并把 editor_list 作为唯一的全局发现入口', async () => {
    const probeClient = new RecordingProbeClient(() => []);
    const { client } = await createHarness(probeClient);

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(COCOS_READONLY_TOOL_NAMES);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(result.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);

    const requiredByTool = new Map(result.tools.map((tool) => [
      tool.name,
      tool.inputSchema.required ?? []
    ]));
    expect(requiredByTool).toEqual(new Map([
      ['cocos_editor_list', []],
      ['cocos_editor_state', ['projectId']],
      ['cocos_asset_search', ['projectId', 'pattern']],
      ['cocos_asset_inspect', ['projectId', 'uuid']],
      ['cocos_component_schema', ['projectId', 'uuid']],
      ['cocos_document_snapshot', ['projectId', 'mode', 'pageSize']],
      ['cocos_prefab_graph', ['projectId']],
      ['cocos_project_scan', ['projectId']],
      ['cocos_design_inspect', ['projectId']],
      ['cocos_design_plan', ['projectId', 'target']],
      ['cocos_design_preview', ['projectId', 'target']],
      ['cocos_preview_sessions', []],
      ['cocos_runtime_get_hierarchy', ['sessionId']],
      ['cocos_runtime_inspect_component', ['sessionId', 'path', 'componentType']],
      ['cocos_runtime_get_console', ['sessionId']],
      ['cocos_runtime_watch_property', ['sessionId', 'path', 'componentType', 'property']],
      ['cocos_runtime_capture', ['sessionId']]
    ]));
    expect(result.tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true);
    const projectScanSchema = result.tools.find((tool) =>
      tool.name === 'cocos_project_scan'
    )?.outputSchema;
    expect(projectScanSchema?.required).toEqual(expect.arrayContaining([
      'editor',
      'scanId',
      'status',
      'reportPath',
      'checkpointPath',
      'summary',
      'page'
    ]));
  });

  it('同一项目存在多个实例时拒绝隐式选择，并且不转发状态查询', async () => {
    const sessions = [
      createEditorSession('editor-a'),
      createEditorSession('editor-b')
    ];
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return sessions;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_editor_state',
      arguments: { projectId: 'project-a' }
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: 'MULTIPLE_EDITOR_INSTANCES'
    }));
    expect(probeClient.requests).toEqual([
      { method: 'server.editors', payload: {} }
    ]);
  });

  it('除 editor_list 外拒绝尚未认证的 Creator 小版本', async () => {
    const unsupported = {
      ...createEditorSession('editor-a'),
      creatorVersion: '3.8.7'
    };
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [unsupported];
      if (method === 'probe.editorState') {
        return { ...createEditorState(), creatorVersion: '3.8.7' };
      }
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const editors = await client.callTool({ name: 'cocos_editor_list', arguments: {} });
    expect(editors.isError).not.toBe(true);
    expect(editors.structuredContent).toEqual({ editors: [unsupported] });

    const state = await client.callTool({
      name: 'cocos_editor_state',
      arguments: { projectId: 'project-a' }
    });
    expect(state.isError).toBe(true);
    expect((state.content as Array<{ text?: string }>)[0]?.text).toContain(
      'UNSUPPORTED_CREATOR_VERSION:3.8.7'
    );
    expect(probeClient.requests.filter((request) =>
      request.method === 'probe.editorState'
    )).toEqual([]);
  });

  it('editor_list 通过真实 MCP 调用返回经过结构校验的编辑器会话', async () => {
    const sessions = [createEditorSession('editor-a')];
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return sessions;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_editor_list',
      arguments: {}
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ editors: sessions });
  });

  it('editor_state 返回经过结构校验且绑定当前会话身份的状态', async () => {
    const session = createEditorSession('editor-a');
    const state = createEditorState();
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [session];
      if (method === 'probe.editorState') return state;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_editor_state',
      arguments: { projectId: 'project-a' }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ editor: session, state });
  });

  it('editor_state 在文档身份未解析时保留 unresolved 证据而不伪造 assetUuid', async () => {
    const session = createEditorSession('editor-a');
    const state = {
      ...createEditorState(),
      document: { assetUuid: null, dirty: false },
      unresolved: [
        { path: 'document.assetUuid', reason: 'CURRENT_DOCUMENT_UUID_EMPTY' }
      ]
    };
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [session];
      if (method === 'probe.editorState') return state;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_editor_state',
      arguments: { projectId: 'project-a' }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ editor: session, state });
  });

  it('editor_state 拒绝 Bridge 返回其它项目或版本的状态', async () => {
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.editorState') {
        return { ...createEditorState(), projectId: 'project-b' };
      }
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_editor_state',
      arguments: { projectId: 'project-a' }
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: 'EDITOR_STATE_IDENTITY_MISMATCH'
    }));
  });

  it('editor_state 把畸形 Bridge 响应转换为稳定协议错误', async () => {
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.editorState') return { ready: true };
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_editor_state',
      arguments: { projectId: 'project-a' }
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toContain(
      'EDITOR_STATE_INVALID'
    );
  });

  it('asset_search 使用稳定 cursor 返回有界资产页，并默认移除原始字段', async () => {
    const assets = [
      createAssetRecord('asset-a', 'db://assets/ui/ButtonPrimary.png', 'Button Primary'),
      createAssetRecord('asset-b', 'db://assets/ui/ButtonSecondary.png', 'Button Secondary'),
      createAssetRecord('asset-c', 'db://assets/ui/Panel.png', 'Panel')
    ];
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.assetIndex') {
        return { assets, scripts: [], documents: [], unresolved: [] };
      }
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const first = await client.callTool({
      name: 'cocos_asset_search',
      arguments: { projectId: 'project-a', pattern: 'button', pageSize: 1 }
    });
    const firstPage = first.structuredContent as {
      page: { items: Array<Record<string, unknown>>; total: number; nextCursor: string | null };
    };
    expect(first.isError).not.toBe(true);
    expect(firstPage.page.total).toBe(2);
    expect(firstPage.page.items).toHaveLength(1);
    expect(firstPage.page.items[0]).toMatchObject({ assetUuid: 'asset-a' });
    expect(firstPage.page.items[0]).not.toHaveProperty('raw');
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const second = await client.callTool({
      name: 'cocos_asset_search',
      arguments: {
        projectId: 'project-a',
        pattern: 'button',
        pageSize: 1,
        cursor: firstPage.page.nextCursor
      }
    });
    expect(second.structuredContent).toMatchObject({
      page: {
        total: 2,
        items: [{ assetUuid: 'asset-b' }],
        nextCursor: null
      }
    });
  });

  it('asset_search 拒绝伪造的超大分页 cursor', async () => {
    const assets = [
      createAssetRecord('asset-a', 'db://assets/ui/ButtonPrimary.png', 'Button Primary'),
      createAssetRecord('asset-b', 'db://assets/ui/ButtonSecondary.png', 'Button Secondary')
    ];
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.assetIndex') {
        return { assets, scripts: [], documents: [], unresolved: [] };
      }
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);
    const first = await client.callTool({
      name: 'cocos_asset_search',
      arguments: { projectId: 'project-a', pattern: 'button', pageSize: 1 }
    });
    const cursor = decodeOpaqueCursor((first.structuredContent as {
      page: { nextCursor: string };
    }).page.nextCursor);
    cursor.pageSize = 100_000;

    const result = await client.callTool({
      name: 'cocos_asset_search',
      arguments: {
        projectId: 'project-a',
        pattern: 'button',
        cursor: encodeOpaqueCursor(cursor)
      }
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toContain(
      'MCP_CURSOR_INVALID'
    );
  });

  it('asset_inspect 分页返回依赖和反向使用者，并按需开放原始 Meta', async () => {
    const asset = createAssetRecord(
      'asset-a',
      'db://assets/ui/Button.png',
      'Button'
    );
    const details = createAssetProbeInfo(asset);
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.assetIndex') {
        return { assets: [asset], scripts: [], documents: [], unresolved: [] };
      }
      if (method === 'probe.assets') {
        return {
          assets: [details],
          details,
          meta: { importer: 'image', userData: { spriteMode: 1 } },
          dependencies: ['dependency-a', 'dependency-b'],
          users: ['user-a'],
          unresolved: []
        };
      }
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const first = await client.callTool({
      name: 'cocos_asset_inspect',
      arguments: {
        projectId: 'project-a',
        uuid: 'asset-a',
        pageSize: 2,
        includeRaw: true
      }
    });
    const firstContent = first.structuredContent as {
      asset: Record<string, unknown>;
      meta: unknown;
      page: { items: unknown[]; total: number; nextCursor: string | null };
    };
    expect(first.isError).not.toBe(true);
    expect(firstContent.asset).toMatchObject({ uuid: 'asset-a' });
    expect(firstContent.meta).toEqual({ importer: 'image', userData: { spriteMode: 1 } });
    expect(firstContent.page).toMatchObject({
      total: 3,
      items: [
        { kind: 'dependency', assetUuid: 'dependency-a' },
        { kind: 'dependency', assetUuid: 'dependency-b' }
      ]
    });
    expect(firstContent.page.nextCursor).toEqual(expect.any(String));

    const second = await client.callTool({
      name: 'cocos_asset_inspect',
      arguments: {
        projectId: 'project-a',
        uuid: 'asset-a',
        pageSize: 2,
        cursor: firstContent.page.nextCursor,
        includeRaw: true
      }
    });
    expect(second.structuredContent).toMatchObject({
      page: {
        total: 3,
        items: [{ kind: 'user', assetUuid: 'user-a' }],
        nextCursor: null
      }
    });
  });

  it('component_schema 返回协议校验后的完整 Schema，并按需包含原始 Dump', async () => {
    const component = createComponentProbeResult();
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.component') return component;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_component_schema',
      arguments: {
        projectId: 'project-a',
        uuid: 'component-a',
        includeRaw: true
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      editor: { editorInstanceId: 'editor-a', projectId: 'project-a' },
      schema: {
        componentUuid: 'component-a',
        className: 'GameController',
        scriptUuid: 'script-a',
        scriptPath: 'db://assets/script/GameController.ts'
      },
      raw: component.raw
    });
    expect(probeClient.requests).toContainEqual({
      method: 'probe.component',
      payload: {
        selector: { projectId: 'project-a', editorInstanceId: 'editor-a' },
        params: { uuid: 'component-a' }
      }
    });
  });

  it('component_schema 解包 Bridge 信封并优先取内层原始 Dump', async () => {
    const component = createComponentProbeResult();
    const innerRaw = { value: { uuid: { value: 'component-a' } }, marker: 'inner-raw' };
    const envelope = {
      data: { ...component.data, raw: innerRaw },
      raw: { marker: 'envelope-raw' },
      source: 'message-api'
    };
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.component') return envelope;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_component_schema',
      arguments: {
        projectId: 'project-a',
        uuid: 'component-a',
        includeRaw: true
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema: {
        componentUuid: 'component-a',
        className: 'GameController',
        scriptPath: 'db://assets/script/GameController.ts'
      },
      raw: innerRaw
    });
  });

  it('component_schema 兼容无信封的旧形状响应', async () => {
    const legacy = createComponentProbeResult().data;
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.component') return legacy;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_component_schema',
      arguments: {
        projectId: 'project-a',
        uuid: 'component-a',
        includeRaw: true
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema: {
        componentUuid: 'component-a',
        className: 'GameController'
      },
      raw: legacy.raw
    });
  });

  it('document_snapshot 透传 Creator 分页参数并验证完整快照 Schema', async () => {
    const snapshot = createDocumentSnapshot('document-a');
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      if (method === 'probe.documentSnapshot') return snapshot;
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_document_snapshot',
      arguments: {
        projectId: 'project-a',
        mode: 'full',
        pageSize: 25,
        cursor: 'creator-cursor',
        includeRaw: true,
        concurrency: 3
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      editor: createEditorSession('editor-a'),
      snapshot
    });
    expect(probeClient.requests).toContainEqual({
      method: 'probe.documentSnapshot',
      payload: {
        selector: { projectId: 'project-a', editorInstanceId: 'editor-a' },
        params: {
          mode: 'full',
          pageSize: 25,
          cursor: 'creator-cursor',
          includeRaw: true,
          concurrency: 3
        }
      }
    });
  });

  it('project_scan 写入授权报告并只返回摘要、文档页和可继续读取的 cursor', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const first = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/project-scan.json',
        scanPageSize: 20,
        pageSize: 1
      }
    });
    const firstContent = first.structuredContent as {
      reportPath: string;
      checkpointPath: string;
      summary: { assets: number; documents: number };
      page: { items: unknown[]; total: number; nextCursor: string | null };
    };
    expect(first.isError).not.toBe(true);
    expect(firstContent.reportPath).toBe(resolve(reportRoot, 'task8/project-scan.json'));
    expect(firstContent.checkpointPath).toBe(
      resolve(reportRoot, 'task8/project-scan.checkpoint.json')
    );
    expect(firstContent.summary).toMatchObject({ assets: 2, documents: 2 });
    expect(firstContent.page).toMatchObject({ total: 2 });
    expect(firstContent.page.items).toHaveLength(1);
    expect(firstContent.page.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first.structuredContent)).not.toContain('raw-marker');

    const report = ProjectScanReportManifestSchema.parse(JSON.parse(
      await readFile(firstContent.reportPath, 'utf8')
    ));
    expect(report.formatVersion).toBe(2);
    expect(report.summary).toMatchObject({
      documents: 2,
      completedDocuments: 2,
      failedDocuments: 0
    });
    expect(report).not.toHaveProperty('documents');
    const openedBeforePaging = probeClient.requests.filter((request) =>
      request.method === 'probe.openAsset'
    ).length;

    const second = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        pageSize: 1,
        cursor: firstContent.page.nextCursor
      }
    });
    expect(second.structuredContent).toMatchObject({
      page: { total: 2, nextCursor: null }
    });
    expect((second.structuredContent as { page: { items: unknown[] } }).page.items).toHaveLength(1);
    expect(probeClient.requests.filter((request) =>
      request.method === 'probe.openAsset'
    )).toHaveLength(openedBeforePaging);
  });

  it('prefab_graph 把完整图写入 checkpoint，只向 AI 返回有界节点和边页', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient({ withPrefabEdge: true });
    const { client } = await createHarness(probeClient, reportRoot);

    const result = await client.callTool({
      name: 'cocos_prefab_graph',
      arguments: {
        projectId: 'project-a',
        report: 'task8/prefab-graph.json',
        pageSize: 1
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      reportPath: resolve(reportRoot, 'task8/prefab-graph.json'),
      summary: { nodes: 2, edges: 1, blocked: false },
      page: { total: 3 }
    });
    const firstPage = (result.structuredContent as {
      reportPath: string;
      checkpointPath: string;
      page: { items: unknown[]; nextCursor: string | null };
    });
    expect(firstPage.page).toMatchObject({
      items: [expect.objectContaining({ kind: 'node' })],
      nextCursor: expect.any(String)
    });
    const second = await client.callTool({
      name: 'cocos_prefab_graph',
      arguments: {
        projectId: 'project-a',
        pageSize: 1,
        cursor: firstPage.page.nextCursor
      }
    });
    const secondCursor = (second.structuredContent as {
      page: { nextCursor: string };
    }).page.nextCursor;
    const third = await client.callTool({
      name: 'cocos_prefab_graph',
      arguments: {
        projectId: 'project-a',
        pageSize: 1,
        cursor: secondCursor
      }
    });
    expect(third.structuredContent).toMatchObject({
      page: {
        items: [expect.objectContaining({ kind: 'edge' })],
        nextCursor: null
      }
    });
    const checkpoint = JSON.parse(await readFile(firstPage.checkpointPath, 'utf8')) as {
      result: { prefabGraph: { nodes: unknown[]; edges: unknown[] } };
    };
    expect(checkpoint.result.prefabGraph.nodes).toHaveLength(2);
    expect(checkpoint.result.prefabGraph.edges).toHaveLength(1);
  });

  it('报告内容失效后拒绝继续使用旧 cursor，并且不再请求 Creator', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const first = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/stale-report.json',
        pageSize: 1
      }
    });
    const content = first.structuredContent as {
      reportPath: string;
      page: { nextCursor: string };
    };
    await writeFile(content.reportPath, '{}\n', 'utf8');
    const requestsBeforePaging = probeClient.requests.length;

    const second = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        pageSize: 1,
        cursor: content.page.nextCursor
      }
    });

    expect(second.isError).toBe(true);
    expect(second.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: 'MCP_CURSOR_STALE'
    }));
    expect(probeClient.requests).toHaveLength(requestsBeforePaging);
  });

  it('报告或 checkpoint 的有效 JSON 内容变化后也拒绝旧 cursor', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const first = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/content-hash.json',
        pageSize: 1
      }
    });
    const content = first.structuredContent as {
      reportPath: string;
      checkpointPath: string;
      page: { nextCursor: string };
    };
    const report = JSON.parse(await readFile(content.reportPath, 'utf8')) as {
      summary: { diagnostics: number };
    };
    report.summary.diagnostics += 1;
    await writeFile(content.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const changedReport = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        pageSize: 1,
        cursor: content.page.nextCursor
      }
    });
    expect(changedReport.isError).toBe(true);
    expect((changedReport.content as Array<{ text?: string }>)[0]?.text).toContain(
      'MCP_CURSOR_STALE'
    );

    const fresh = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/checkpoint-hash.json',
        pageSize: 1
      }
    });
    const freshContent = fresh.structuredContent as {
      checkpointPath: string;
      page: { nextCursor: string };
    };
    const checkpoint = JSON.parse(await readFile(freshContent.checkpointPath, 'utf8')) as {
      updatedAt: string;
    };
    checkpoint.updatedAt = '2026-07-14T00:00:00.000Z';
    await writeFile(
      freshContent.checkpointPath,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      'utf8'
    );
    const changedCheckpoint = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        pageSize: 1,
        cursor: freshContent.page.nextCursor
      }
    });
    expect(changedCheckpoint.isError).toBe(true);
    expect((changedCheckpoint.content as Array<{ text?: string }>)[0]?.text).toContain(
      'MCP_CURSOR_STALE'
    );
  });

  it('项目报告 cursor 拒绝伪造的超大分页参数', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);
    const first = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/large-cursor.json',
        pageSize: 1
      }
    });
    const cursor = decodeOpaqueCursor((first.structuredContent as {
      page: { nextCursor: string };
    }).page.nextCursor);
    cursor.pageSize = 201;

    const result = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        cursor: encodeOpaqueCursor(cursor)
      }
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toContain(
      'MCP_CURSOR_INVALID'
    );
  });

  it('project_scan 从 checkpoint 续扫时继承扫描参数且不重复打开已完成资产', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const first = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/resume-source.json',
        scanPageSize: 25,
        includeRaw: true,
        concurrency: 3
      }
    });
    const firstContent = first.structuredContent as {
      scanId: string;
      checkpointPath: string;
    };
    const checkpoint = JSON.parse(await readFile(firstContent.checkpointPath, 'utf8')) as {
      completedAssetUuids: string[];
      documents: unknown[];
      failures: unknown[];
    };
    checkpoint.completedAssetUuids = ['document-a'];
    checkpoint.documents = checkpoint.documents.slice(0, 1);
    checkpoint.failures = [];
    await writeFile(
      firstContent.checkpointPath,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      'utf8'
    );
    const requestOffset = probeClient.requests.length;

    const resumed = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/resume-result.json',
        resume: 'task8/resume-source.checkpoint.json'
      }
    });

    expect(resumed.isError).not.toBe(true);
    expect(resumed.structuredContent).toMatchObject({ scanId: firstContent.scanId });
    const resumeRequests = probeClient.requests.slice(requestOffset);
    expect(resumeRequests.filter((request) =>
      request.method === 'probe.openAsset'
    )).toEqual([{
      method: 'probe.openAsset',
      payload: {
        selector: { projectId: 'project-a', editorInstanceId: 'editor-a' },
        params: { uuid: 'document-b' }
      }
    }]);
    expect(resumeRequests).toContainEqual({
      method: 'probe.documentSnapshot',
      payload: {
        selector: { projectId: 'project-a', editorInstanceId: 'editor-a' },
        params: expect.objectContaining({
          pageSize: 25,
          includeRaw: true,
          concurrency: 3,
          document: expect.objectContaining({ assetUuid: 'document-b' })
        })
      }
    });
  });

  it.each([
    'C:/outside.json',
    '\\\\server\\share\\outside.json',
    'task8/not-json.txt'
  ])('项目扫描在 Creator 请求前拒绝非法报告路径 %s', async (report) => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const result = await client.callTool({
      name: 'cocos_project_scan',
      arguments: { projectId: 'project-a', report }
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: 'INVALID_REPORT_PATH'
    }));
    expect(probeClient.requests).toEqual([]);
  });

  it('项目扫描拒绝目录目标和越过报告根的 Junction', async () => {
    const reportRoot = await createTemporaryRoot();
    const outsideRoot = await createTemporaryRoot();
    await mkdir(resolve(reportRoot, 'task8/directory.json'), { recursive: true });
    await symlink(outsideRoot, resolve(reportRoot, 'task8/outside-link'), 'junction');
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    for (const report of [
      'task8/directory.json',
      'task8/outside-link/report.json'
    ]) {
      const result = await client.callTool({
        name: 'cocos_project_scan',
        arguments: { projectId: 'project-a', report }
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        type: 'text',
        text: 'INVALID_REPORT_PATH'
      }));
    }
    expect(probeClient.requests).toEqual([]);
  });

  it('项目扫描在 Creator 请求前拒绝畸形 checkpoint', async () => {
    const reportRoot = await createTemporaryRoot();
    await mkdir(resolve(reportRoot, 'task8'), { recursive: true });
    await writeFile(
      resolve(reportRoot, 'task8/invalid.checkpoint.json'),
      '{"version":1}\n',
      'utf8'
    );
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const result = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: 'task8/invalid-resume-result.json',
        resume: 'task8/invalid.checkpoint.json'
      }
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toContain(
      'SCAN_CHECKPOINT_INVALID'
    );
    expect(probeClient.requests).toEqual([]);
  });

  it('项目扫描在任何 Creator 请求前拒绝越过报告根目录的路径', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createProjectScanProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const result = await client.callTool({
      name: 'cocos_project_scan',
      arguments: {
        projectId: 'project-a',
        report: '../outside.json'
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: 'INVALID_REPORT_PATH'
    }));
    expect(probeClient.requests).toEqual([]);
  });

  it('设计只读工具复用完整快照、差异和计划引擎', async () => {
    const reportRoot = await createTemporaryRoot();
    const target = createDesignTarget(28);
    const probeClient = createDesignProbeClient();
    const { client } = await createHarness(probeClient, reportRoot);

    const inspect = await client.callTool({
      name: 'cocos_design_inspect',
      arguments: { projectId: 'project-a' }
    });
    expect(inspect.isError).not.toBe(true);
    expect(inspect.structuredContent).toMatchObject({
      editor: createEditorSession('editor-a'),
      inspect: { tree: [{ name: 'root', children: [{ name: 'label' }] }] }
    });

    const plan = await client.callTool({
      name: 'cocos_design_plan',
      arguments: { projectId: 'project-a', target }
    });
    expect(plan.isError).not.toBe(true);
    expect(plan.structuredContent).toMatchObject({
      plan: { items: [expect.objectContaining({ kind: 'component.set_property', target: '$label', value: 28 })] }
    });

    const preview = await client.callTool({
      name: 'cocos_design_preview',
      arguments: { projectId: 'project-a', target }
    });
    expect(preview.isError).not.toBe(true);
    expect(preview.structuredContent).toMatchObject({
      preview: { mode: 'preview', operationCount: 1 }
    });
    expect(probeClient.requests.filter((request) => request.method === 'probe.writePrepare')).toHaveLength(0);
  });
});

describe('Cocos gated design MCP tools', () => {
  it('verify/export 默认不注册，显式 enableWrites 后注册并完成独立读取', async () => {
    const probeClient = createDesignProbeClient();
    const defaultHarness = await createHarness(probeClient, 'reports', { enableWrites: false });
    const defaultTools = await defaultHarness.client.listTools();
    expect(defaultTools.tools.map((tool) => tool.name)).toEqual(COCOS_READONLY_TOOL_NAMES);
    expect(defaultTools.tools.map((tool) => tool.name)).not.toContain('cocos_design_verify');
    expect(defaultTools.tools.map((tool) => tool.name)).not.toContain('cocos_design_export');

    const reportRoot = await createTemporaryRoot();
    const enabledHarness = await createHarness(
      createDesignProbeClient(), reportRoot, { enableWrites: true }
    );
    const enabledTools = await enabledHarness.client.listTools();
    expect(enabledTools.tools.map((tool) => tool.name)).toEqual([
      ...COCOS_READONLY_TOOL_NAMES,
      ...COCOS_WRITE_TOOL_NAMES,
      ...COCOS_GATED_READONLY_TOOL_NAMES
    ]);
    const target = createDesignTarget(24);
    const verify = await enabledHarness.client.callTool({
      name: 'cocos_design_verify',
      arguments: { projectId: 'project-a', target }
    });
    expect(verify.isError).not.toBe(true);
    expect(verify.structuredContent).toMatchObject({ report: { passed: true } });

    const exported = await enabledHarness.client.callTool({
      name: 'cocos_design_export',
      arguments: { projectId: 'project-a', rootUuid: 'node-root' }
    });
    expect(exported.isError).not.toBe(true);
    expect(exported.structuredContent).toMatchObject({
      target: { document: { scope: 'current-document', assetUuid: 'scene-1' }, tree: [{ id: '$node-file-root' }] }
    });
  });

  it('design_apply 经事务写通道执行、重新读取验证并写入审计', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createDesignApplyProbeClient();
    const { client } = await createHarness(probeClient, reportRoot, { enableWrites: true });

    const applied = await client.callTool({
      name: 'cocos_design_apply',
      arguments: {
        projectId: 'project-a',
        target: createDesignTarget(28),
        executionId: 'design-apply-1'
      }
    });

    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      result: { status: 'committed', verification: { passed: true } }
    });
    expect(probeClient.requests.map((request) => request.method)).toEqual([
      'server.editors', 'probe.documentSnapshot',
      'server.editors', 'probe.writePrepare',
      'server.editors', 'probe.writeConfirm',
      'server.editors', 'probe.documentSnapshot'
    ]);
    const transactionJournal = (await readFile(
      join(reportRoot, 'write-journal', 'design-apply-1-001.jsonl'), 'utf8'
    )).trim().split('\n').map((line) => JSON.parse(line) as { event: string });
    expect(transactionJournal.map((entry) => entry.event)).toEqual([
      'cocos_write_prepare', 'cocos_write_confirm'
    ]);
    const designJournal = JSON.parse((await readFile(
      join(reportRoot, 'write-journal', 'design-apply-1.jsonl'), 'utf8'
    )).trim());
    expect(designJournal.event).toBe('cocos_design_apply');
  });

  it('design_apply 的 confirm 结果未知时要求人工恢复，不误报普通失败', async () => {
    const reportRoot = await createTemporaryRoot();
    const probeClient = createDesignApplyProbeClient({ confirmOutcomeUnknown: true });
    const { client } = await createHarness(probeClient, reportRoot, { enableWrites: true });

    const applied = await client.callTool({
      name: 'cocos_design_apply',
      arguments: {
        projectId: 'project-a',
        target: createDesignTarget(28),
        executionId: 'design-unknown-1'
      }
    });

    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      result: {
        status: 'manual-recovery-required',
        failedStep: { code: 'DESIGN_CONFIRM_OUTCOME_UNKNOWN' }
      }
    });
    expect(probeClient.requests.map((request) => request.method)).not.toContain('probe.transactionRollback');
  });
});

async function createHarness(
  probeClient: ReadonlyProbeClient,
  reportRoot = 'reports',
  runtime: { enableWrites?: boolean } = {}
): Promise<McpHarness> {
  const server = createCocosMcpServer({ probeClient, reportRoot }, runtime);
  const client = new Client({ name: 'cocos-ai-mcp-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const harness = { server, client };
  harnesses.push(harness);
  return harness;
}

function createEditorSession(editorInstanceId: string) {
  return {
    editorInstanceId,
    projectId: 'project-a',
    projectPath: 'E:/project-a',
    creatorVersion: '3.8.8',
    bridgeVersion: '0.1.0',
    capabilities: [
      'probe.editorState',
      'probe.assets',
      'probe.assetIndex',
      'probe.component',
      'probe.documentSnapshot',
      'probe.openAsset'
    ]
  };
}

function createEditorState() {
  return {
    creatorVersion: '3.8.8',
    projectPath: 'E:/project-a',
    projectId: 'project-a',
    document: {
      assetUuid: 'scene-a',
      dirty: false,
      mode: 'scene',
      source: 'cce.SceneFacadeManager'
    },
    ready: { scene: true, assetDatabase: true },
    selection: { node: ['node-a'], asset: ['asset-a'] },
    preview: null,
    unresolved: []
  };
}

function createAssetRecord(assetUuid: string, url: string, displayName: string) {
  return {
    assetUuid,
    url,
    filePath: `E:/project-a/${url.slice('db://'.length)}`,
    type: 'cc.ImageAsset',
    importer: 'image',
    name: displayName,
    displayName,
    source: url,
    path: url,
    isSubAsset: false,
    isBundle: false,
    imported: true,
    invalid: false,
    isDirectory: false,
    visible: true,
    readonly: false,
    available: true,
    raw: { uuid: assetUuid, url, customField: 'raw-value' }
  };
}

function createAssetProbeInfo(asset: ReturnType<typeof createAssetRecord>) {
  return {
    uuid: asset.assetUuid,
    url: asset.url,
    file: asset.filePath,
    type: asset.type,
    importer: asset.importer,
    isSubAsset: asset.isSubAsset,
    isBundle: asset.isBundle,
    name: asset.name,
    source: asset.source,
    path: asset.path,
    displayName: asset.displayName,
    imported: asset.imported,
    invalid: asset.invalid,
    isDirectory: asset.isDirectory,
    visible: asset.visible,
    readonly: asset.readonly,
    unknownFieldCount: 1,
    raw: asset.raw
  };
}

function createComponentProbeResult() {
  // 与 Bridge 场景进程 probeComponent 的真实信封形状一致：{data:{…,schema,raw}, raw, source}
  const raw = { value: { uuid: { value: 'component-a' } } };
  return {
    data: {
      identity: { objectUuid: 'component-a', fileId: 'component-file-a' },
      class: {
        className: 'GameController',
        typeId: 'game-controller-type',
        custom: true,
        scriptUuid: 'script-a',
        scriptPath: 'db://assets/script/GameController.ts',
        inheritance: ['cc.Component', 'cc.Object']
      },
      properties: {},
      schema: {
        componentUuid: 'component-a',
        className: 'GameController',
        qualifiedName: 'GameController',
        typeId: 'game-controller-type',
        scriptUuid: 'script-a',
        scriptPath: 'db://assets/script/GameController.ts',
        inheritance: ['cc.Component', 'cc.Object'],
        executionOrder: 0,
        properties: [],
        rawClassAttributes: {},
        unresolved: []
      },
      unresolved: [],
      raw
    },
    raw,
    source: 'message-api'
  };
}

function createDesignTarget(fontSize: number) {
  return {
    document: { scope: 'current-document' as const, assetUuid: 'scene-1' },
    tree: [{
      id: '$root', fileId: 'file-root', name: 'root',
      children: [{
        id: '$label', fileId: 'file-label', name: 'label',
        components: [{ type: 'cc.Label', properties: { fontSize } }]
      }]
    }]
  };
}

function createDesignProbeClient(): RecordingProbeClient {
  return new RecordingProbeClient((method) => {
    if (method === 'server.editors') return [createEditorSession('editor-a')];
    if (method === 'probe.documentSnapshot') return createDesignDocumentSnapshot();
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function createDesignApplyProbeClient(
  options: { confirmOutcomeUnknown?: boolean } = {}
): RecordingProbeClient {
  let fontSize = 24;
  return new RecordingProbeClient((method, payload) => {
    if (method === 'server.editors') return [createWriteCapableEditorSession('editor-a')];
    if (method === 'probe.documentSnapshot') return createDesignDocumentSnapshot(fontSize);
    const transactionId = (payload as { params?: { transactionId?: string } }).params?.transactionId
      ?? 'design-apply-1-001';
    if (method === 'probe.writePrepare') {
      return createDesignWriteResult(transactionId, 'validated', 0);
    }
    if (method === 'probe.writeConfirm') {
      if (options.confirmOutcomeUnknown) throw new Error('连接在确认后中断');
      fontSize = 28;
      return createDesignWriteResult(transactionId, 'committed', 1);
    }
    if (method === 'probe.transactionRollback') {
      fontSize = 24;
      return {
        ...createDesignWriteResult(transactionId, 'rolled-back', 1),
        rollbackEvidence: { attempted: true, succeeded: true, verifiedClean: true }
      };
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function createDesignDocumentSnapshot(fontSize = 24) {
  const snapshot = createDocumentSnapshot('scene-1');
  snapshot.document = {
    ...snapshot.document,
    path: 'db://assets/main.scene',
    filePath: 'E:/project-a/assets/main.scene',
    documentType: 'scene' as const
  };
  const emptyIdentity = {
    sessionId: null, assetUuid: null, fileId: null, objectUuid: null,
    typeId: null, scriptUuid: null
  };
  snapshot.page.totalNodes = 2;
  snapshot.nodes = [
    {
      kind: 'node' as const,
      identity: { ...emptyIdentity, objectUuid: 'node-root', fileId: 'file-root' },
      name: 'root', path: 'root', parentObjectUuid: null, childObjectUuids: ['node-label'],
      components: []
    },
    {
      kind: 'node' as const,
      identity: { ...emptyIdentity, objectUuid: 'node-label', fileId: 'file-label' },
      name: 'label', path: 'root/label', parentObjectUuid: 'node-root', childObjectUuids: [],
      components: [{
        kind: 'component' as const,
        identity: { ...emptyIdentity, objectUuid: 'component-label', typeId: 'cc.Label' },
        className: 'cc.Label',
        properties: [{
          propertyPath: 'fontSize', declaredType: 'number', valueKind: 'number' as const,
          effectiveValue: fontSize, sourceValue: fontSize, overrideValue: null, valueSource: 'local'
        }],
        rawSerializedState: {}
      }]
    }
  ];
  snapshot.coverage = {
    ...snapshot.coverage,
    nodes: { total: 2, decoded: 2 },
    components: { total: 1, decoded: 1 },
    properties: { total: 1, decoded: 1 }
  };
  return snapshot;
}

function createDesignWriteResult(transactionId: string, status: string, executedOps: number) {
  return {
    transactionId,
    status,
    executedOps,
    verification: status === 'committed'
      ? {
          passed: true,
          verifiedAt: '2026-07-21T00:00:00.000Z',
          items: Array.from({ length: executedOps }, (_, operationIndex) => ({
            operationIndex,
            description: `operation-${operationIndex}`,
            expected: true,
            actual: true,
            passed: true
          }))
        }
      : null,
    failure: null,
    rollbackEvidence: null
  };
}

function createDocumentSnapshot(assetUuid: string, pageSize = 25) {
  return {
    document: {
      assetUuid,
      path: `db://assets/${assetUuid}.prefab`,
      filePath: `E:/project-a/assets/${assetUuid}.prefab`,
      documentType: 'prefab' as const,
      available: true,
      raw: { assetUuid }
    },
    revision: `revision-${assetUuid}`,
    mode: 'full' as const,
    page: {
      offset: 0,
      pageSize,
      totalNodes: 0,
      nextCursor: null
    },
    nodes: [],
    componentSchemas: [],
    prefabInstances: [],
    coverage: createEmptyCoverage(),
    unresolved: [],
    diagnostics: [],
    raw: { hierarchy: { uuid: 'root' } }
  };
}

function createEmptyCoverage() {
  return {
    nodes: { total: 0, decoded: 0 },
    components: { total: 0, decoded: 0 },
    properties: { total: 0, decoded: 0 },
    references: { total: 0, resolved: 0 },
    prefabInstances: { total: 0, resolved: 0 },
    overrides: { total: 0, decoded: 0 }
  };
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cocos-ai-mcp-'));
  temporaryRoots.push(root);
  return root;
}

function createProjectScanProbeClient(
  options: { withPrefabEdge?: boolean } = {}
): RecordingProbeClient {
  const documents = ['document-a', 'document-b'].map((assetUuid) => ({
    assetUuid,
    path: `db://assets/${assetUuid}.prefab`,
    filePath: `E:/project-a/assets/${assetUuid}.prefab`,
    documentType: 'prefab' as const,
    available: true,
    raw: { assetUuid, marker: 'raw-marker' }
  }));
  const assets = documents.map((document) => ({
    ...createAssetRecord(document.assetUuid, document.path, document.assetUuid),
    type: 'cc.Prefab',
    importer: 'prefab',
    raw: document.raw
  }));
  return new RecordingProbeClient((method, payload) => {
    if (method === 'server.editors') return [createEditorSession('editor-a')];
    if (method === 'probe.assetIndex') {
      return { assets, scripts: [], documents, unresolved: [] };
    }
    if (method === 'probe.openAsset') return { opened: true };
    if (method === 'probe.editorState') {
      return { ready: { scene: true, assetDatabase: true } };
    }
    if (method === 'probe.documentSnapshot') {
      const request = payload as {
        params: { pageSize: number; document: { assetUuid: string } };
      };
      const snapshot = createDocumentSnapshot(
        request.params.document.assetUuid,
        request.params.pageSize
      );
      if (options.withPrefabEdge && request.params.document.assetUuid === 'document-a') {
        snapshot.prefabInstances.push({
          ownerDocumentAssetUuid: 'document-a',
          hostNodePath: 'Root/DocumentB',
          sourcePrefabAssetUuid: 'document-b',
          instanceRootObjectUuid: 'instance-root-b',
          sourceObjectFileId: 'source-file-b',
          instanceFileId: 'instance-file-b',
          prefabRootNodeUuid: 'instance-root-b',
          instanceChain: [],
          sync: true,
          state: null,
          propertyOverrides: [],
          targetOverrides: [],
          mountedChildren: [],
          mountedComponents: [],
          removedComponents: [],
          unresolved: [],
          rawPrefabInfo: {}
        });
        snapshot.coverage.prefabInstances = { total: 1, resolved: 1 };
      }
      return snapshot;
    }
    throw new Error(`UNEXPECTED_REQUEST:${method}`);
  });
}

function decodeOpaqueCursor(value: string): Record<string, unknown> & { pageSize: number } {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    & { pageSize: number };
}

function encodeOpaqueCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Cocos write MCP tools', () => {
  it('未显式 enableWrites 时不注册写工具', async () => {
    const probeClient = new RecordingProbeClient(() => []);
    const { client } = await createHarness(probeClient, 'reports', { enableWrites: false });

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(COCOS_READONLY_TOOL_NAMES);
  });

  it('显式 enableWrites 后注册写工具和门控只读工具，标注保持真实', async () => {
    const probeClient = new RecordingProbeClient(() => []);
    const { client } = await createHarness(probeClient, 'reports', { enableWrites: true });

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      ...COCOS_READONLY_TOOL_NAMES,
      ...COCOS_WRITE_TOOL_NAMES,
      ...COCOS_GATED_READONLY_TOOL_NAMES
    ]);
    const writeTools = result.tools.filter((tool) =>
      (COCOS_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name)
    );
    expect(writeTools.every((tool) => tool.annotations?.readOnlyHint === false)).toBe(true);
    expect(writeTools.every((tool) => tool.annotations?.destructiveHint === true)).toBe(true);
    const gatedReadonlyTools = result.tools.filter((tool) =>
      (COCOS_GATED_READONLY_TOOL_NAMES as readonly string[]).includes(tool.name)
    );
    expect(gatedReadonlyTools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(gatedReadonlyTools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  });

  it('cocos_write_prepare 校验请求、转发事务并把审计落盘', async () => {
    const reportRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-mcp-journal-'));
    temporaryRoots.push(reportRoot);
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createWriteCapableEditorSession('editor-a')];
      if (method === 'probe.writePrepare') return writeTransactionResult();
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient, reportRoot, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_write_prepare',
      arguments: {
        projectId: 'project-a',
        transactionId: 'tx-1',
        idempotencyKey: 'key-1',
        revision: { document: 'sha256:doc', hierarchy: null, assetDatabase: null, scriptCompilation: null },
        operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
        save: true,
        undoGroup: 'rename-node'
      }
    });

    expect(result.isError).not.toBe(true);
    expect(probeClient.requests).toContainEqual({
      method: 'probe.writePrepare',
      payload: {
        selector: { projectId: 'project-a', editorInstanceId: 'editor-a' },
        params: {
          transactionId: 'tx-1',
          idempotencyKey: 'key-1',
          scope: 'current-document',
          revision: { document: 'sha256:doc', hierarchy: null, assetDatabase: null, scriptCompilation: null },
          operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
          save: true,
          undoGroup: 'rename-node'
        }
      }
    });
    expect(result.structuredContent).toMatchObject({
      result: { transactionId: 'tx-1', status: 'committed' }
    });
    const journal = JSON.parse(
      (await readFile(join(reportRoot, 'write-journal', 'tx-1.jsonl'), 'utf8')).trim().split('\n')[0]
    );
    expect(journal).toMatchObject({
      transactionId: 'tx-1',
      idempotencyKey: 'key-1',
      event: 'cocos_write_prepare',
      source: 'mcp'
    });
  });

  it('缺少幂等键时写请求被拒绝且不转发到 Bridge', async () => {
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createWriteCapableEditorSession('editor-a')];
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient, 'reports', { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_write_prepare',
      arguments: {
        projectId: 'project-a',
        transactionId: 'tx-1',
        revision: { document: null, hierarchy: null, assetDatabase: null, scriptCompilation: null },
        operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
        save: true,
        undoGroup: 'rename-node'
      }
    });

    expect(result.isError).toBe(true);
    expect(probeClient.requests.every((request) => request.method !== 'probe.writePrepare')).toBe(true);
  });

  it('Bridge 未登记写能力时写工具拒绝执行', async () => {
    const probeClient = new RecordingProbeClient((method) => {
      if (method === 'server.editors') return [createEditorSession('editor-a')];
      throw new Error(`UNEXPECTED_REQUEST:${method}`);
    });
    const { client } = await createHarness(probeClient, 'reports', { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_transaction_rollback',
      arguments: { projectId: 'project-a', transactionId: 'tx-1' }
    });

    expect(result.isError).toBe(true);
    expect(probeClient.requests.every((request) => request.method !== 'probe.transactionRollback')).toBe(true);
  });
});

function createWriteCapableEditorSession(editorInstanceId: string) {
  const session = createEditorSession(editorInstanceId);
  return {
    ...session,
    capabilities: [
      ...session.capabilities,
      'probe.writePrepare',
      'probe.writeConfirm',
      'probe.transactionStatus',
      'probe.transactionList',
      'probe.transactionRollback'
    ]
  };
}

function writeTransactionResult() {
  return {
    transactionId: 'tx-1',
    status: 'committed',
    executedOps: 1,
    verification: {
      passed: true,
      verifiedAt: '2026-07-17T00:00:01.000Z',
      items: [{ operationIndex: 0, description: '节点重命名', expected: 'NewName', actual: 'NewName', passed: true }]
    },
    failure: null,
    rollbackEvidence: null
  };
}
