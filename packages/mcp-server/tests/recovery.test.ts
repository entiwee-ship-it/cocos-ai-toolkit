import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreatorClient, type CreatorEndpointDescriptor } from '@cocos-ai/client';
import { describe, expect, it } from 'vitest';
import { createCocosMcpServer } from '../src/server.js';
import { startMcpRuntime } from '../src/run.js';

describe('MCP 与 Creator 本机直连恢复', () => {
  it('Creator 后启动时同一 MCP Client 无需重连即可发现', async () => {
    const endpointRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-recovery-'));
    const creatorClient = new CreatorClient({ endpointRoot, requestTimeoutMs: 1_000 });
    const server = createCocosMcpServer({ creatorClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'recovery-test-client', version: '0.9.0' });
    const [runtime] = await Promise.all([
      startMcpRuntime({ creatorClient, server, transport: serverTransport }),
      client.connect(clientTransport)
    ]);
    let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
    try {
    expect((await client.listTools()).tools).toHaveLength(42);
      const offline = await client.callTool({ name: 'cocos_editor_list', arguments: {} });
      expect(offline.structuredContent).toMatchObject({
        editors: [],
        backend: { available: true, transport: 'named-pipe', state: 'ready' }
      });

      bridge = await startBridge(endpointRoot);
      const online = await client.callTool({ name: 'cocos_editor_list', arguments: {} });
      expect(online.structuredContent).toMatchObject({
        editors: [expect.objectContaining({ editorInstanceId: bridge.descriptor.editorInstanceId })]
      });
    } finally {
      await client.close();
      await runtime.close();
      await bridge?.close();
      await rm(endpointRoot, { recursive: true, force: true });
    }
  });
});

async function startBridge(endpointRoot: string) {
  const id = randomUUID();
  const descriptor: CreatorEndpointDescriptor = {
    schemaVersion: 1,
    editorInstanceId: `project-1:${id}`,
    projectId: 'project-1',
    projectPath: 'E:/project',
    creatorVersion: '3.8.8',
    bridgeVersion: '0.9.0',
    bridgeBuildId: 'build-id',
    capabilities: ['probe.editorState'],
    processId: process.pid,
    pipeName: `\\\\.\\pipe\\cocos-ai-recovery-${id}`,
    startedAt: new Date().toISOString()
  };
  const sockets = new Set<Socket>();
  const bridge = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(raw.slice(0, newline)) as { requestId: string; method: string };
      socket.end(`${JSON.stringify({
        type: 'response',
        correlationId: request.requestId,
        ok: request.method === 'bridge.describe',
        payload: request.method === 'bridge.describe'
          ? descriptor
          : { code: 'METHOD_NOT_ALLOWED', message: 'METHOD_NOT_ALLOWED', details: {} }
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(descriptor.pipeName, resolve);
  });
  await writeFile(join(endpointRoot, `${id}.json`), JSON.stringify(descriptor), 'utf8');
  return {
    descriptor,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  };
}
