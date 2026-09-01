import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES } from '../../protocol/src/transport.js';
import {
  BRIDGE_WEBSOCKET_MAX_PAYLOAD_BYTES,
  BridgeClient,
  type BridgeLifecycleEvent
} from '../src/bridge-client';

describe('BridgeClient WebSocket transport', () => {
  it('按 connecting/socket-open/hello-sent/ready 顺序报告成功握手', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const events: BridgeLifecycleEvent[] = [];
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    server.once('connection', (socket) => {
      socket.once('message', (raw) => {
        const hello = JSON.parse(raw.toString()) as { method?: string };
        expect(hello.method).toBe('bridge.hello');
        socket.send(JSON.stringify({
          type: 'response',
          correlationId: 'bridge.hello',
          ok: true,
          payload: {}
        }));
      });
    });
    const client = new BridgeClient({
      url: `ws://127.0.0.1:${port}`,
      hello: () => ({ method: 'bridge.hello', payload: {} }),
      handlers: {},
      onLifecycleEvent: (event) => {
        events.push(event);
        if (event.type === 'ready') resolveReady?.();
      }
    });

    try {
      client.connect();
      await ready;
      expect(events.map((event) => event.type)).toEqual([
        'connecting',
        'socket-open',
        'hello-sent',
        'ready'
      ]);
    } finally {
      client.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('断线后报告带抖动的重连计划，dispose 后报告释放且不再连接', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const events: BridgeLifecycleEvent[] = [];
    let connectionCount = 0;
    let resolveRetry: (() => void) | undefined;
    const retryScheduled = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.once('message', () => socket.close(1012, 'test restart'));
    });
    const client = new BridgeClient({
      url: `ws://127.0.0.1:${port}`,
      hello: () => ({ method: 'bridge.hello', payload: {} }),
      handlers: {},
      reconnectBaseMs: 40,
      reconnectMaxMs: 100,
      onLifecycleEvent: (event) => {
        events.push(event);
        if (event.type === 'retry-scheduled') resolveRetry?.();
      }
    });

    try {
      client.connect();
      await retryScheduled;
      client.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      expect(events.map((event) => event.type)).toEqual([
        'connecting',
        'socket-open',
        'hello-sent',
        'disconnected',
        'retry-scheduled',
        'disposed'
      ]);
      expect(events).toContainEqual({ type: 'retry-scheduled', attempt: 1, delayMs: 44 });
      expect(connectionCount).toBe(1);
    } finally {
      client.dispose();
      vi.restoreAllMocks();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('与共享协议保持相同的有限默认上限', () => {
    expect(BRIDGE_WEBSOCKET_MAX_PAYLOAD_BYTES).toBe(
      DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES
    );
  });

  it('拒绝用零把 Bridge 接收上限配置成无限制', () => {
    const client = new BridgeClient({
      url: 'ws://127.0.0.1:1',
      hello: () => ({}),
      handlers: {},
      maxPayload: 0
    });

    try {
      expect(() => client.connect()).toThrow('INVALID_WEBSOCKET_MAX_PAYLOAD');
    } finally {
      client.dispose();
    }
  });

  it('按显式 maxPayload 拒绝超大 Probe Server 请求', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const outcome = new Promise<number>((resolve, reject) => {
      server.once('connection', (socket) => {
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString()) as {
            method?: string;
            correlationId?: string;
          };
          if (message.method === 'bridge.hello') {
            socket.send(JSON.stringify({
              type: 'request',
              requestId: 'oversized-request',
              method: 'probe.large',
              payload: 'x'.repeat(128)
            }));
            return;
          }
          if (message.correlationId === 'oversized-request') {
            resolve(0);
            socket.close();
          }
        });
        socket.once('close', (code) => resolve(code));
        socket.once('error', reject);
      });
    });

    const client = new BridgeClient({
      url: `ws://127.0.0.1:${port}`,
      hello: () => ({
        method: 'bridge.hello',
        payload: {
          editorInstanceId: 'editor-1',
          projectId: 'project-1',
          projectPath: 'E:/project',
          creatorVersion: '3.8.8',
          bridgeVersion: '0.6.8',
          capabilities: []
        }
      }),
      handlers: {
        'probe.large': async () => ({ ok: true })
      },
      reconnectBaseMs: 60_000,
      reconnectMaxMs: 60_000,
      maxPayload: 64
    });

    try {
      client.connect();
      await expect(outcome).resolves.toBe(1009);
    } finally {
      client.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
