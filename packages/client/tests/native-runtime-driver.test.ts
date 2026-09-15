import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  creatorSimulatorCaptureSource,
  creatorSimulatorVideoFilter,
  isCreatorSimulatorOptions,
  launchCreatorSimulatorRuntimeBrowser
} from '../src/native-runtime-driver.js';

afterEach(() => vi.useRealTimers());

describe('Creator Simulator runtime provider', () => {
  it('运行数据复用 Simulator 5086 Inspector', async () => {
    const bridge = {
      status: vi.fn(async () => ({ connected: true, runtimeId: 'sim-runtime-1' })),
      prepareInspector: vi.fn(async () => undefined)
    };
    const inspector = {
      evaluate: vi.fn(async (expression: string) => ({ expression })),
      close: vi.fn()
    };
    const connectInspector = vi.fn(async () => inspector);
    const browser = await launchCreatorSimulatorRuntimeBrowser({}, bridge, connectInspector);
    const page = await browser.newPage();

    await page.goto('creator-simulator://runtime');
    await expect(page.evaluate('1 + 1')).resolves.toEqual({ expression: '1 + 1' });
    await expect(browser.getSessionMetadata?.()).resolves.toMatchObject({
      platform: 'creator-simulator',
      runtimeInstanceId: 'sim-runtime-1',
      runtimeTransport: 'creator-v8-inspector+window-capture'
    });
    expect(bridge.prepareInspector).not.toHaveBeenCalled();
    expect(connectInspector).toHaveBeenCalledWith('sim-runtime-1');
    expect(inspector.evaluate).toHaveBeenCalledWith('1 + 1');
    await browser.close();
    expect(inspector.close).toHaveBeenCalledOnce();
  });

  it('严格校验可选的窗口捕获参数', () => {
    expect(isCreatorSimulatorOptions(undefined)).toBe(true);
    expect(isCreatorSimulatorOptions({ startTimeoutMs: 1000, screenSize: { width: 852, height: 393 } })).toBe(true);
    expect(isCreatorSimulatorOptions({ startTimeoutMs: 0 })).toBe(false);
    expect(isCreatorSimulatorOptions([])).toBe(false);
  });

  it('只在 Inspector 已被 Creator Debugger 占用时关闭一次面板', async () => {
    const bridge = {
      status: vi.fn(async () => ({ connected: true, runtimeId: 'sim-runtime-1' })),
      prepareInspector: vi.fn(async () => undefined)
    };
    const inspector = { evaluate: vi.fn(async () => true), close: vi.fn() };
    const connectInspector = vi.fn()
      .mockRejectedValueOnce(new Error('CREATOR_SIMULATOR_INSPECTOR_TARGET_ATTACHED'))
      .mockRejectedValueOnce(new Error('CREATOR_SIMULATOR_INSPECTOR_TARGET_ATTACHED'))
      .mockResolvedValueOnce(inspector);
    const browser = await launchCreatorSimulatorRuntimeBrowser({ startTimeoutMs: 500 }, bridge, connectInspector);
    const page = await browser.newPage();

    await page.goto('creator-simulator://runtime');

    expect(connectInspector).toHaveBeenCalledTimes(3);
    expect(bridge.prepareInspector).toHaveBeenCalledOnce();
    await browser.close();
  });

  it('并发启动只连接一次 Creator Simulator Inspector', async () => {
    const bridge = {
      status: vi.fn(async () => ({ connected: true, runtimeId: 'sim-runtime-1' })),
      prepareInspector: vi.fn(async () => undefined)
    };
    const inspector = { evaluate: vi.fn(async () => true), close: vi.fn() };
    const connectInspector = vi.fn(async () => inspector);
    const browser = await launchCreatorSimulatorRuntimeBrowser({}, bridge, connectInspector);
    const page = await browser.newPage();

    await Promise.all([
      page.goto('creator-simulator://runtime'),
      browser.getSessionMetadata?.()
    ]);

    expect(connectInspector).toHaveBeenCalledOnce();
    expect(bridge.prepareInspector).not.toHaveBeenCalled();
    await browser.close();
  });

  it('原生窗口帧订阅保持完整 MJPEG 合同，不启用会截断帧的 rawvideo 参数', () => {
    expect(creatorSimulatorCaptureSource('2002', 30))
      .toBe('gfxcapture=hwnd=2002:capture_cursor=false:max_framerate=30');
    expect(creatorSimulatorVideoFilter()).toBe('hwdownload,format=bgra');
    expect(creatorSimulatorVideoFilter({ width: 640, height: 360 }))
      .toBe('hwdownload,format=bgra,scale=640:360');
    expect(() => creatorSimulatorCaptureSource('0', 30)).toThrow('CREATOR_SIMULATOR_WINDOW_HANDLE_INVALID');
    const source = readFileSync(new URL('../src/native-runtime-driver.ts', import.meta.url), 'utf8');
    expect(source).toContain('creatorSimulatorCaptureSource(window.handle, 60)');
    expect(source).toContain("'-vcodec', 'mjpeg'");
    expect(source).not.toContain("'-f', 'rawvideo'");
    expect(source).not.toContain("'-fflags', 'nobuffer'");
    expect(source).not.toContain("'-flush_packets', '1'");
    expect(source).not.toContain("'-flags', 'low_delay'");
  });

  it('Simulator 输入复用 Creator 运行时注入通道', async () => {
    const bridge = {
      status: vi.fn(async () => ({ connected: true, runtimeId: 'sim-runtime-1' }))
    };
    const inspector = {
      evaluate: vi.fn(async (expression: string) => {
        if (expression.includes('__cocosAiDispatchRuntimeInput =')) return true;
        if (expression.startsWith('globalThis.__cocosAiDispatchRuntimeInput(')) {
          return { dispatched: true, inputType: 'pointerdown', x: 100, y: 50, windowId: 1 };
        }
        return 1;
      }),
      close: vi.fn()
    };
    const browser = await launchCreatorSimulatorRuntimeBrowser({}, bridge, async () => inspector);
    const page = await browser.newPage();
    await expect(page.dispatchCanvasInput?.({ inputType: 'pointerdown', x: 100, y: 50, button: 0, buttons: 1 }))
      .resolves.toMatchObject({ dispatched: true, windowId: 1 });
    expect(inspector.evaluate).toHaveBeenNthCalledWith(1, expect.stringContaining('__cocosAiDispatchRuntimeInput ='));
    expect(inspector.evaluate).toHaveBeenNthCalledWith(2, expect.stringContaining('globalThis.__cocosAiDispatchRuntimeInput({"inputType":"pointerdown"'));
    await browser.close();
  });

  it('原生日志按游标交给 RuntimeDriver，停止后不再轮询', async () => {
    vi.useFakeTimers();
    const entry = { seq: 0, level: 'warn', text: 'Cocos 警告', timestamp: '2026-09-12T06:00:00.000Z' };
    const bridge = {
      status: vi.fn(async () => ({ connected: true, runtimeId: 'sim-runtime-1' }))
    };
    const inspector = {
      evaluate: vi.fn(async (expression: string) => expression.includes('readConsole')
        ? { entries: expression.includes('readConsole(0)') ? [entry] : [], nextSeq: 1 }
        : 1),
      close: vi.fn()
    };
    const browser = await launchCreatorSimulatorRuntimeBrowser({}, bridge, async () => inspector);
    const page = await browser.newPage();
    const listener = vi.fn();
    page.onConsole(listener);
    await page.goto('creator-simulator://runtime');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(entry));
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledOnce();
    expect(inspector.evaluate).toHaveBeenCalledWith(expect.stringContaining('readConsole(1)'));
    await browser.close();
    const callCount = inspector.evaluate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(inspector.evaluate).toHaveBeenCalledTimes(callCount);
  });
});
