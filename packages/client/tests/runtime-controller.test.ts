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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cocos-ai-runtime-controller-'));
  roots.push(root);
  return root;
}
