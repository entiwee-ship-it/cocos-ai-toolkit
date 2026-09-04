import type { Browser, Page } from 'playwright-core';
import type { RuntimeBrowser, RuntimeBrowserPage } from '@cocos-ai/core';

/** 使用系统 Chrome/Edge 启动 Preview，不下载额外浏览器。 */
export async function launchPlaywrightBrowser(options: {
  channel: string;
  headless: boolean;
}): Promise<RuntimeBrowser> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: options.channel, headless: options.headless });
  return {
    async newPage(): Promise<RuntimeBrowserPage> {
      return wrapPage(await browser.newPage());
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
    evaluate<R>(fn: ((...args: never[]) => R | Promise<R>) | string, arg?: unknown): Promise<R> {
      return page.evaluate(fn as never, arg as never) as Promise<R>;
    },
    onConsole(listener): void {
      page.on('console', (message) => {
        const location = message.location();
        listener({
          level: message.type(),
          text: message.text(),
          ...(location?.url
            ? { stack: `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}` }
            : {})
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
      if (!element) throw new Error('GAME_CANVAS_NOT_FOUND');
      return element.screenshot({ type: 'png' }) as Promise<Buffer>;
    }
  };
}
