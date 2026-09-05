import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreatorClient,
  CreatorClientError,
  type CreatorEndpointDescriptor
} from '../src/client.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  delete process.env.COCOS_AI_REQUEST_LOG;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('CreatorClient named-pipe behavior', () => {
  it('启动不建立长连接，没有 Creator 时返回空编辑器列表', async () => {
    const endpointRoot = await temporaryRoot();
    const client = new CreatorClient({ endpointRoot });
    expect(client.getStatus()).toMatchObject({ state: 'idle', transport: 'named-pipe' });
    await client.connect();
    expect(await client.request('server.editors', {})).toEqual([]);
    expect(await readdir(endpointRoot)).toEqual([]);
    expect(client.getStatus()).toMatchObject({ state: 'ready', endpointRoot });
    await client.close();
    expect(client.getStatus().state).toBe('closed');
  });

  it('发现 Creator 后按工具调用建立独立短连接', async () => {
    const endpointRoot = await temporaryRoot();
    const bridge = await startFakeCreator(endpointRoot, async (request) => ({
      echoedMethod: request.method,
      echoedPayload: request.payload
    }));
    const client = new CreatorClient({ endpointRoot });
    await client.connect();

    expect(await client.request('server.editors', {})).toEqual([
      expect.objectContaining({
        editorInstanceId: bridge.descriptor.editorInstanceId,
        projectId: bridge.descriptor.projectId,
        bridgeVersion: bridge.descriptor.bridgeVersion
      })
    ]);
    expect(await client.request('probe.editorState', {
      selector: { projectId: bridge.descriptor.projectId },
      params: { value: 7 }
    })).toEqual({ echoedMethod: 'probe.editorState', echoedPayload: { value: 7 } });
    expect(bridge.connectionCount()).toBe(3);
    await client.close();
  });

  it('会话令牌只随本机请求发送，不写入端点描述', async () => {
    const endpointRoot = await temporaryRoot();
    const tokens: Array<string | undefined> = [];
    const bridge = await startFakeCreator(endpointRoot, async (request) => {
      tokens.push(request.sessionToken);
      if (request.sessionToken !== 'secret') {
        return failure('IPC_UNAUTHORIZED');
      }
      return { ok: true };
    });
    const client = new CreatorClient({ endpointRoot, sessionToken: 'secret' });
    await client.connect();
    await client.request('probe.editorState', {
      selector: { projectId: bridge.descriptor.projectId },
      params: {}
    });
    expect(tokens).toEqual(['secret']);
    expect(JSON.stringify(bridge.descriptor)).not.toContain('secret');
    await client.close();
  });

  it('忽略已经失效的端点描述文件', async () => {
    const endpointRoot = await temporaryRoot();
    const stale = descriptor('stale');
    await writeDescriptor(endpointRoot, stale);
    const client = new CreatorClient({ endpointRoot, requestTimeoutMs: 50 });
    await client.connect();
    expect(await client.request('server.editors', {})).toEqual([]);
    await client.close();
  });

  it('Bridge 结构化失败响应保持错误字段', async () => {
    const endpointRoot = await temporaryRoot();
    const bridge = await startFakeCreator(endpointRoot, async (request) => (
      request.method === 'probe.node'
        ? failure('NODE_NOT_FOUND', {
            message: '目标节点不存在',
            details: { uuid: 'missing' },
            stage: 'read',
            nextAction: '刷新层级后重试'
          })
        : {}
    ));
    const client = new CreatorClient({ endpointRoot });
    await client.connect();
    const error = await client.request('probe.node', {
      selector: { projectId: bridge.descriptor.projectId },
      params: { uuid: 'missing' }
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CreatorClientError);
    expect(error).toMatchObject({
      code: 'NODE_NOT_FOUND',
      originalMessage: '目标节点不存在',
      details: { uuid: 'missing' },
      stage: 'read',
      nextAction: '刷新层级后重试'
    });
    await client.close();
  });

  it('写请求发送后连接中断时保留 OUTCOME_UNKNOWN 保护', async () => {
    const endpointRoot = await temporaryRoot();
    const bridge = await startFakeCreator(endpointRoot, async (request, socket) => {
      if (request.method === 'probe.directWrite') {
        socket.destroy();
        return noResponse;
      }
      return {};
    });
    const client = new CreatorClient({ endpointRoot });
    await client.connect();
    const error = await client.request('probe.directWrite', {
      selector: { projectId: bridge.descriptor.projectId },
      params: { operations: [] }
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      nextAction: expect.stringContaining('禁止重试写入')
    });
    await client.close();
  });

  it('请求超时和过大响应使用稳定错误码', async () => {
    const timeoutRoot = await temporaryRoot();
    const timeoutBridge = await startFakeCreator(timeoutRoot, async (request) => (
      request.method === 'probe.node' ? noResponse : {}
    ));
    const timeoutClient = new CreatorClient({ endpointRoot: timeoutRoot, requestTimeoutMs: 30 });
    await timeoutClient.connect();
    await expect(timeoutClient.request('probe.node', {
      selector: { projectId: timeoutBridge.descriptor.projectId },
      params: {}
    })).rejects.toMatchObject({ code: 'CREATOR_IPC_REQUEST_TIMEOUT' });
    await timeoutClient.close();

    const payloadRoot = await temporaryRoot();
    const payloadBridge = await startFakeCreator(payloadRoot, async (request) => (
      request.method === 'probe.node' ? { text: 'x'.repeat(2_000) } : {}
    ));
    const payloadClient = new CreatorClient({ endpointRoot: payloadRoot, maxPayloadBytes: 1_000 });
    await payloadClient.connect();
    await expect(payloadClient.request('probe.node', {
      selector: { projectId: payloadBridge.descriptor.projectId },
      params: {}
    })).rejects.toMatchObject({ code: 'IPC_PAYLOAD_TOO_LARGE', retryable: false });
    await payloadClient.close();
  });

  it('debug 日志只记录元数据，不输出业务 payload', async () => {
    const endpointRoot = await temporaryRoot();
    const bridge = await startFakeCreator(endpointRoot, async () => ({ privateValue: 'do-not-log' }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env.COCOS_AI_REQUEST_LOG = 'debug';
    const client = new CreatorClient({ endpointRoot });
    await client.connect();
    await client.request('probe.node', {
      selector: { projectId: bridge.descriptor.projectId },
      params: { privateValue: 'do-not-log' }
    });
    const logged = stderr.mock.calls.map(([value]) => String(value)).join('');
    expect(logged).toContain('creator-ipc-client');
    expect(logged).not.toContain('do-not-log');
    stderr.mockRestore();
    await client.close();
  });
});

const noResponse = Symbol('no-response');

interface FakeRequest {
  requestId: string;
  method: string;
  payload: unknown;
  sessionToken?: string;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cocos-ai-client-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function startFakeCreator(
  endpointRoot: string,
  handler: (request: FakeRequest, socket: Socket) => Promise<unknown>
) {
  const value = descriptor(randomUUID());
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(raw.slice(0, newline)) as FakeRequest;
      void (async () => {
        const result = request.method === 'bridge.describe'
          ? value
          : await handler(request, socket);
        if (result === noResponse || socket.destroyed) return;
        if (isFailure(result)) {
          socket.end(`${JSON.stringify({
            type: 'response',
            correlationId: request.requestId,
            ok: false,
            payload: result.payload
          })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({
          type: 'response',
          correlationId: request.requestId,
          ok: true,
          payload: result
        })}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(value.pipeName, resolve);
  });
  await writeDescriptor(endpointRoot, value);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });
  return { descriptor: value, connectionCount: () => connections };
}

function descriptor(suffix: string): CreatorEndpointDescriptor {
  return {
    schemaVersion: 1,
    editorInstanceId: `project-id:${suffix}`,
    projectId: 'project-id',
    projectPath: 'E:/project',
    creatorVersion: '3.8.8',
    bridgeVersion: '0.8.0',
    bridgeBuildId: 'build-id',
    capabilities: ['probe.editorState', 'probe.node', 'probe.directWrite'],
    processId: process.pid,
    pipeName: `\\\\.\\pipe\\cocos-ai-client-${process.pid}-${suffix}`,
    startedAt: new Date().toISOString()
  };
}

async function writeDescriptor(root: string, value: CreatorEndpointDescriptor): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${randomUUID()}.json`), JSON.stringify(value), 'utf8');
}

function failure(code: string, rest: Record<string, unknown> = {}) {
  return {
    failure: true,
    payload: {
      code,
      message: code,
      details: {},
      ...rest
    }
  };
}

function isFailure(value: unknown): value is { failure: true; payload: unknown } {
  return Boolean(value && typeof value === 'object' && (value as { failure?: unknown }).failure === true);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
