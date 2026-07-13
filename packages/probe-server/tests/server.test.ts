import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ArtifactStore } from '../src/artifact-store.js';
import { ProbeServer } from '../src/server.js';
import { SessionRegistry } from '../src/session-registry.js';

describe('SessionRegistry', () => {
  it('同一项目存在多个实例时拒绝隐式选择', () => {
    const registry = new SessionRegistry();
    registry.register({
      editorInstanceId: 'a',
      projectId: 'project',
      projectPath: 'E:/project-a',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0',
      capabilities: []
    });
    registry.register({
      editorInstanceId: 'b',
      projectId: 'project',
      projectPath: 'E:/project-b',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0',
      capabilities: []
    });

    expect(() => registry.resolve({ projectId: 'project' })).toThrow('MULTIPLE_EDITOR_INSTANCES');
  });
});

describe('ArtifactStore', () => {
  it('只允许向报告根目录写入 JSON 文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cocos-ai-artifacts-'));
    const store = new ArtifactStore(root);

    const savedPath = await store.save('editor-state.json', { ready: true });
    const content = JSON.parse(await readFile(savedPath, 'utf8')) as { ready: boolean };

    expect(content.ready).toBe(true);
    await expect(store.save('../escape.json', {})).rejects.toThrow('INVALID_ARTIFACT_PATH');
    await expect(store.save('E:/escape.json', {})).rejects.toThrow('INVALID_ARTIFACT_PATH');
  });
});

describe('ProbeServer', () => {
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

  it('登记 Bridge 并按 correlationId 配对响应', async () => {
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
            bridgeVersion: '0.1.0',
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
    socket.close();
    await server.stop();
  });
});
