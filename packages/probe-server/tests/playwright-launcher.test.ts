import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('playwright-core');
  vi.resetModules();
});

describe('launchPlaywrightBrowser', () => {
  it('冷启动不加载 playwright-core，首次 launch 才加载且后续复用模块缓存', async () => {
    let moduleLoads = 0;
    const launchOptions: unknown[] = [];
    const closedBrowsers: number[] = [];

    vi.doMock('playwright-core', () => {
      moduleLoads += 1;
      return {
        chromium: {
          launch: async (options: unknown) => {
            const browserIndex = launchOptions.push(options);
            return {
              async newPage() {
                throw new Error('not needed');
              },
              async close() {
                closedBrowsers.push(browserIndex);
              }
            };
          }
        }
      };
    });

    const { launchPlaywrightBrowser } = await import('../src/playwright-launcher.js');
    expect(moduleLoads).toBe(0);

    const first = await launchPlaywrightBrowser({ channel: 'chrome', headless: true });
    const second = await launchPlaywrightBrowser({ channel: 'msedge', headless: false });
    await first.close();
    await second.close();

    expect(moduleLoads).toBe(1);
    expect(launchOptions).toEqual([
      { channel: 'chrome', headless: true },
      { channel: 'msedge', headless: false }
    ]);
    expect(closedBrowsers).toEqual([1, 2]);
  });
});
