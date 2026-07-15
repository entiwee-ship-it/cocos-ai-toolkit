import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES } from '../../protocol/src/transport.js';
import {
  BRIDGE_WEBSOCKET_MAX_PAYLOAD_BYTES,
  BridgeClient
} from '../src/bridge-client';

describe('BridgeClient WebSocket transport', () => {
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
          bridgeVersion: '0.1.0',
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
