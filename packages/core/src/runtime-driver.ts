import { ConsoleEntrySchema, PreviewSessionSchema, ResolutionSchema, type ConsoleEntry, type PreviewSession, type Resolution } from '@cocos-ai/protocol';

/**
 * 运行态浏览器驱动（阶段五）。
 * 管理工具自 launch 的 Preview 页面会话：浏览器启动、URL 规范化、游戏就绪有界轮询、
 * console 事件缓冲与页面 evaluate 通道。与具体浏览器自动化库解耦（launcher 依赖注入）。
 */

/** 页面侧抽象：与 playwright Page 的最小对齐子集。 */
export interface RuntimeBrowserPage {
  goto(url: string): Promise<void>;
  evaluate<R>(fn: (...args: never[]) => R | Promise<R>, arg?: unknown): Promise<R>;
  onConsole(listener: (entry: { level: string; text: string; stack?: string }) => void): void;
  onPageError(listener: (error: { message: string; stack?: string }) => void): void;
  close(): Promise<void>;
  isClosed(): boolean;
}

/** 浏览器实例抽象。 */
export interface RuntimeBrowser {
  newPage(): Promise<RuntimeBrowserPage>;
  close(): Promise<void>;
}

/** 浏览器启动器：由装配方（Probe Server）以 playwright-core 实现注入。 */
export type RuntimeBrowserLauncher = (options: { channel: string; headless: boolean }) => Promise<RuntimeBrowser>;

export interface RuntimeDriverOptions {
  launcher: RuntimeBrowserLauncher;
  /** 会话 ID 生成器。 */
  createSessionId?: () => string;
  now?: () => Date;
  /** console 环形缓冲容量，默认 1000。 */
  consoleCapacity?: number;
  /** 游戏就绪等待总超时，默认 30000。 */
  readyTimeoutMs?: number;
  /** 游戏就绪轮询间隔，默认 250。 */
  readyPollMs?: number;
}

export interface RuntimeLaunchOptions {
  projectId: string;
  editorInstanceId?: string;
  url: string;
  resolution?: Resolution;
  channel?: string;
}

interface ManagedSession {
  session: PreviewSession;
  browser: RuntimeBrowser;
  page: RuntimeBrowserPage;
  consoleBuffer: ConsoleBuffer;
}

/** console 环形缓冲：容量有限，seq 全局单调递增，支持游标增量与级别过滤。 */
export class ConsoleBuffer {
  private entries: ConsoleEntry[] = [];
  private nextSeqValue = 0;

  constructor(
    private readonly options: { capacity?: number; now?: () => Date } = {}
  ) {}

  /** 追加一条 console 条目，返回分配的游标。 */
  push(entry: { level: string; text: string; stack?: string }): number {
    const capacity = this.options.capacity ?? 1_000;
    const seq = this.nextSeqValue;
    this.nextSeqValue += 1;
    const normalized = ConsoleEntrySchema.parse({
      seq,
      level: normalizeConsoleLevel(entry.level),
      text: entry.text,
      ...(entry.stack ? { stack: entry.stack } : {}),
      timestamp: (this.options.now?.() ?? new Date()).toISOString()
    });
    this.entries.push(normalized);
    if (this.entries.length > capacity) {
      this.entries.splice(0, this.entries.length - capacity);
    }
    return seq;
  }

  /**
   * 读取条目。
   *
   * @param filter sinceSeq 只返回游标之后的增量；level 按级别过滤。
   * @returns 命中条目与当前最新游标（下次增量拉取起点）。
   */
  read(filter: { sinceSeq?: number; level?: ConsoleEntry['level'] }): { entries: ConsoleEntry[]; nextSeq: number } {
    let entries = this.entries;
    if (filter.sinceSeq !== undefined) {
      entries = entries.filter((entry) => entry.seq >= filter.sinceSeq!);
    }
    if (filter.level) {
      entries = entries.filter((entry) => entry.level === filter.level);
    }
    return { entries: [...entries], nextSeq: this.nextSeqValue };
  }
}

/** 把 preview URL 的 host 规范化为本机回环，避免局域网 IP 受代理/网卡干扰。 */
export function normalizePreviewUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('PREVIEW_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PREVIEW_URL_INVALID');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    parsed.hostname = '127.0.0.1';
  }
  return parsed.toString();
}

/** 浏览器通道回退链：默认 chrome 优先、msedge 兜底；显式指定时只尝试指定项。 */
export function resolveChannelChain(preferred?: string): string[] {
  if (preferred) return [preferred];
  return ['chrome', 'msedge'];
}

function normalizeConsoleLevel(level: string): ConsoleEntry['level'] {
  switch (level) {
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    case 'debug':
    case 'verbose':
      return 'debug';
    case 'info':
      return 'info';
    default:
      return 'log';
  }
}

/** 运行态页面会话驱动。 */
export class RuntimeDriver {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(private readonly options: RuntimeDriverOptions) {}

