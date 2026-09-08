import { describe, expect, it, vi } from 'vitest';
import {
  isCreatorSimulatorOptions,
  launchCreatorSimulatorRuntimeBrowser
} from '../src/native-runtime-driver.js';

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
});

