import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadonlyProbeClient } from '@cocos-ai/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCocosMcpServer } from '../src/server.js';

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
  bridgeVersion: '0.1.28',
  capabilities: ['probe.editorState', 'probe.previewOpen']
};

function createRuntimeRespond(overrides: Record<string, unknown> = {}) {
  return (method: string): unknown => {
    if (method === 'server.editors') return [ONLINE_EDITOR];
    if (method in overrides) return overrides[method];
    if (method === 'server.previewSessions') return [];
    if (method === 'server.previewLaunch') {
      return {
        sessionId: 'preview-1',
        projectId: 'proj1',
        url: 'http://127.0.0.1:7457/',
        pageSource: 'self-launched',
        state: 'ready',
        launchedAt: '2026-07-22T07:10:00.000Z'
      };
    }
    if (method === 'server.runtimeHierarchy') {
      return {
        source: 'preview-runtime',
        previewSessionId: 'preview-1',
        capturedAt: '2026-07-22T07:10:01.000Z',
        root: { uuid: 'u1', name: 'Scene', active: true, dynamic: false, components: [], children: [] }
      };
    }
    if (method === 'server.runtimeInvoke') {
      return { found: true, invoked: true, returnValue: 6 };
    }
    if (method === 'server.runtimeSampleWindow') {
      return {
        source: 'preview-runtime',
        previewSessionId: 'preview-1',
        capturedAt: '2026-07-25T01:00:00.000Z',
        path: 'Scene/Canvas/login',
        nodeUuid: 'u2',
        componentType: 'LoginView',
        mode: 'perFrame',
        durationMs: 220,
        samples: [{ frame: 0, t: 100, values: {}, nodeValid: false }]
      };
    }
    if (method === 'server.runtimeInstantiate') {
      return { done: true, nodePath: 'Canvas/LayerUI/Dialog', parentName: 'LayerUI' };
    }
    if (method === 'server.runtimeRunScenario') {
      return {
        steps: [{ index: 0, kind: 'launch', passed: true }],
        passed: true,
        startedAt: '2026-07-22T07:10:02.000Z',
        finishedAt: '2026-07-22T07:10:03.000Z'
      };
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

async function createHarness(probeClient: ReadonlyProbeClient, options: { enableWrites?: boolean } = {}) {
  const reportRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-mcp-runtime-'));
  temporaryRoots.push(reportRoot);
  const server = createCocosMcpServer({ probeClient, reportRoot }, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'runtime-test-client', version: '0.1.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  harnesses.push({ server, client });
  return { client };
}

describe('运行态 MCP 工具（阶段五）', () => {
  it('默认注册运行态只读工具，门控工具仅 enableWrites 时注册', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    for (const expected of [
      'cocos_preview_sessions',
      'cocos_runtime_get_hierarchy',
      'cocos_runtime_inspect_component',
      'cocos_runtime_get_console',
      'cocos_runtime_watch_property',
      'cocos_runtime_capture'
    ]) {
      expect(names).toContain(expected);
    }
    for (const gated of [
      'cocos_preview_launch',
      'cocos_preview_stop',
      'cocos_runtime_invoke_method',
      'cocos_runtime_sample_window',
      'cocos_runtime_dispatch_input',
      'cocos_runtime_instantiate_prefab',
      'cocos_runtime_run_scenario'
    ]) {
      expect(names).not.toContain(gated);
    }

    const { client: writeClient } = await createHarness(probeClient, { enableWrites: true });
    const writeTools = await writeClient.listTools();
    const writeNames = writeTools.tools.map((tool) => tool.name);
    for (const gated of [
      'cocos_preview_launch',
      'cocos_preview_stop',
      'cocos_runtime_invoke_method',
      'cocos_runtime_sample_window',
      'cocos_runtime_dispatch_input',
      'cocos_runtime_instantiate_prefab',
      'cocos_runtime_run_scenario'
    ]) {
      expect(writeNames).toContain(gated);
    }
    const launchTool = writeTools.tools.find((tool) => tool.name === 'cocos_preview_launch');
    expect(launchTool?.annotations?.readOnlyHint).toBe(false);
  });

  it('cocos_preview_sessions 转发 server.previewSessions', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({ name: 'cocos_preview_sessions', arguments: { projectId: 'proj1' } });
    expect(result.structuredContent).toMatchObject({ sessions: [] });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'server.previewSessions',
      payload: { projectId: 'proj1' }
    });
  });

  it('cocos_preview_launch 校验编辑器与能力后启动会话', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_preview_launch',
      arguments: { projectId: 'proj1', resolution: { width: 720, height: 1280 } }
    });
    expect(result.structuredContent).toMatchObject({ sessionId: 'preview-1', state: 'ready' });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'server.previewLaunch',
      payload: {
        selector: { projectId: 'proj1', editorInstanceId: 'proj1:1234' },
        params: { resolution: { width: 720, height: 1280 } }
      }
    });
  });

  it('cocos_preview_launch 在编辑器不在线时拒绝', async () => {
    const probeClient = new RecordingProbeClient((method) => method === 'server.editors' ? [] : {});
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({ name: 'cocos_preview_launch', arguments: { projectId: 'proj1' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('EDITOR_INSTANCE_NOT_FOUND');
  });

  it('cocos_runtime_get_hierarchy 返回协议化快照', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient);

    const result = await client.callTool({
      name: 'cocos_runtime_get_hierarchy',
      arguments: {
        sessionId: 'preview-1',
        maxDepth: 4,
        path: 'Scene/Canvas',
        includeInactive: false
      }
    });
    expect(result.structuredContent).toMatchObject({
      source: 'preview-runtime',
      previewSessionId: 'preview-1',
      root: { name: 'Scene' }
    });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'server.runtimeHierarchy',
      payload: {
        sessionId: 'preview-1',
        maxDepth: 4,
        path: 'Scene/Canvas',
        includeInactive: false
      }
    });
  });

  it('cocos_runtime_invoke_method 经门控转发', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_runtime_invoke_method',
      arguments: { sessionId: 'preview-1', path: 'Canvas/panel', componentType: 'GameLogic', method: 'add', args: [2, 3] }
    });
    expect(result.structuredContent).toMatchObject({ invoked: true, returnValue: 6 });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'server.runtimeInvoke',
      payload: { sessionId: 'preview-1', path: 'Canvas/panel', componentType: 'GameLogic', method: 'add', args: [2, 3] }
    });
  });

  it('cocos_runtime_sample_window 经门控转发页面内采样请求', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_runtime_sample_window',
      arguments: {
        sessionId: 'preview-1',
        path: 'Scene/Canvas/login',
        componentType: 'LoginView',
        properties: ['opacity'],
        mode: 'perFrame',
        durationMs: 220,
        trigger: { method: 'startTransition', args: [] }
      }
    });

    expect(result.structuredContent).toMatchObject({
      source: 'preview-runtime',
      samples: [{ frame: 0, nodeValid: false }]
    });
    expect(probeClient.requests.at(-1)).toMatchObject({
      method: 'server.runtimeSampleWindow',
      payload: {
        sessionId: 'preview-1',
        path: 'Scene/Canvas/login',
        componentType: 'LoginView',
        properties: ['opacity'],
        mode: 'perFrame',
        durationMs: 220,
        trigger: { method: 'startTransition', args: [] }
      }
    });
  });

  it('cocos_runtime_instantiate_prefab 仅在门控开启后转发并拒绝空父路径', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_runtime_instantiate_prefab',
      arguments: {
        sessionId: 'preview-1',
        assetUuid: 'asset-1',
        parentPath: 'Canvas/LayerUI',
        x: 0,
        y: -10
      }
    });
    expect(result.structuredContent).toMatchObject({
      done: true,
      nodePath: 'Canvas/LayerUI/Dialog'
    });
    expect(probeClient.requests.at(-1)).toEqual({
      method: 'server.runtimeInstantiate',
      payload: {
        sessionId: 'preview-1',
        assetUuid: 'asset-1',
        parentPath: 'Canvas/LayerUI',
        x: 0,
        y: -10
      }
    });

    const requestCount = probeClient.requests.length;
    const invalid = await client.callTool({
      name: 'cocos_runtime_instantiate_prefab',
      arguments: { sessionId: 'preview-1', assetUuid: 'asset-1', parentPath: '   ' }
    });
    expect(invalid.isError).toBe(true);
    expect(probeClient.requests).toHaveLength(requestCount);
  });

  it('cocos_runtime_run_scenario 校验步骤并返回报告', async () => {
    const probeClient = new RecordingProbeClient(createRuntimeRespond());
    const { client } = await createHarness(probeClient, { enableWrites: true });

    const result = await client.callTool({
      name: 'cocos_runtime_run_scenario',
      arguments: { sessionId: 'preview-1', steps: [{ kind: 'launch' }] }
    });
    expect(result.structuredContent).toMatchObject({ passed: true });

    const invalid = await client.callTool({
      name: 'cocos_runtime_run_scenario',
      arguments: { sessionId: 'preview-1', steps: [{ kind: 'teleport' }] }
    });
    expect(invalid.isError).toBe(true);
  });
});
