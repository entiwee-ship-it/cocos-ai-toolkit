import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ProbeServer } from '../src/server.js';
import * as probeServerModule from '../src/server.js';

describe('Probe Server 默认配置', () => {
  it('Bridge 请求默认超时与 MCP 大型 Prefab 写入超时一致', () => {
    expect((probeServerModule as unknown as { DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS?: number })
      .DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS).toBe(180_000);
  });

  it('按方法选择短、中、长 Bridge 请求预算', () => {
    expect(probeServerModule.resolveBridgeRequestTimeoutMs('probe.node', 180_000)).toBe(15_000);
    expect(probeServerModule.resolveBridgeRequestTimeoutMs('probe.assetIndex', 180_000)).toBe(60_000);
    expect(probeServerModule.resolveBridgeRequestTimeoutMs('probe.directWrite', 180_000)).toBe(180_000);
    expect(probeServerModule.resolveBridgeRequestTimeoutMs('probe.node', 1_000)).toBe(1_000);
  });
});
import { SessionRegistry } from '../src/session-registry.js';

describe('SessionRegistry', () => {
  it('同一项目存在多个实例时拒绝隐式选择', () => {
    const registry = new SessionRegistry();
    registry.register({
      editorInstanceId: 'a',
      projectId: 'project',
      projectPath: 'E:/project-a',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.6.8',
      capabilities: []
    });
    registry.register({
      editorInstanceId: 'b',
      projectId: 'project',
      projectPath: 'E:/project-b',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.6.8',
      capabilities: []
    });

    expect(() => registry.resolve({ projectId: 'project' })).toThrow('MULTIPLE_EDITOR_INSTANCES');
  });
});

describe('ProbeServer', () => {
  it('配置 session token 后仅允许正确 Bearer token 完成握手', async () => {
    const server = new ProbeServer({
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 1000,
      sessionToken: 'secret-token'
    });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;

    try {
      for (const headers of [undefined, { Authorization: 'Bearer wrong-token' }]) {
        const socket = new WebSocket(url, headers ? { headers } : undefined);
        const statusCode = await new Promise<number>((resolve, reject) => {
          socket.once('unexpected-response', (_request, response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          });
          socket.once('error', () => undefined);
          socket.once('open', () => reject(new Error('UNAUTHORIZED_SOCKET_OPENED')));
        });
        expect(statusCode).toBe(401);
      }

      const authenticated = new WebSocket(url, {
        headers: { Authorization: 'Bearer secret-token' }
      });
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        authenticated.once('open', () => authenticated.send(JSON.stringify({
          method: 'client.hello', payload: { clientName: 'authenticated-client' }
        })));
        authenticated.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        authenticated.once('error', reject);
      });
      expect(response).toMatchObject({ correlationId: 'client.hello', ok: true });
      authenticated.close();
    } finally {
      await server.stop();
    }
  });

  it('超大消息只关闭当前连接且后续客户端仍可握手', async () => {
    const server = new ProbeServer({
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 1000,
      maxPayload: 256
    });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const oversizedSocket = new WebSocket(url);

    try {
      const closeCode = await new Promise<number>((resolve, reject) => {
        oversizedSocket.once('open', () => oversizedSocket.send('x'.repeat(512)));
        oversizedSocket.once('close', (code) => resolve(code));
        oversizedSocket.once('error', reject);
      });

      expect(closeCode).toBe(1009);

      const nextSocket = new WebSocket(url);
      const editors = await new Promise<unknown>((resolve, reject) => {
        nextSocket.once('open', () => {
          nextSocket.send(JSON.stringify({
            method: 'client.hello',
            payload: { clientName: 'post-oversize-client' }
          }));
        });
        nextSocket.on('message', (raw) => {
          const message = JSON.parse(raw.toString()) as {
            correlationId?: string;
            payload?: unknown;
          };
          if (message.correlationId === 'client.hello') {
            nextSocket.send(JSON.stringify({
              type: 'request',
              requestId: 'post-oversize-editors',
              method: 'server.editors',
              payload: {}
            }));
            return;
          }
          if (message.correlationId === 'post-oversize-editors') {
            resolve(message.payload);
          }
        });
        nextSocket.once('error', reject);
      });

      expect(editors).toEqual([]);
      nextSocket.close();
    } finally {
      oversizedSocket.close();
      await server.stop();
    }
  });

  it('拒绝未知角色的首包', async () => {
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 1000 });
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => socket.send(JSON.stringify({ method: 'probe.editorState' })));
      socket.once('close', () => resolve());
      socket.once('error', reject);
    });

    expect(server.sessions.list()).toHaveLength(0);
    await server.stop();
  });

  it('允许 CLI 客户端读取已登记编辑器列表', async () => {
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 1000 });
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);

    const response = await new Promise<{ payload: unknown }>((resolve, reject) => {
      socket.once('open', () => {
        socket.send(JSON.stringify({ method: 'client.hello', payload: { clientName: 'test-cli' } }));
      });
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          correlationId?: string;
          payload?: unknown;
        };
        if (message.correlationId === 'client.hello') {
          socket.send(JSON.stringify({
            type: 'request',
            requestId: 'client-request-1',
            method: 'server.editors',
            payload: {}
          }));
          return;
        }
        if (message.correlationId === 'client-request-1') {
          resolve({ payload: message.payload });
        }
      });
      socket.once('error', reject);
    });

    expect(response.payload).toEqual([]);
    socket.close();
    await server.stop();
  });

  it('定时 ping 健康客户端并保留可用连接', async () => {
    const server = new ProbeServer({
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 1_000,
      heartbeatIntervalMs: 10
    });
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    let pingCount = 0;
    socket.on('ping', () => { pingCount += 1; });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => socket.send(JSON.stringify({
          method: 'client.hello', payload: { clientName: 'heartbeat-client' }
        })));
        socket.once('message', () => resolve());
        socket.once('error', reject);
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      expect(pingCount).toBeGreaterThanOrEqual(1);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
      await server.stop();
    }
  });

  it('登记 Bridge 并按 correlationId 配对响应', async () => {
    const previous = process.env.COCOS_AI_REQUEST_LOG;
    process.env.COCOS_AI_REQUEST_LOG = 'debug';
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 1000 });
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        socket.send(JSON.stringify({
          method: 'bridge.hello',
          payload: {
            editorInstanceId: 'editor-1',
            projectId: 'project-1',
            projectPath: 'E:/project',
            creatorVersion: '3.8.8',
            bridgeVersion: '0.6.8',
            capabilities: ['probe.editorState']
          }
        }));
      });
      socket.once('message', () => resolve());
      socket.once('error', reject);
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        requestId?: string;
        method?: string;
      };
      if (message.type !== 'request' || !message.requestId) {
        return;
      }

      socket.send(JSON.stringify({
        type: 'response',
        correlationId: message.requestId,
        ok: true,
        payload: { ready: true }
      }));
    });

    const response = await server.request(
      { projectId: 'project-1', editorInstanceId: 'editor-1' },
      'probe.editorState',
      {}
    );

    expect(response).toEqual({ ready: true });
    const log = write.mock.calls.map((call) => String(call[0])).find((line) => line.includes('probe-server'));
    expect(log).toContain('"method":"probe.editorState"');
    expect(log).toContain('"eventLoopUtilization"');
    socket.close();
    await server.stop();
    write.mockRestore();
    if (previous === undefined) delete process.env.COCOS_AI_REQUEST_LOG;
    else process.env.COCOS_AI_REQUEST_LOG = previous;
  });
});
