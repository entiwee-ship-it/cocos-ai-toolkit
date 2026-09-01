import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProbeClient } from '@cocos-ai/client';
import { WebSocketServer, default as WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { ProbeServer } from '../../probe-server/src/server.js';
import { createCocosMcpServer } from '../src/server.js';
import { startMcpRuntime } from '../src/run.js';

describe('MCP 与 Probe 后端恢复', () => {
  it('Probe 离线时仍暴露 40 工具，上线后同一 MCP Client 在 2 秒内恢复', async () => {
    const reservation = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => reservation.once('listening', resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    const probeClient = new ProbeClient(`ws://127.0.0.1:${port}`, 2_000, undefined, 10, 50);
    const server = createCocosMcpServer({ probeClient }, { enableWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'recovery-test-client', version: '0.6.8' });
    const [runtime] = await Promise.all([
      startMcpRuntime({ probeClient, server, transport: serverTransport }),
      client.connect(clientTransport)
    ]);

    const probeServer = new ProbeServer({ host: '127.0.0.1', port, requestTimeoutMs: 1_000 });
    let bridge: WebSocket | null = null;
    try {
      expect((await client.listTools()).tools).toHaveLength(40);
      const offline = await client.callTool({ name: 'cocos_editor_list', arguments: {} });
      expect(offline.structuredContent).toMatchObject({
        editors: [],
        backend: { available: false }
      });

      await probeServer.start();
      bridge = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        bridge!.once('open', () => bridge!.send(JSON.stringify({
          method: 'bridge.hello',
          payload: {
            editorInstanceId: 'project-1:100',
            projectId: 'project-1',
            projectPath: 'E:/project',
            creatorVersion: '3.8.8',
            bridgeVersion: '0.6.8',
            bridgeBuildId: 'sha256:test',
            capabilities: []
          }
        })));
        bridge!.once('message', () => resolve());
        bridge!.once('error', reject);
      });

      const deadline = Date.now() + 2_000;
      let editors: unknown[] = [];
      do {
        const result = await client.callTool({ name: 'cocos_editor_list', arguments: {} });
        editors = (result.structuredContent as { editors?: unknown[] })?.editors ?? [];
        if (editors.length) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      expect(editors).toEqual([expect.objectContaining({ editorInstanceId: 'project-1:100' })]);
    } finally {
      bridge?.close();
      await client.close();
      await runtime.close();
      await probeServer.stop();
    }
  });
});
