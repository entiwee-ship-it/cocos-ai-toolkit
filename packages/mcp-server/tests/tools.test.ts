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
  it('只注册八个只读工具，并把 editor_list 作为唯一的全局发现入口', async () => {
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
      ['cocos_project_scan', ['projectId']]
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
});

async function createHarness(
  probeClient: ReadonlyProbeClient,
  reportRoot = 'reports'
): Promise<McpHarness> {
  const server = createCocosMcpServer({ probeClient, reportRoot });
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
    document: { assetUuid: null, dirty: false },
    ready: { scene: true, assetDatabase: true },
    selection: { node: ['node-a'], asset: ['asset-a'] },
    preview: null,
    unresolved: [
      { path: 'document.assetUuid', reason: 'PUBLIC_API_NOT_CONFIRMED' }
    ]
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
  return {
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
    raw: { value: { uuid: { value: 'component-a' } } }
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
