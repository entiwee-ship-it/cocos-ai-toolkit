import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CreatorIpcServer,
  buildCreatorPipeName,
  type CreatorEndpointDescriptor
} from '../src/ipc-server';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CreatorIpcServer', () => {
  it('登记 Creator 端点，并且每条短连接只处理一个请求', async () => {
    const endpointRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-ipc-server-'));
    roots.push(endpointRoot);
    const descriptor = createDescriptor();
    const server = new CreatorIpcServer({
      endpointRoot,
      describe: () => descriptor,
      handlers: {
        echo: async (payload) => ({ payload })
      }
    });

    await server.start();
    const files = await readdir(endpointRoot);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(endpointRoot, files[0]), 'utf8'))).toMatchObject(descriptor);

    expect(await send(descriptor.pipeName, 'bridge.describe', {})).toMatchObject(descriptor);
    expect(await send(descriptor.pipeName, 'echo', { value: 7 })).toEqual({ payload: { value: 7 } });
    expect(server.getStatus()).toMatchObject({
      state: 'ready',
      activeRequests: 0,
      totalRequests: 2
    });

    await server.stop();
    expect(await readdir(endpointRoot)).toEqual([]);
  });
});

function createDescriptor(suffix = 'default'): CreatorEndpointDescriptor {
  const editorInstanceId = `project:${process.pid}:${suffix}:${Date.now()}`;
  return {
    schemaVersion: 1,
    editorInstanceId,
    projectId: 'project-id',
    projectPath: 'E:/project',
    creatorVersion: '3.8.8',
    bridgeVersion: '0.9.1',
    bridgeBuildId: 'build-id',
    capabilities: ['probe.editorState'],
    processId: process.pid,
    pipeName: buildCreatorPipeName(editorInstanceId),
    startedAt: new Date().toISOString()
  };
}

function send(pipeName: string, method: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random()}`;
    const socket = createConnection(pipeName);
    const chunks: Buffer[] = [];
    socket.once('connect', () => socket.write(`${JSON.stringify({
      type: 'request',
      requestId,
      method,
      payload
    })}\n`));
    socket.on('data', (chunk) => {
      const newline = chunk.indexOf(10);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      if (newline < 0) return;
      const response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        correlationId: string;
        ok: boolean;
        payload: unknown;
      };
      socket.destroy();
      if (response.correlationId !== requestId) reject(new Error('INVALID_CORRELATION'));
      else if (response.ok) resolve(response.payload);
      else reject(response.payload);
    });
    socket.once('error', reject);
  });
}