  /**
   * 启动浏览器并打开 preview 页面，等待游戏就绪后返回会话。
   *
   * @param options 启动参数：项目标识、preview URL、可选请求分辨率与浏览器通道。
   * @returns 就绪态会话（含实际生效分辨率）。
   */
  async launch(options: RuntimeLaunchOptions): Promise<PreviewSession> {
    const url = normalizePreviewUrl(options.url);
    const channels = resolveChannelChain(options.channel);
    let browser: RuntimeBrowser | null = null;
    const launchErrors: string[] = [];
    for (const channel of channels) {
      try {
        browser = await this.options.launcher({ channel, headless: false });
        break;
      } catch (error) {
        launchErrors.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!browser) {
      throw new Error(`PREVIEW_BROWSER_LAUNCH_FAILED:${launchErrors.join(';')}`);
    }

    const sessionId = this.options.createSessionId?.() ?? `preview-${Date.now()}`;
    const consoleBuffer = new ConsoleBuffer({
      ...(this.options.consoleCapacity !== undefined ? { capacity: this.options.consoleCapacity } : {}),
      ...(this.options.now ? { now: this.options.now } : {})
    });
    const page = await browser.newPage();
    page.onConsole((entry) => consoleBuffer.push(entry));
    page.onPageError((error) => consoleBuffer.push({ level: 'error', text: error.message, ...(error.stack ? { stack: error.stack } : {}) }));

    const managed: ManagedSession = {
      session: PreviewSessionSchema.parse({
        sessionId,
        projectId: options.projectId,
        ...(options.editorInstanceId ? { editorInstanceId: options.editorInstanceId } : {}),
        url,
        pageSource: 'self-launched',
        state: 'launching',
        ...(options.resolution ? { requestedResolution: options.resolution } : {}),
        launchedAt: (this.options.now?.() ?? new Date()).toISOString()
      }),
      browser,
      page,
      consoleBuffer
    };
    this.sessions.set(sessionId, managed);

    try {
      await page.goto(url);
      await this.waitGameReady(managed);
      if (options.resolution) {
        const { setRuntimeResolution } = await import('./runtime-inject.js');
        managed.session.actualResolution = ResolutionSchema.parse(
          await page.evaluate(setRuntimeResolution as never, options.resolution)
        );
      } else {
        const { readRuntimeResolution } = await import('./runtime-inject.js');
        managed.session.actualResolution = ResolutionSchema.parse(
          await page.evaluate(readRuntimeResolution as never, undefined as never)
        );
      }
      managed.session.state = 'ready';
      return { ...managed.session };
    } catch (error) {
      this.sessions.delete(sessionId);
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  /** 关闭会话页面并标记 closed（会话记录保留供审计）。 */
  async close(sessionId: string): Promise<{ closed: true }> {
    const managed = this.requireSession(sessionId);
    if (managed.session.state !== 'closed') {
      await managed.page.close().catch(() => undefined);
      await managed.browser.close().catch(() => undefined);
      managed.session.state = 'closed';
    }
    return { closed: true };
  }

  /** 读取会话当前状态；页面被外部关闭时标记 lost。 */
  get(sessionId: string): PreviewSession {
    const managed = this.requireSession(sessionId);
    this.syncLostState(managed);
    return { ...managed.session };
  }

  /** 列出会话，可按项目过滤。 */
  list(projectId?: string): PreviewSession[] {
    const sessions: PreviewSession[] = [];
    for (const managed of this.sessions.values()) {
      this.syncLostState(managed);
      if (projectId && managed.session.projectId !== projectId) continue;
      sessions.push({ ...managed.session });
    }
    return sessions;
  }

  /**
   * 页面 evaluate 通道：把自包含函数注入页面执行。
   *
   * @param sessionId 目标会话。
   * @param fn 页面内执行的函数（不得引用 Node 侧闭包）。
   * @param arg 传给函数的唯一参数。
   * @returns 函数在页面内的返回值。
   */
  async evaluate<R>(sessionId: string, fn: (...args: never[]) => R | Promise<R>, arg?: unknown): Promise<R> {
    const managed = this.requireSession(sessionId);
    if (managed.session.state === 'closed') {
      throw new Error('PREVIEW_SESSION_CLOSED');
    }
    if (this.syncLostState(managed)) {
      throw new Error('PREVIEW_SESSION_LOST');
    }
    try {
      return await managed.page.evaluate(fn, arg);
    } catch (error) {
      if (managed.page.isClosed()) {
        managed.session.state = 'lost';
        throw new Error('PREVIEW_SESSION_LOST');
      }
      throw error;
    }
  }

  /** 读取会话 console 缓冲。 */
  readConsole(sessionId: string, filter: { sinceSeq?: number; level?: ConsoleEntry['level'] }): { entries: ConsoleEntry[]; nextSeq: number } {
    const managed = this.requireSession(sessionId);
    return managed.consoleBuffer.read(filter);
  }

  /** 关闭全部会话与浏览器。 */
  async dispose(): Promise<void> {
    for (const managed of this.sessions.values()) {
      await managed.browser.close().catch(() => undefined);
      managed.session.state = 'closed';
    }
  }

  /** 游戏就绪有界轮询：注入探测脚本直至场景出现或超时。 */
  private async waitGameReady(managed: ManagedSession): Promise<void> {
    const timeoutMs = this.options.readyTimeoutMs ?? 30_000;
    const pollMs = this.options.readyPollMs ?? 250;
    const { probeGameReady } = await import('./runtime-inject.js');
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const state = await managed.page.evaluate(probeGameReady as never, undefined as never) as { ready?: boolean };
      if (state?.ready) return;
      if (Date.now() >= deadline) throw new Error('PREVIEW_GAME_NOT_READY');
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
  }

  private requireSession(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error('PREVIEW_SESSION_NOT_FOUND');
    return managed;
  }

  /** 页面被外部关闭时同步 lost 状态；返回是否 lost。 */
  private syncLostState(managed: ManagedSession): boolean {
    if (managed.session.state !== 'closed' && managed.page.isClosed()) {
      managed.session.state = 'lost';
    }
    return managed.session.state === 'lost';
  }
}
