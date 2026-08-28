import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ProbeClient, ProbeClientError } from '../src/client.js';

interface ClientMessage {
  method?: string;
  payload?: unknown;
  requestId?: string;
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * 创建完成 client.hello 握手的真实 WebSocket 测试服务。
 *
 * @param onRequest 收到普通控制请求后的测试行为。
 * @returns 测试服务地址和关闭方法。
 */
async function startTestServer(
  onRequest: (socket: WebSocket, message: ClientMessage) => void
): Promise<TestServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      if (message.method === 'client.hello') {
        socket.send(JSON.stringify({
          type: 'response',
          correlationId: 'client.hello',
          ok: true,
          payload: {}
        }));
        return;
      }
      onRequest(socket, message);
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe('ProbeClient shared behavior', () => {
  it('配置 session token 时在 WebSocket 握手发送 Bearer header', async () => {
    let authorization: string | undefined;
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    server.on('connection', (socket, request) => {
      authorization = request.headers.authorization;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        if (message.method === 'client.hello') {
          socket.send(JSON.stringify({
            type: 'response', correlationId: 'client.hello', ok: true, payload: {}
          }));
        }
      });
    });
    const port = (server.address() as AddressInfo).port;
    const client = new ProbeClient(`ws://127.0.0.1:${port}`, 1000, undefined, 500, 10000, 'secret-token');

    try {
      await client.connect();
      expect(authorization).toBe('Bearer secret-token');
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('首次握手后断线会自动重连，离线请求立即给出状态，恢复后同一实例继续调用', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    let connectionCount = 0;
    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        if (message.method === 'client.hello') {
          socket.send(JSON.stringify({
            type: 'response', correlationId: 'client.hello', ok: true, payload: {}
          }));
          return;
        }
        if (message.method === 'server.disconnect-once') {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({
          type: 'response',
          correlationId: message.requestId,
          ok: true,
          payload: { connectionCount }
        }));
      });
    });
    const port = (server.address() as AddressInfo).port;
    const client = new ProbeClient(`ws://127.0.0.1:${port}`, 1000, undefined, 5, 5);

