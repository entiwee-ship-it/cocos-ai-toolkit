import { ConsoleEntrySchema, PreviewSessionSchema, ResolutionSchema, type ConsoleEntry, type PreviewSession, type Resolution } from '@cocos-ai/protocol';

/**
 * 运行态浏览器驱动（阶段五）。
 * 管理工具自 launch 的 Preview 页面会话：浏览器启动、URL 规范化、游戏就绪有界轮询、
 * console 事件缓冲与页面 evaluate 通道。与具体浏览器自动化库解耦（launcher 依赖注入）。
 */

/** 页面侧抽象：与 playwright Page 的最小对齐子集。 */
export interface RuntimeBrowserPage {
  goto(url: string): Promise<void>;
  evaluate<R>(fn: ((...args: never[]) => R | Promise<R>) | string, arg?: unknown): Promise<R>;
  onConsole(listener: (entry: { level: string; text: string; stack?: string }) => void): void;
  onPageError(listener: (error: { message: string; stack?: string }) => void): void;
  close(): Promise<void>;
  isClosed(): boolean;
  /** 页面坐标点击（CSS 像素，viewport 坐标系）。 */
  mouseClick(x: number, y: number): Promise<void>;
  /** 按键派发（playwright key 名，如 Enter/Escape/a）。 */
  keyPress(key: string): Promise<void>;
  /** 设置视口尺寸（截图前保证画布完整可见）。 */
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  /** 截取指定元素（CSS 选择器）的 PNG 图像。 */
  screenshotElement(selector: string): Promise<Buffer>;
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

/** 输入描述：tap/click 为画布内坐标点击，key 为按键。 */
export interface RuntimeDispatchInput {
  inputType: 'tap' | 'click' | 'key';
  x?: number;
  y?: number;
  key?: string;
}

/** 输入派发回执。 */
export interface RuntimeDispatchReceipt {
  dispatched: true;
  inputType: string;
  x?: number;
  y?: number;
  pageX?: number;
  pageY?: number;
  key?: string;
}

/** 截图请求：可选分辨率切换、区域裁剪与节点边界/锚点叠加（画布 CSS 像素坐标系）。 */
export interface RuntimeCaptureRequest {
  resolution?: Resolution;
  crop?: { x: number; y: number; width: number; height: number };
  overlay?: {
    nodeBounds?: string[];
    anchors?: string[];
  };
}

/** 截图产物。 */
export interface RuntimeCaptureImage {
  buffer: Buffer;
  width: number;
  height: number;
  actualResolution: Resolution;
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
        // 视口留余量容纳预览页工具栏，与 capture 一致保证请求分辨率精确生效
        await page.setViewportSize({
          width: options.resolution.width + 200,
          height: options.resolution.height + 200
        });
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

