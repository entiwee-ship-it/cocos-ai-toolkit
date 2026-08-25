import { describe, expect, it } from 'vitest';
import {
  ConsoleBuffer,
  normalizePreviewUrl,
  resolveChannelChain,
  RuntimeDriver,
  type RuntimeBrowser,
  type RuntimeBrowserPage
} from '../src/runtime-driver.js';

/** 构造可编排就绪序列与分辨率的假页面。 */
function createFakePage(options: {
  readyAfterCalls?: number;
  actualResolution?: { width: number; height: number };
  onEvaluate?: (fn: (...args: never[]) => unknown) => void;
} = {}) {
  const state = {
    evaluateCalls: 0,
    gotoUrls: [] as string[],
    closed: false,
    viewport: null as null | { width: number; height: number },
    consoleListeners: [] as Array<(entry: { level: string; text: string; stack?: string }) => void>,
    pageErrorListeners: [] as Array<(error: { message: string; stack?: string }) => void>
  };
  const page: RuntimeBrowserPage = {
    async goto(url: string) {
      state.gotoUrls.push(url);
    },
    async evaluate(fn: (...args: never[]) => unknown) {
      state.evaluateCalls += 1;
      options.onEvaluate?.(fn);
      // 模拟游戏就绪探测：前 readyAfterCalls 次返回未就绪
      if (state.evaluateCalls <= (options.readyAfterCalls ?? 0)) {
        return { ready: false } as never;
      }
      const actual = options.actualResolution ?? { width: 960, height: 640 };
      return {
        ready: true,
        sceneName: 'main',
        childCount: 1,
        width: actual.width,
        height: actual.height
      } as never;
    },
    onConsole(listener) {
      state.consoleListeners.push(listener);
    },
    onPageError(listener) {
      state.pageErrorListeners.push(listener);
    },
    async close() {
      state.closed = true;
    },
    isClosed() {
      return state.closed;
    },
    async mouseClick() {},
    async keyPress() {},
    async setViewportSize(size: { width: number; height: number }) {
      state.viewport = size;
    },
    async screenshotElement() {
      return Buffer.alloc(0);
    }
  };
  return { page, state };
}

function createFakeBrowser(page: RuntimeBrowserPage): RuntimeBrowser & { closed: boolean } {
  const browser = {
    closed: false,
    async newPage() {
      return page;
    },
    async close() {
      browser.closed = true;
    }
  };
  return browser;
}

describe('normalizePreviewUrl', () => {
  it('把局域网 IP 改写为 127.0.0.1 并保留端口与路径', () => {
    expect(normalizePreviewUrl('http://192.168.1.23:7457/')).toBe('http://127.0.0.1:7457/');
    expect(normalizePreviewUrl('http://192.168.1.23:7457/index.html?x=1')).toBe('http://127.0.0.1:7457/index.html?x=1');
  });

  it('已是本机地址时保持不变', () => {
    expect(normalizePreviewUrl('http://127.0.0.1:7457/')).toBe('http://127.0.0.1:7457/');
    expect(normalizePreviewUrl('http://localhost:7457/')).toBe('http://localhost:7457/');
  });

  it('拒绝非 http 协议', () => {
    expect(() => normalizePreviewUrl('file:///tmp/a.html')).toThrow();
    expect(() => normalizePreviewUrl('not-a-url')).toThrow();
  });
});

describe('resolveChannelChain', () => {
  it('默认 chrome 优先、msedge 兜底', () => {
    expect(resolveChannelChain()).toEqual(['chrome', 'msedge']);
  });

  it('显式指定时只尝试指定通道', () => {
    expect(resolveChannelChain('msedge')).toEqual(['msedge']);
  });
});