    try {
      await client.connect();
    await expect(client.request('server.disconnect-once', {})).rejects.toThrow(
      'SERVER_CONNECTION_CLOSED'
    );
    await expect(client.request('server.editors', {})).rejects.toThrow('PROBE_SERVER_UNAVAILABLE');
    for (let index = 0; index < 50 && client.getStatus().state !== 'connected'; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(client.getStatus().state).toBe('connected');
    await expect(client.request('server.editors', {})).resolves.toEqual({ connectionCount: 2 });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('关闭客户端会停止重连并暴露 closed 状态', async () => {
    const server = await startTestServer((socket) => socket.close());
    const client = new ProbeClient(server.url, 1000, undefined, 5000, 5000);

    try {
      await client.connect();
      await expect(client.request('server.disconnect-once', {})).rejects.toThrow(
        'SERVER_CONNECTION_CLOSED'
      );
    await expect(client.request('server.editors', {})).rejects.toThrow('PROBE_SERVER_UNAVAILABLE');
    await client.close();
    expect(client.getStatus()).toMatchObject({ state: 'closed', nextRetryAt: null });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('首次连接失败后持续重试，Probe 上线时原 connect 自动完成', async () => {
    const reservation = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => reservation.once('listening', resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const client = new ProbeClient(`ws://127.0.0.1:${port}`, 1_000, undefined, 5, 5);
    const connecting = client.connect();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const server = new WebSocketServer({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      if (message.method === 'client.hello') {
        socket.send(JSON.stringify({
          type: 'response', correlationId: 'client.hello', ok: true, payload: {}
        }));
      }
    }));

    try {
      await expect(connecting).resolves.toBeUndefined();
      expect(client.getStatus().state).toBe('connected');
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('按显式 maxPayload 拒绝超大服务端响应', async () => {
    const server = await startTestServer((socket, message) => {
      socket.send(JSON.stringify({
        type: 'response',
        correlationId: message.requestId,
        ok: true,
        payload: 'x'.repeat(512)
      }));
    });
    const client = new ProbeClient(server.url, 1000, 256);

    try {
      await client.connect();
      await expect(client.request('server.editors', {})).rejects.toThrow(
        'Max payload size exceeded'
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('完成握手并按 requestId 解析请求响应', async () => {
    const server = await startTestServer((socket, message) => {
      socket.send(JSON.stringify({
        type: 'response',
        correlationId: message.requestId,
        ok: true,
        payload: [{ editorInstanceId: 'editor-1' }]
      }));
    });
    const client = new ProbeClient(server.url);

    try {
      await client.connect();
      await expect(client.request('server.editors', {})).resolves.toEqual([
        { editorInstanceId: 'editor-1' }
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('请求超过等待时间时返回稳定超时错误码', async () => {
    const server = await startTestServer(() => undefined);
    const client = new ProbeClient(server.url, 20);

    try {
      await client.connect();
      await expect(client.request('server.editors', {})).rejects.toThrow(
        'SERVER_REQUEST_TIMEOUT'
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('请求期间连接断开时终止全部等待请求', async () => {
    const server = await startTestServer((socket) => socket.close());
    const client = new ProbeClient(server.url);

    try {
      await client.connect();
      await expect(client.request('server.editors', {})).rejects.toThrow(
        'SERVER_CONNECTION_CLOSED'
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('服务端失败响应保留结构化 code', async () => {
    const server = await startTestServer((socket, message) => {
      socket.send(JSON.stringify({
        type: 'response',
        correlationId: message.requestId,
        ok: false,
        payload: { code: 'EDITOR_INSTANCE_NOT_FOUND' }
      }));
    });
    const client = new ProbeClient(server.url);

    try {
      await client.connect();
      await expect(client.request('probe.editorState', {})).rejects.toThrow(
        'EDITOR_INSTANCE_NOT_FOUND'
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('debug 观测只记录请求元数据而不输出业务 payload', async () => {
    const previous = process.env.COCOS_AI_REQUEST_LOG;
    process.env.COCOS_AI_REQUEST_LOG = 'debug';
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const server = await startTestServer((socket, message) => {
      socket.send(JSON.stringify({
        type: 'response', correlationId: message.requestId, ok: true, payload: { secret: 'hidden' }
      }));
    });
    const client = new ProbeClient(server.url);

    try {
      await client.connect();
      await client.request('server.editors', { secret: 'hidden' });
      const log = write.mock.calls.map((call) => String(call[0])).find((line) => line.includes('server.editors'));
      expect(log).toContain('"method":"server.editors"');
      expect(log).not.toContain('hidden');
    } finally {
      await client.close();
      await server.close();
      write.mockRestore();
      if (previous === undefined) delete process.env.COCOS_AI_REQUEST_LOG;
      else process.env.COCOS_AI_REQUEST_LOG = previous;
    }
  });

  it('服务端失败响应保留原始 message、details、stage 和 nextAction', async () => {
    const payload = {
      code: 'PROPERTY_READONLY',
      message: 'Creator 拒绝写入只读属性',
      details: { propertyPath: 'spriteFrame' },
      stage: 'apply',
      nextAction: '改用可写属性或移除该计划项'
    };
    const server = await startTestServer((socket, message) => {
      socket.send(JSON.stringify({
        type: 'response', correlationId: message.requestId, ok: false, payload
      }));
    });
    const client = new ProbeClient(server.url);

    try {
      await client.connect();
      const error = await client.request('probe.directWrite', {}).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProbeClientError);
      expect(error).toMatchObject({
        code: payload.code,
        originalMessage: payload.message,
        details: payload.details,
        stage: payload.stage,
        nextAction: payload.nextAction
      });
      expect((error as Error).message).toContain('Creator 拒绝写入只读属性');
      expect((error as Error).message).toContain('改用可写属性或移除该计划项');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
