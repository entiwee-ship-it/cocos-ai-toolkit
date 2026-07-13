import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ProbeClient } from '../src/client.js';
import { parseCommand } from '../src/commands.js';
import { toRequest } from '../src/index.js';

describe('parseCommand', () => {
  it('解析带明确编辑器实例的层级探针', () => {
    expect(parseCommand([
      'hierarchy',
      '--project-id', 'project-1',
      '--editor-instance-id', 'editor-1',
      '--depth', '3'
    ])).toEqual({
      command: 'hierarchy',
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      depth: 3
    });
  });

  it.each(['0', '-1', '21'])('拒绝非法层级深度 %s', (depth) => {
    expect(() => parseCommand([
      'hierarchy',
      '--project-id', 'project-1',
      '--depth', depth
    ])).toThrow('INVALID_DEPTH');
  });

  it('拒绝缺少 project-id 的节点查询', () => {
    expect(() => parseCommand(['node', '--uuid', 'node-1'])).toThrow('PROJECT_ID_REQUIRED');
  });

  it('解析带 UUID 的资源详情查询', () => {
    expect(parseCommand([
      'assets', '--project-id', 'project-1', '--pattern', 'db://assets/a.prefab', '--uuid', 'asset-1'
    ])).toEqual({
      command: 'assets',
      projectId: 'project-1',
      pattern: 'db://assets/a.prefab',
      uuid: 'asset-1'
    });
  });

  it('解析两阶段 Undo 保存事务且 prepare 不要求节点 UUID', () => {
    const prepared = parseCommand([
      'probe-undo-save-prepare',
      '--project-id', 'project-1',
      '--project-path', 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',
      '--document-uuid', 'asset-1',
      '--probe-name', 'CocosAiProbe_123'
    ]);
    expect(prepared).toMatchObject({
      command: 'probe-undo-save-prepare',
      documentUuid: 'asset-1',
      probeName: 'CocosAiProbe_123'
    });
    expect(toRequest(prepared)).toEqual(['probe.undoSavePrepare', {
      selector: { projectId: 'project-1' },
      params: {
        projectPath: 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',
        documentAssetUuid: 'asset-1',
        probeName: 'CocosAiProbe_123'
      }
    }]);
  });

  it('解析 confirm 和 status 事务命令', () => {
    const confirm = parseCommand([
      'probe-undo-save-confirm',
      '--project-id', 'project-1',
      '--transaction-id', 'transaction-1',
      '--expected-revision', 'revision-1'
    ]);
    const status = parseCommand([
      'probe-undo-save-status',
      '--project-id', 'project-1',
      '--transaction-id', 'transaction-1'
    ]);

    expect(toRequest(confirm)).toEqual(['probe.undoSaveConfirm', {
      selector: { projectId: 'project-1' },
      params: { transactionId: 'transaction-1', expectedRevision: 'revision-1' }
    }]);
    expect(toRequest(status)).toEqual(['probe.undoSaveStatus', {
      selector: { projectId: 'project-1' },
      params: { transactionId: 'transaction-1' }
    }]);
  });
});

describe('ProbeClient', () => {
  it('完成 client.hello 后发送控制请求', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          method?: string;
          requestId?: string;
        };
        if (message.method === 'client.hello') {
          socket.send(JSON.stringify({
            type: 'response',
            correlationId: 'client.hello',
            ok: true,
            payload: {}
          }));
          return;
        }

        socket.send(JSON.stringify({
          type: 'response',
          correlationId: message.requestId,
          ok: true,
          payload: [{ editorInstanceId: 'editor-1' }]
        }));
      });
    });

    const client = new ProbeClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    const editors = await client.request('server.editors', {});

    expect(editors).toEqual([{ editorInstanceId: 'editor-1' }]);
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