describe('RuntimeDriver', () => {
  it('launch 返回 ready 会话并规范化 URL', async () => {
    const { page, state } = createFakePage();
    const driver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(page),
      now: () => new Date('2026-07-22T05:00:00.000Z'),
      createSessionId: () => 's1'
    });
    const session = await driver.launch({
      projectId: 'proj1',
      url: 'http://192.168.1.23:7457/'
    });
    expect(session).toMatchObject({
      sessionId: 's1',
      projectId: 'proj1',
      url: 'http://127.0.0.1:7457/',
      pageSource: 'self-launched',
      state: 'ready',
      launchedAt: '2026-07-22T05:00:00.000Z'
    });
    expect(state.gotoUrls).toEqual(['http://127.0.0.1:7457/']);
    await driver.dispose();
  });

  it('首个浏览器通道失败时回退到下一通道', async () => {
    const { page } = createFakePage();
    const tried: string[] = [];
    const driver = new RuntimeDriver({
      launcher: async ({ channel }) => {
        tried.push(channel);
        if (channel === 'chrome') throw new Error('chrome missing');
        return createFakeBrowser(page);
      },
      createSessionId: () => 's2'
    });
    const session = await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });
    expect(tried).toEqual(['chrome', 'msedge']);
    expect(session.state).toBe('ready');
    await driver.dispose();
  });

  it('全部通道失败时抛出启动失败', async () => {
    const driver = new RuntimeDriver({
      launcher: async () => {
        throw new Error('no browser');
      }
    });
    await expect(driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' }))
      .rejects.toThrow('PREVIEW_BROWSER_LAUNCH_FAILED');
  });

  it('newPage 失败时关闭已启动浏览器', async () => {
    const browser = {
      closed: false,
      async newPage(): Promise<RuntimeBrowserPage> {
        throw new Error('new page failed');
      },
      async close() {
        browser.closed = true;
      }
    };
    const driver = new RuntimeDriver({ launcher: async () => browser });

    await expect(driver.launch({ projectId: 'proj1', url: 'http://127.0.0.1:7457/' }))
      .rejects.toThrow('new page failed');
    expect(browser.closed).toBe(true);
  });

  it('launch 初始化失败时同时关闭页面和浏览器', async () => {
    const { page, state } = createFakePage();
    page.goto = async () => {
      throw new Error('goto failed');
    };
    const browser = createFakeBrowser(page);
    const driver = new RuntimeDriver({ launcher: async () => browser, createSessionId: () => 'goto-failure' });

    await expect(driver.launch({ projectId: 'proj1', url: 'http://127.0.0.1:7457/' }))
      .rejects.toThrow('goto failed');
    expect(state.closed).toBe(true);
    expect(browser.closed).toBe(true);
  });

  it('重复会话 ID 拒绝覆盖旧会话并清理新浏览器', async () => {
    const first = createFakePage();
    const second = createFakePage();
    const firstBrowser = createFakeBrowser(first.page);
    const secondBrowser = createFakeBrowser(second.page);
    const browsers = [firstBrowser, secondBrowser];
    const driver = new RuntimeDriver({
      launcher: async () => browsers.shift()!,
      createSessionId: () => 'same-session'
    });

    await driver.launch({ projectId: 'proj1', url: 'http://127.0.0.1:7457/' });
    await expect(driver.launch({ projectId: 'proj1', url: 'http://127.0.0.1:7457/' }))
      .rejects.toThrow('PREVIEW_SESSION_ID_CONFLICT');
    expect(driver.get('same-session').state).toBe('ready');
    expect(firstBrowser.closed).toBe(false);
    expect(secondBrowser.closed).toBe(true);
    await driver.dispose();
  });

  it('游戏就绪采用有界轮询而非固定延时，超时抛出未就绪', async () => {
    const { page, state } = createFakePage({ readyAfterCalls: 3 });
    const driver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(page),
      createSessionId: () => 's3',
      readyPollMs: 1
    });
    await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });
    expect(state.evaluateCalls).toBeGreaterThanOrEqual(4);
    await driver.dispose();

    const slowDriver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(createFakePage({ readyAfterCalls: 999 }).page),
      readyTimeoutMs: 20,
      readyPollMs: 1
    });
    await expect(slowDriver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' }))
      .rejects.toThrow('PREVIEW_GAME_NOT_READY');
    await slowDriver.dispose();
  });

  it('会话回传实际生效分辨率而非请求值', async () => {
    const { page } = createFakePage({ actualResolution: { width: 720, height: 826 } });
    const driver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(page),
      createSessionId: () => 's4'
    });
    const session = await driver.launch({
      projectId: 'proj1',
      url: 'http://192.168.1.23:7457/',
      resolution: { width: 720, height: 1280 }
    });
    expect(session.requestedResolution).toEqual({ width: 720, height: 1280 });
    expect(session.actualResolution).toEqual({ width: 720, height: 826 });
    await driver.dispose();
  });

  it('launch 指定分辨率时先放大视口容纳工具栏（与 capture 一致）', async () => {
    const { page, state } = createFakePage({ actualResolution: { width: 1280, height: 720 } });
    const driver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(page),
      createSessionId: () => 's4b'
    });
    await driver.launch({
      projectId: 'proj1',
      url: 'http://192.168.1.23:7457/',
      resolution: { width: 1280, height: 720 }
    });
    expect(state.viewport).toEqual({ width: 1480, height: 920 });
    await driver.dispose();
  });

  it('console 事件进入缓冲并支持游标增量与级别过滤', async () => {
    const { page, state } = createFakePage();
    const driver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(page),
      createSessionId: () => 's5',
      now: () => new Date('2026-07-22T05:00:00.000Z')
    });
    await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });
    expect(state.consoleListeners).toHaveLength(1);
    state.consoleListeners[0]({ level: 'log', text: 'hello' });
    state.consoleListeners[0]({ level: 'error', text: 'boom', stack: 'at x' });
    state.pageErrorListeners[0]({ message: 'page crashed', stack: 'at y' });

    const first = driver.readConsole('s5', {});
    expect(first.entries.map((entry) => entry.text)).toEqual(['hello', 'boom', 'page crashed']);
    expect(first.entries[1]).toMatchObject({ level: 'error', stack: 'at x' });
    expect(first.entries[0].seq).toBe(0);

    state.consoleListeners[0]({ level: 'warn', text: 'later' });
    const incremental = driver.readConsole('s5', { sinceSeq: first.nextSeq });
    expect(incremental.entries.map((entry) => entry.text)).toEqual(['later']);

    const errorsOnly = driver.readConsole('s5', { level: 'error' });
    expect(errorsOnly.entries.map((entry) => entry.text)).toEqual(['boom', 'page crashed']);
    await driver.dispose();
  });

  it('close 关闭页面并拒绝后续 evaluate', async () => {
    const { page, state } = createFakePage();
    const driver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(page),
      createSessionId: () => 's6'
    });
    await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });
    await driver.close('s6');
    expect(state.closed).toBe(true);
    expect(driver.get('s6').state).toBe('closed');
    await expect(driver.evaluate('s6', (() => 1) as never)).rejects.toThrow('PREVIEW_SESSION_CLOSED');
    await driver.dispose();
  });

  it('close 在页面或浏览器关闭失败时显式报错且不伪造 closed', async () => {
    for (const failure of ['page', 'browser'] as const) {
      const { page } = createFakePage();
      const browser = createFakeBrowser(page);
      if (failure === 'page') {
        page.close = async () => {
          throw new Error('page close failed');
        };
      } else {
        browser.close = async () => {
          throw new Error('browser close failed');
        };
      }
      const sessionId = `close-failure-${failure}`;
      const driver = new RuntimeDriver({
        launcher: async () => browser,
        createSessionId: () => sessionId
      });
      await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });

      await expect(driver.close(sessionId)).rejects.toThrow('PREVIEW_CLOSE_FAILED');
      expect(driver.get(sessionId).state).not.toBe('closed');
      await driver.dispose().catch(() => undefined);
    }
  });

  it('close 会聚合页面和浏览器的双重关闭错误', async () => {
    const { page } = createFakePage();
    page.close = async () => {
      throw new Error('page close failed');
    };
    const browser = createFakeBrowser(page);
    browser.close = async () => {
      throw new Error('browser close failed');
    };
    const driver = new RuntimeDriver({
      launcher: async () => browser,
      createSessionId: () => 'close-double-failure'
    });
    await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });

    await expect(driver.close('close-double-failure')).rejects.toThrow(/PREVIEW_CLOSE_FAILED:.*page:.*browser:/);
    expect(driver.get('close-double-failure').state).not.toBe('closed');
    await driver.dispose().catch(() => undefined);
  });

  it('dispose 会继续关闭其他会话，汇总失败且不伪造失败会话为 closed', async () => {
    const first = createFakePage();
    const second = createFakePage();
    const firstBrowser = createFakeBrowser(first.page);
    const secondBrowser = createFakeBrowser(second.page);
    firstBrowser.close = async () => {
      throw new Error('browser close failed');
    };
    const browsers = [firstBrowser, secondBrowser];
    const sessionIds = ['dispose-failure', 'dispose-success'];
    const driver = new RuntimeDriver({
      launcher: async () => browsers.shift()!,
      createSessionId: () => sessionIds.shift()!
    });
    await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });
    await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });

    await expect(driver.dispose()).rejects.toThrow(/PREVIEW_DISPOSE_FAILED:.*dispose-failure:.*browser close failed/);
    expect(driver.get('dispose-failure').state).not.toBe('closed');
    expect(driver.get('dispose-success').state).toBe('closed');
    expect(second.state.closed).toBe(true);
    await driver.dispose().catch(() => undefined);
  });

  it('页面异常断开时会话标记 lost 并拒绝读写', async () => {
    const { page, state } = createFakePage();
    const driver = new RuntimeDriver({
      launcher: async () => createFakeBrowser(page),
      createSessionId: () => 's7'
    });
    await driver.launch({ projectId: 'proj1', url: 'http://192.168.1.23:7457/' });
    state.closed = true; // 模拟页面被外部关闭
    await expect(driver.evaluate('s7', (() => 1) as never)).rejects.toThrow('PREVIEW_SESSION_LOST');
    expect(driver.get('s7').state).toBe('lost');
    await driver.dispose();
  });

  it('未知会话抛出明确错误', async () => {
    const driver = new RuntimeDriver({ launcher: async () => createFakeBrowser(createFakePage().page) });
    expect(() => driver.get('missing')).toThrow('PREVIEW_SESSION_NOT_FOUND');
    await driver.dispose();
  });
});

describe('ConsoleBuffer', () => {
  it('超出容量时丢弃最旧条目且游标保持单调', () => {
    const buffer = new ConsoleBuffer({ capacity: 3, now: () => new Date('2026-07-22T05:00:00.000Z') });
    for (let index = 0; index < 5; index += 1) {
      buffer.push({ level: 'log', text: `m${index}` });
    }
    const { entries, nextSeq } = buffer.read({});
    expect(entries.map((entry) => entry.text)).toEqual(['m2', 'm3', 'm4']);
    expect(entries[0].seq).toBe(2);
    expect(nextSeq).toBe(5);
  });
});
