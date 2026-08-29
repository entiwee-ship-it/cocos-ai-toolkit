import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands.js';
import * as cliModule from '../src/index.js';

const { executeCommand, readRequestTimeoutMs, toRequest } = cliModule;

interface FakeClient {
  request(method: string, payload: unknown): Promise<unknown>;
}

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

  it('解析资产索引命令并映射到 Bridge 方法', () => {
    const assetIndex = parseCommand(['asset-index', '--project-id', 'project-1']);

    expect(assetIndex).toEqual({ command: 'asset-index', projectId: 'project-1' });

    expect(toRequest(assetIndex)).toEqual([
      'probe.assetIndex',
      { selector: { projectId: 'project-1' }, params: {} }
    ]);
  });

  it('拒绝静默忽略拼写错误的参数', () => {
    expect(() => parseCommand([
      'hierarchy',
      '--project-id', 'project-1',
      '--dept', '3'
    ])).toThrow('UNKNOWN_ARGUMENT');
  });

  it('已移除的事务、声明式和扫描命令按未知命令拒绝', () => {
    for (const removed of [
      ['write-prepare', '--project-id', 'project-1', '--request', '{}'],
      ['transaction-list', '--project-id', 'project-1'],
      ['design-inspect', '--project-id', 'project-1'],
      ['scan-project', '--project-id', 'project-1'],
      ['prefab-graph', '--project-id', 'project-1'],
      ['document-snapshot', '--project-id', 'project-1'],
      ['write-revision', '--project-id', 'project-1'],
      ['save-report', '--project-id', 'project-1', '--sample', 'legacy'],
      ['component-schema', '--project-id', 'project-1', '--uuid', 'component-1']
    ]) {
      expect(() => parseCommand(removed)).toThrow('UNKNOWN_COMMAND');
    }
  });
});

describe('local readonly commands', () => {
  it('执行原子只读命令并返回共享 Client 响应', async () => {
    const requests: Array<{ method: string; payload: unknown }> = [];
    const client: FakeClient = {
      async request(method, payload) {
        requests.push({ method, payload });
        return { method, payload };
      }
    };
    const commands = [
      parseCommand(['asset-index', '--project-id', 'project-1']),
      parseCommand([
        'component',
        '--project-id', 'project-1',
        '--uuid', 'component-1'
      ])
    ];

    const results = [];
    for (const command of commands) {
      results.push(await executeCommand(command, client));
    }

    expect(results).toEqual(requests);
    expect(requests).toEqual([
      {
        method: 'probe.assetIndex',
        payload: { selector: { projectId: 'project-1' }, params: {} }
      },
      {
        method: 'probe.component',
        payload: {
          selector: { projectId: 'project-1' },
          params: { uuid: 'component-1' }
        }
      }
    ]);
  });
});

describe('readRequestTimeoutMs', () => {
  it('仅接受正整数毫秒，非法值回退默认 60 秒', () => {
    expect(readRequestTimeoutMs('120000')).toBe(120000);
    for (const value of [undefined, '0', '-1', '1.5', 'not-a-number']) {
      expect(readRequestTimeoutMs(value)).toBe(60000);
    }
  });
});
