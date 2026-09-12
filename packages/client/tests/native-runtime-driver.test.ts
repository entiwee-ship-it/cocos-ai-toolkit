import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCreatorSimulatorOptions,
  launchCreatorSimulatorRuntimeBrowser
} from '../src/native-runtime-driver.js';

afterEach(() => vi.useRealTimers());

describe('Creator Simulator runtime provider', () => {
  it('运行数据复用 Preview Bridge，不连接 5086 Inspector', async () => {
    const bridge = {
      status: vi.fn(async () => ({ connected: true, runtimeId: 'sim-runtime-1' })),
      evaluate: vi.fn(async (_runtimeId: string, expression: string) => ({ expression }))
    };
    const browser = await launchCreatorSimulatorRuntimeBrowser({}, bridge);
    const page = await browser.newPage();

    await page.goto('creator-simulator://runtime');
    await expect(page.evaluate('1 + 1')).resolves.toEqual({ expression: '1 + 1' });
    await expect(browser.getSessionMetadata?.()).resolves.toMatchObject({
      platform: 'creator-simulator',
      runtimeInstanceId: 'sim-runtime-1',
      runtimeTransport: 'creator-preview-plugin+loopback-http+window-capture'
    });
    expect(bridge.evaluate).toHaveBeenCalledWith('sim-runtime-1', '1 + 1');
  });

  it('严格校验可选的窗口捕获参数', () => {
    expect(isCreatorSimulatorOptions(undefined)).toBe(true);
    expect(isCreatorSimulatorOptions({ startTimeoutMs: 1000, screenSize: { width: 852, height: 393 } })).toBe(true);
    expect(isCreatorSimulatorOptions({ startTimeoutMs: 0 })).toBe(false);
    expect(isCreatorSimulatorOptions([])).toBe(false);
  });

  it('原生日志按游标交给 RuntimeDriver，停止后不再轮询', async () => {
    vi.useFakeTimers();
    const entry = { seq: 0, level: 'warn', text: 'Cocos 警告', timestamp: '2026-09-12T06:00:00.000Z' };
    const bridge = {
      status: vi.fn(async () => ({ connected: true, runtimeId: 'sim-runtime-1' })),
      evaluate: vi.fn(async (_runtimeId: string, expression: string) => expression.includes('readConsole')
        ? { entries: expression.includes('readConsole(0)') ? [entry] : [], nextSeq: 1 }
        : 1)
    };
    const browser = await launchCreatorSimulatorRuntimeBrowser({}, bridge);
    const page = await browser.newPage();
    const listener = vi.fn();
    page.onConsole(listener);
    await page.goto('creator-simulator://runtime');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining(entry));
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledOnce();
    expect(bridge.evaluate).toHaveBeenCalledWith('sim-runtime-1', expect.stringContaining('readConsole(1)'));
    await browser.close();
    const callCount = bridge.evaluate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.evaluate).toHaveBeenCalledTimes(callCount);
  });
});
