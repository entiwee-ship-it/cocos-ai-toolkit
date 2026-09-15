import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeDriver } from '@cocos-ai/core';
import { RuntimeController } from '../src/runtime-controller.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RuntimeController', () => {
  it('原生 Inspector 先解析注册身份，再采集精确字段，并在只读字段写入前停止', async () => {
    const driver = fakeDriver();
    driver.evaluate
      .mockResolvedValueOnce({ found: true, inspectorClassName: 'cc.Component' })
      .mockResolvedValueOnce({ found: true, nodeUuid: 'node-1', properties: { enabled: true }, writable: { enabled: true }, showEnabled: true });
    const requestCreator = vi.fn()
      .mockResolvedValueOnce({ propertyNames: ['enabled'] })
      .mockResolvedValueOnce({ componentType: 'cc.Component', properties: { enabled: true }, propertyMeta: { enabled: { kind: 'boolean', editable: false, visible: false } }, inspectorSource: 'creator', showEnabled: true });
    const controller = new RuntimeController({ captureRoot: await tempRoot(), requestCreator, driver: driver as unknown as RuntimeDriver });
    const result = await controller.request('server.runtimeComponent', { sessionId: 'session-1', path: '/main/manager', componentType: 'TimerManager', inspector: true });
    expect(requestCreator.mock.calls[0][2]).toEqual({ runtimeInspector: { componentType: 'cc.Component' } });
    expect(requestCreator.mock.calls[1][2].runtimeInspector.values).toEqual({ enabled: true });
    expect(result).toMatchObject({ componentType: 'TimerManager', inspectorSource: 'creator', showEnabled: true });
    driver.evaluate.mockClear();
    driver.evaluate
      .mockResolvedValueOnce({ found: true, inspectorClassName: 'cc.Component' })
      .mockResolvedValueOnce({ found: true, nodeUuid: 'node-1', properties: { enabled: true }, writable: { enabled: true } });
    requestCreator.mockResolvedValueOnce({ propertyNames: ['enabled'] }).mockResolvedValueOnce(result);
    await expect(controller.request('server.runtimeSetProperty', { sessionId: 'session-1', path: '/main/manager', componentType: 'TimerManager', inspector: true, property: 'enabled', value: false })).rejects.toThrow('只读');
    expect(driver.evaluate).toHaveBeenCalledTimes(2);
  });

  it('Preview URL 通过 Creator 短连接获取，会话由当前进程内 driver 管理', async () => {
    const captureRoot = await tempRoot();
    const requestCreator = vi.fn(async () => ({ url: 'http://127.0.0.1:7456' }));
    const driver = fakeDriver();
    const controller = new RuntimeController({
      captureRoot,
      requestCreator,
      driver: driver as unknown as RuntimeDriver
    });

    const launched = await controller.request('server.previewLaunch', {
      selector: { projectId: 'project-1', editorInstanceId: 'editor-1' },
      params: { resolution: { width: 720, height: 1280 }, channel: 'chrome' }
    });
    expect(requestCreator).toHaveBeenCalledWith(
      { projectId: 'project-1', editorInstanceId: 'editor-1' },
      'probe.previewOpen',
      {}
    );
    expect(driver.launch).toHaveBeenCalledWith({
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      url: 'http://127.0.0.1:7456',
      resolution: { width: 720, height: 1280 },
      channel: 'chrome'
    });
    expect(launched).toMatchObject({ sessionId: 'session-1', state: 'ready' });
    expect(await controller.request('server.previewSessions', {})).toEqual([
      expect.objectContaining({ sessionId: 'session-1' })
    ]);
    await controller.dispose();
    expect(driver.dispose).toHaveBeenCalledOnce();
  });

  it('截图由当前进程落盘并返回真实文件路径', async () => {
    const captureRoot = await tempRoot();
    const driver = fakeDriver();
    const controller = new RuntimeController({
      captureRoot,
      requestCreator: vi.fn(),
      driver: driver as unknown as RuntimeDriver
    });
    const result = await controller.request('server.runtimeCapture', {
      sessionId: 'session-1',
      resolution: { width: 320, height: 180 }
    }) as { files: Array<{ path: string; width: number; height: number }> };
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ width: 320, height: 180 });
    expect(await readFile(result.files[0].path, 'utf8')).toBe('png-data');
  });

  it('场景 launch/stop 在同一控制器中完成，不依赖跨进程会话服务', async () => {
    const captureRoot = await tempRoot();
    const requestCreator = vi.fn(async () => ({ url: 'http://127.0.0.1:7456' }));
    const driver = fakeDriver();
    const controller = new RuntimeController({
      captureRoot,
      requestCreator,
      driver: driver as unknown as RuntimeDriver
    });
    const report = await controller.request('server.runtimeRunScenario', {
      selector: { projectId: 'project-1' },
      steps: [{ kind: 'launch' }, { kind: 'stop', always: true }]
    }) as { passed: boolean; steps: Array<{ passed: boolean }> };
    expect(report.passed).toBe(true);
    expect(report.steps).toHaveLength(2);
    expect(driver.launch).toHaveBeenCalledOnce();
    expect(driver.close).toHaveBeenCalledWith('session-1');
  });

  it('Creator 第三项模拟器先由 Creator 启动，再绑定同一运行会话', async () => {
    const captureRoot = await tempRoot();
    const requestCreator = vi.fn(async () => ({ opened: true }));
    const driver = fakeDriver();
    const controller = new RuntimeController({
      captureRoot,
      requestCreator,
      driver: driver as unknown as RuntimeDriver
    });

    await controller.request('server.previewLaunch', {
      selector: { projectId: 'project-1', editorInstanceId: 'editor-1' },
      params: { platform: 'creator-simulator' }
    });
    expect(requestCreator).toHaveBeenCalledWith(
      { projectId: 'project-1', editorInstanceId: 'editor-1' },
      'probe.simulatorRuntimeStatus',
      {}
    );
    expect(requestCreator).toHaveBeenCalledWith(
      { projectId: 'project-1', editorInstanceId: 'editor-1' },
      'probe.simulatorOpen',
      {}
    );
    expect(driver.launch).toHaveBeenCalledWith({
      projectId: 'project-1',
      editorInstanceId: 'editor-1',
      platform: 'creator-simulator',
      native: undefined
    });
  });

  it('已有健康 Simulator 时直接附着，不重复 open-terminal', async () => {
    const captureRoot = await tempRoot();
    const requestCreator = vi.fn(async (_selector, method) => (
      method === 'probe.simulatorRuntimeStatus'
        ? { connected: true, runtimeId: 'sim-1' }
        : { opened: true }
    ));
    const driver = fakeDriver();
    const controller = new RuntimeController({
      captureRoot,
      requestCreator,
      driver: driver as unknown as RuntimeDriver
    });

    await controller.request('server.previewLaunch', {
      selector: { projectId: 'project-1' },
      params: { platform: 'creator-simulator' }
    });
    expect(requestCreator.mock.calls.some((call) => call[1] === 'probe.simulatorOpen')).toBe(false);
    expect(driver.launch).toHaveBeenCalledOnce();
  });

  it('Workbench 完整输入复用公开运行时派发入口', async () => {
    const driver = fakeDriver();
    const controller = new RuntimeController({
      captureRoot: await tempRoot(),
      requestCreator: vi.fn(),
      driver: driver as unknown as RuntimeDriver
    });
    await controller.request('server.runtimeDispatchInput', {
      sessionId: 'session-1', inputType: 'pointerdown', x: 100, y: 50, button: 0, buttons: 1
    });
    expect(driver.dispatchInput).toHaveBeenCalledWith('session-1', {
      inputType: 'pointerdown', x: 100, y: 50, button: 0, buttons: 1
    });
  });

  it('实时节点树只在 revision 或 sceneEpoch 变化时推送', async () => {
    const captureRoot = await tempRoot();
    const driver = fakeDriver();
    driver.evaluate
      .mockResolvedValueOnce(runtimeTree(1, 1))
      .mockResolvedValueOnce(runtimeTree(1, 1))
      .mockResolvedValueOnce(runtimeTree(2, 1));
    const controller = new RuntimeController({
      captureRoot,
      requestCreator: vi.fn(),
      driver: driver as unknown as RuntimeDriver
    });
    const received: number[] = [];
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const stop = await controller.streamRuntimeHierarchy('session-1', (snapshot) => {
      received.push(snapshot.revision ?? -1);
      if (received.length === 2) release();
    }, { intervalMs: 50 });

    await ready;
    await stop();
    expect(received).toEqual([1, 2]);
    expect(driver.evaluate).toHaveBeenCalledTimes(3);
  });
});

