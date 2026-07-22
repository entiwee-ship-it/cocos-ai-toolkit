import { chromium, type Browser, type Page } from 'playwright-core';
import type { RuntimeBrowser, RuntimeBrowserPage } from '@cocos-ai/core';

/**
 * playwright-core 浏览器启动器：使用系统已安装的 Chrome/Edge（channel 机制），
 * 不下载浏览器二进制。把 playwright 的 Browser/Page 适配为 runtime-driver 的最小抽象。
 *
 * @param options channel 浏览器通道（chrome/msedge）；headless 是否无头（preview 验证需要有头截图语义一致，默认有头）。
 * @returns 适配后的浏览器实例。
 */
export async function launchPlaywrightBrowser(options: { channel: string; headless: boolean }): Promise<RuntimeBrowser> {
  const browser = await chromium.launch({ channel: options.channel, headless: options.headless });
  return wrapBrowser(browser);
}

function wrapBrowser(browser: Browser): RuntimeBrowser {
  return {
    async newPage(): Promise<RuntimeBrowserPage> {
      const page = await browser.newPage();
      return wrapPage(page);
    },
    async close(): Promise<void> {
      await browser.close();
    }
  };
}

function wrapPage(page: Page): RuntimeBrowserPage {
  return {
    async goto(url: string): Promise<void> {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    evaluate<R>(fn: (...args: never[]) => R | Promise<R>, arg?: unknown): Promise<R> {
      return page.evaluate(fn as never, arg as never) as Promise<R>;
    },
    onConsole(listener): void {
      page.on('console', (message) => {
        const location = message.location();
        listener({
          level: message.type(),
          text: message.text(),
          ...(location?.url ? { stack: `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}` } : {})
        });
      });
    },
    onPageError(listener): void {
      page.on('pageerror', (error) => {
        listener({ message: error.message, ...(error.stack ? { stack: error.stack } : {}) });
      });
    },
    async close(): Promise<void> {
      await page.close();
    },
    isClosed(): boolean {
      return page.isClosed();
    },
    async mouseClick(x: number, y: number): Promise<void> {
      await page.mouse.click(x, y);
    },
    async keyPress(key: string): Promise<void> {
      await page.keyboard.press(key);
    },
    async setViewportSize(size: { width: number; height: number }): Promise<void> {
      await page.setViewportSize(size);
    },
    async screenshotElement(selector: string): Promise<Buffer> {
      const element = await page.waitForSelector(selector, { timeout: 5_000 });
      if (!element) {
        throw new Error('GAME_CANVAS_NOT_FOUND');
      }
      return element.screenshot({ type: 'png' }) as Promise<Buffer>;
    }
  };
}