  /** 关闭会话页面和浏览器；任一关闭失败都保留非 closed 状态并显式报错。 */
  async close(sessionId: string): Promise<{ closed: true }> {
    const managed = this.requireSession(sessionId);
    if (managed.session.state !== 'closed') {
      const errors: string[] = [];
      try {
        await managed.page.close();
      } catch (error) {
        errors.push(`page:${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await managed.browser.close();
      } catch (error) {
        errors.push(`browser:${error instanceof Error ? error.message : String(error)}`);
      }
      if (errors.length) {
        throw new Error(`PREVIEW_CLOSE_FAILED:${JSON.stringify(errors)}`);
      }
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
   * 页面 evaluate 通道：把自包含函数或打包脚本注入页面执行。
   *
   * @param sessionId 目标会话。
   * @param fn 页面内执行的函数（不得引用 Node 侧闭包）或 buildRuntimeScript 产物。
   * @param arg 传给函数的唯一参数（字符串脚本时忽略）。
   * @returns 函数或脚本在页面内的返回值。
   */
  async evaluate<R>(sessionId: string, fn: ((...args: never[]) => R | Promise<R>) | string, arg?: unknown): Promise<R> {
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

  /**
   * 输入模拟：坐标语义为**画布内 CSS 像素**（左上角原点），driver 按画布包围盒
   * 换算为页面坐标后经浏览器真实输入管道派发；按键直接派发。
   * 回执只证明事件已派发，游戏是否响应须由后续断言验证，不谎报。
   *
   * @param sessionId 目标会话。
   * @param input 输入描述（tap/click 需 x/y；key 需 key）。
   * @returns 派发回执（含换算后的页面坐标）。
   */
  async dispatchInput(sessionId: string, input: RuntimeDispatchInput): Promise<RuntimeDispatchReceipt> {
    const managed = this.requireSession(sessionId);
    if (managed.session.state === 'closed') {
      throw new Error('PREVIEW_SESSION_CLOSED');
    }
    if (this.syncLostState(managed)) {
      throw new Error('PREVIEW_SESSION_LOST');
    }
    if (input.inputType === 'key') {
      if (!input.key) throw new Error('INPUT_KEY_REQUIRED');
      await managed.page.keyPress(input.key);
      return { dispatched: true, inputType: 'key', key: input.key };
    }
    if (typeof input.x !== 'number' || typeof input.y !== 'number') {
      throw new Error('INPUT_COORDINATES_REQUIRED');
    }
    const { buildRuntimeScript } = await import('./runtime-inject.js');
    const rect = await managed.page.evaluate(buildRuntimeScript('readCanvasRect')) as { x: number; y: number } | null;
    if (!rect) {
      throw new Error('GAME_CANVAS_NOT_FOUND');
    }
    const pageX = rect.x + input.x;
    const pageY = rect.y + input.y;
    await managed.page.mouseClick(pageX, pageY);
    return { dispatched: true, inputType: input.inputType, x: input.x, y: input.y, pageX, pageY };
  }

  /**
   * 截图管线：可选分辨率切换（先放大视口保证画布完整）→ 节点边界读取 →
   * GameCanvas 元素截图 → 裁剪（叠加坐标同步偏移）→ 边界/锚点叠加。
   *
   * @param sessionId 目标会话。
   * @param request 截图选项。
   * @returns PNG 图像字节与实际生效分辨率。
   */
  async capture(sessionId: string, request: RuntimeCaptureRequest): Promise<RuntimeCaptureImage> {
    const managed = this.requireSession(sessionId);
    if (managed.session.state === 'closed') {
      throw new Error('PREVIEW_SESSION_CLOSED');
    }
    if (this.syncLostState(managed)) {
      throw new Error('PREVIEW_SESSION_LOST');
    }
    const { buildRuntimeScript } = await import('./runtime-inject.js');
    const { cropPng, decodePng, drawOverlay } = await import('./runtime-capture.js');

    let actualResolution: Resolution;
    if (request.resolution) {
      // 视口留余量容纳预览页工具栏，避免画布被容器约束压缩
      await managed.page.setViewportSize({
        width: request.resolution.width + 200,
        height: request.resolution.height + 200
      });
      actualResolution = ResolutionSchema.parse(
        await managed.page.evaluate(buildRuntimeScript('setRuntimeResolution', request.resolution))
      );
    } else {
      actualResolution = ResolutionSchema.parse(
        await managed.page.evaluate(buildRuntimeScript('readRuntimeResolution'))
      );
    }

    const boundsPaths = [...new Set([...request.overlay?.nodeBounds ?? [], ...request.overlay?.anchors ?? []])];
    const boundsEntries = boundsPaths.length > 0
      ? ((await managed.page.evaluate(buildRuntimeScript('readRuntimeNodeBounds', { paths: boundsPaths }))) as {
          entries: Array<{ path: string; found: boolean; hasBounds?: boolean; rect?: { x: number; y: number; width: number; height: number }; anchor?: { x: number; y: number } }>;
        }).entries
      : [];

    let buffer = await managed.page.screenshotElement('#GameCanvas');

    const cropOffset = request.crop ? { x: request.crop.x, y: request.crop.y } : { x: 0, y: 0 };
    if (request.crop) {
      buffer = cropPng(buffer, request.crop);
    }

    if (request.overlay) {
      const shiftRect = (rect: { x: number; y: number; width: number; height: number }) => ({
        x: rect.x - cropOffset.x,
        y: rect.y - cropOffset.y,
        width: rect.width,
        height: rect.height
      });
      const rects = (request.overlay.nodeBounds ?? [])
        .map((path) => boundsEntries.find((entry) => entry.path === path && entry.found && entry.hasBounds)?.rect)
        .filter((rect): rect is { x: number; y: number; width: number; height: number } => Boolean(rect))
        .map(shiftRect);
      const anchors = (request.overlay.anchors ?? [])
        .map((path) => boundsEntries.find((entry) => entry.path === path && entry.found && entry.hasBounds)?.anchor)
        .filter((anchor): anchor is { x: number; y: number } => Boolean(anchor))
        .map((anchor) => ({ x: anchor.x - cropOffset.x, y: anchor.y - cropOffset.y }));
      if (rects.length > 0 || anchors.length > 0) {
        buffer = drawOverlay(buffer, { rects, anchors });
      }
    }

    const decoded = decodePng(buffer);
    return { buffer, width: decoded.width, height: decoded.height, actualResolution };
  }

  /** 关闭全部会话与浏览器；逐会话继续清理，任一失败都保留非 closed 状态并汇总报错。 */
  async dispose(): Promise<void> {
    const errors: string[] = [];
    for (const [sessionId, managed] of this.sessions.entries()) {
      if (managed.session.state === 'closed') continue;
      try {
        await this.close(sessionId);
      } catch (error) {
        errors.push(`${sessionId}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length) {
      throw new Error(`PREVIEW_DISPOSE_FAILED:${JSON.stringify(errors)}`);
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