function fakeDriver() {
  const session = {
    sessionId: 'session-1',
    projectId: 'project-1',
    editorInstanceId: 'editor-1',
    url: 'http://127.0.0.1:7456',
    pageSource: 'self-launched',
    state: 'ready',
    launchedAt: new Date().toISOString(),
    actualResolution: { width: 320, height: 180 }
  };
  return {
    launch: vi.fn(async () => ({ ...session })),
    close: vi.fn(async () => ({ closed: true as const })),
    list: vi.fn(() => [{ ...session }]),
    get: vi.fn(() => ({ ...session })),
    evaluate: vi.fn(async () => ({})),
    readConsole: vi.fn(() => ({ entries: [], nextSeq: 0 })),
    dispatchInput: vi.fn(async () => ({ dispatched: true, inputType: 'tap' })),
    capture: vi.fn(async () => ({
      buffer: Buffer.from('png-data'),
      width: 320,
      height: 180,
      actualResolution: { width: 320, height: 180 }
    })),
    dispose: vi.fn(async () => undefined)
  };
}

function runtimeTree(revision: number, sceneEpoch: number) {
  return {
    uuid: 'scene-uuid',
    name: 'main',
    path: '/main~0',
    active: true,
    dynamic: false,
    components: [],
    sceneUuid: 'scene-uuid',
    sceneEpoch,
    revision,
    nodeCount: 1
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cocos-ai-runtime-controller-'));
  roots.push(root);
  return root;
}
