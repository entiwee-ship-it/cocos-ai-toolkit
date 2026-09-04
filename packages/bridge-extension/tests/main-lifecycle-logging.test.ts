import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipcMock = vi.hoisted(() => ({
  options: null as null | {
    onLifecycleEvent?: (event: unknown) => void;
  },
  start: vi.fn(),
  stop: vi.fn()
}));

vi.mock('../src/ipc-server', () => ({
  buildCreatorPipeName: () => '\\\\.\\pipe\\cocos-ai-test',
  CreatorIpcServer: class {
    constructor(options: typeof ipcMock.options) {
      ipcMock.options = options;
    }

    async start() {
      ipcMock.start();
      ipcMock.options?.onLifecycleEvent?.({
        type: 'ready',
        pipeName: '\\\\.\\pipe\\cocos-ai-test',
        endpointFile: 'C:/endpoint/test.json'
      });
      return this.getStatus();
    }

    async stop() {
      ipcMock.stop();
      ipcMock.options?.onLifecycleEvent?.({
        type: 'stopped',
        pipeName: '\\\\.\\pipe\\cocos-ai-test'
      });
    }

    getStatus() {
      return {
        state: 'ready',
        pipeName: '\\\\.\\pipe\\cocos-ai-test',
        endpointFile: 'C:/endpoint/test.json',
        activeRequests: 0,
        totalRequests: 0,
        lastRequestAt: null,
        lastError: null,
        authentication: 'local-user'
      };
    }
  }
}));

describe('Bridge 扩展生命周期控制台日志', () => {
  const originalEditor = (globalThis as Record<string, unknown>).Editor;
  const editorLog = vi.fn();

  beforeEach(() => {
    ipcMock.options = null;
    ipcMock.start.mockReset();
    ipcMock.stop.mockReset();
    editorLog.mockReset();
    (globalThis as Record<string, unknown>).Editor = {
      Project: { path: 'E:/project', uuid: 'project-id' },
      App: { version: '3.8.8' },
      log: editorLog,
      Message: { request: vi.fn() },
      Panel: { open: vi.fn(), has: vi.fn() },
      Selection: { clear: vi.fn(), select: vi.fn(), getSelected: vi.fn(() => []) }
    };
  });

  afterEach(async () => {
    const main = await import('../src/main');
    await main.unload();
    if (originalEditor === undefined) delete (globalThis as Record<string, unknown>).Editor;
    else (globalThis as Record<string, unknown>).Editor = originalEditor;
  });

  it('加载时只启动 Creator 本机直连并输出有效信息', async () => {
    const main = await import('../src/main');
    await main.load();

    expect(ipcMock.start).toHaveBeenCalledOnce();
    const loadMessage = editorLog.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith('[CocosAI][Bridge] 扩展开始加载 '));
    expect(loadMessage).toBeDefined();
    const details = JSON.parse(loadMessage!.slice(loadMessage!.indexOf('{'))) as Record<string, unknown>;
    expect(details).toMatchObject({
      扩展版本: '0.7.0',
      Creator版本: '3.8.8',
      项目ID: 'project-id',
      项目路径: 'E:/project',
      进程ID: process.pid,
      直连管道: '\\\\.\\pipe\\cocos-ai-test'
    });
    expect(details.能力数量).toBeTypeOf('number');
    const readyMessage = editorLog.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith('[CocosAI][Bridge] 本机直连已就绪 '));
    expect(readyMessage).toContain('cocos-ai-test');
    expect(readyMessage).toContain('C:/endpoint/test.json');
    expect(editorLog.mock.calls.flat().join('\n')).not.toContain('WebSocket');
    expect(editorLog.mock.calls.flat().join('\n')).not.toContain('32188');

    await main.unload();
    expect(ipcMock.stop).toHaveBeenCalledOnce();
  });
});
