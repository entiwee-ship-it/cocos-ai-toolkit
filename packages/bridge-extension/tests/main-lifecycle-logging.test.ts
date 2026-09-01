import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeLifecycleEvent } from '../src/bridge-client';

const bridgeMock = vi.hoisted(() => ({
  connect: vi.fn(),
  dispose: vi.fn(),
  options: null as null | {
    onLifecycleEvent?: (event: BridgeLifecycleEvent) => void;
  }
}));

vi.mock('../src/bridge-client', () => ({
  BridgeClient: class {
    constructor(options: typeof bridgeMock.options) {
      bridgeMock.options = options;
    }

    connect(): void {
      bridgeMock.connect();
    }

    dispose(): void {
      bridgeMock.dispose();
      bridgeMock.options?.onLifecycleEvent?.({ type: 'disposed' });
    }
  }
}));

describe('Bridge 扩展生命周期控制台日志', () => {
  const originalEditor = (globalThis as Record<string, unknown>).Editor;
  const originalProbeUrl = process.env.COCOS_AI_PROBE_SERVER_URL;
  const editorLog = vi.fn();

  beforeEach(() => {
    bridgeMock.connect.mockReset();
    bridgeMock.dispose.mockReset();
    bridgeMock.options = null;
    editorLog.mockReset();
    process.env.COCOS_AI_PROBE_SERVER_URL = 'ws://127.0.0.1:43210';
    (globalThis as Record<string, unknown>).Editor = {
      Project: { path: 'E:/project', uuid: 'project-id' },
      App: { version: '3.8.8' },
      log: editorLog,
      Message: { request: vi.fn() }
    };
  });

  afterEach(async () => {
    const main = await import('../src/main');
    main.unload();
    if (originalEditor === undefined) {
      delete (globalThis as Record<string, unknown>).Editor;
    } else {
      (globalThis as Record<string, unknown>).Editor = originalEditor;
    }
    if (originalProbeUrl === undefined) {
      delete process.env.COCOS_AI_PROBE_SERVER_URL;
    } else {
      process.env.COCOS_AI_PROBE_SERVER_URL = originalProbeUrl;
    }
  });

  it('加载时输出可区分真实运行时的初始化信息并转发连接事件', async () => {
    const main = await import('../src/main');

    main.load();

    expect(bridgeMock.connect).toHaveBeenCalledOnce();
    expect(editorLog).toHaveBeenCalledWith(expect.stringMatching(
      /^\[CocosAI\]\[Bridge\] 扩展开始加载 \{.*\}$/
    ));
    const loadMessage = editorLog.mock.calls[0][0] as string;
    const loadDetails = JSON.parse(loadMessage.slice(loadMessage.indexOf('{'))) as Record<string, unknown>;
    expect(loadDetails).toMatchObject({
      扩展版本: '0.6.5',
      Creator版本: '3.8.8',
      项目ID: 'project-id',
      项目路径: 'E:/project',
      进程ID: process.pid,
      探针地址: 'ws://127.0.0.1:43210'
    });
    expect(loadDetails.能力数量).toBeTypeOf('number');
    expect(loadDetails.能力数量).toBeGreaterThan(0);

    bridgeMock.options?.onLifecycleEvent?.({ type: 'connecting', url: 'ws://127.0.0.1:43210' });
    bridgeMock.options?.onLifecycleEvent?.({ type: 'socket-open', url: 'ws://127.0.0.1:43210' });
    bridgeMock.options?.onLifecycleEvent?.({ type: 'hello-sent' });
    bridgeMock.options?.onLifecycleEvent?.({ type: 'ready' });
    bridgeMock.options?.onLifecycleEvent?.({
      type: 'disconnected',
      code: 1012,
      reason: '测试重启'
    });
    bridgeMock.options?.onLifecycleEvent?.({
      type: 'retry-scheduled',
      attempt: 2,
      delayMs: 1000
    });
    expect(editorLog).toHaveBeenCalledWith(
      '[CocosAI][Bridge] 正在连接探针服务 {"地址":"ws://127.0.0.1:43210"}'
    );
    expect(editorLog).toHaveBeenCalledWith(
      '[CocosAI][Bridge] 探针连接已建立 {"地址":"ws://127.0.0.1:43210"}'
    );
    expect(editorLog).toHaveBeenCalledWith('[CocosAI][Bridge] 已发送身份握手 {}');
    expect(editorLog).toHaveBeenCalledWith('[CocosAI][Bridge] 扩展初始化完成 {}');
    expect(editorLog).toHaveBeenCalledWith(
      '[CocosAI][Bridge] 探针连接已断开 {"关闭码":1012,"原因":"测试重启"}'
    );
    expect(editorLog).toHaveBeenCalledWith(
      '[CocosAI][Bridge] 已安排重新连接 {"重试次数":2,"等待毫秒":1000}'
    );

    main.unload();
    expect(bridgeMock.dispose).toHaveBeenCalledOnce();
    expect(editorLog).toHaveBeenCalledWith('[CocosAI][Bridge] 扩展已卸载 {}');
  });
});
