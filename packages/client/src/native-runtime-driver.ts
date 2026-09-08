import { execFile as execFileCallback, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { connect as connectHttp2, type ClientHttp2Session } from 'node:http2';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  RuntimeBrowser,
  RuntimeBrowserPage,
  RuntimeDispatchInput,
  RuntimeDispatchReceipt
} from '@cocos-ai/core';
import type { PreviewSession, Resolution } from '@cocos-ai/protocol';

const execFile = promisify(execFileCallback);
const DEFAULT_INSPECTOR_PORT = 6_086;
const DEFAULT_INSPECTOR_PORT_OFFSET = 37_000;
const DEFAULT_GRPC_PORT = 8_554;
const DEFAULT_START_TIMEOUT_MS = 30_000;

export interface AndroidRuntimeOptions {
  packageName: string;
  activity?: string;
  apkPath?: string;
  adbPath?: string;
  deviceId?: string;
  inspectorPort?: number;
  inspectorPortOffset?: number;
  grpcPort?: number;
  /** Android Emulator 自身的 gRPC token；缺省时从 running/pid_*.ini 自动读取。 */
  grpcToken?: string;
  /** Emulator screenshot 方向；默认按游戏常见的横屏输出。 */
  rotation?: 'portrait' | 'landscape' | 'reverse-portrait' | 'reverse-landscape';
  screenSize?: Resolution;
  startTimeoutMs?: number;
}

export interface NativeRuntimeLauncherOptions {
  platform?: 'android-emulator' | 'creator-simulator';
  native?: unknown;
}

interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** 只实现 Cocos V8 Inspector 所需的 Runtime.evaluate 子集。 */
class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: CdpResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private closed = false;

  private constructor(private readonly socket: WebSocketLike) {
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = () => this.failPending(new Error('NATIVE_INSPECTOR_CLOSED'));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const WebSocketImpl = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!WebSocketImpl) throw new Error('NATIVE_WEBSOCKET_UNAVAILABLE');
    const socket = new WebSocketImpl(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = (error) => reject(new Error(`NATIVE_INSPECTOR_CONNECT_FAILED:${String(error)}`));
    });
    const connection = new CdpConnection(socket);
    await connection.send('Runtime.enable', {}).catch(() => undefined);
    return connection;
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    const result = response.result?.result as Record<string, unknown> | undefined;
    const exception = response.result?.exceptionDetails as Record<string, unknown> | undefined;
    if (exception) {
      const description = typeof exception.text === 'string' ? exception.text : 'Runtime.evaluate failed';
      throw new Error(`NATIVE_RUNTIME_EVALUATION_FAILED:${description}`);
    }
    if (!result) return undefined;
    if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
    if (result.unserializableValue === 'undefined') return undefined;
    if (result.unserializableValue === 'NaN') return Number.NaN;
    if (result.unserializableValue === 'Infinity') return Number.POSITIVE_INFINITY;
    return undefined;
  }

  async command(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.send(method, params);
    return response.result ?? {};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error('NATIVE_INSPECTOR_CLOSED'));
    this.socket.close();
  }

  private send(method: string, params: Record<string, unknown>): Promise<CdpResponse> {
    if (this.closed) return Promise.reject(new Error('NATIVE_INSPECTOR_CLOSED'));
    const id = this.nextId++;
    return new Promise<CdpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('NATIVE_INSPECTOR_COMMAND_TIMEOUT'));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(data: unknown): void {
    const text = typeof data === 'string'
      ? data
      : Buffer.from(data as ArrayBuffer).toString('utf8');
    let message: CdpResponse;
    try {
      message = JSON.parse(text) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`NATIVE_INSPECTOR_COMMAND_FAILED:${message.error.message ?? 'unknown'}`));
    } else {
      pending.resolve(message);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface InspectorTarget {
  webSocketDebuggerUrl: string;
}

async function discoverInspectorTarget(port: number): Promise<InspectorTarget | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(800)
    });
    if (!response.ok) return undefined;
    const targets = await response.json() as unknown;
    if (!Array.isArray(targets)) return undefined;
    const target = targets.find((item) => (
      item && typeof item === 'object' && typeof (item as Record<string, unknown>).webSocketDebuggerUrl === 'string'
    )) as Record<string, unknown> | undefined;
    return target ? { webSocketDebuggerUrl: target.webSocketDebuggerUrl as string } : undefined;
  } catch {
    return undefined;
  }
}

async function allocateLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('NATIVE_LOCAL_PORT_UNAVAILABLE');
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取 Android Emulator 自己生成的 gRPC 凭据；不写入 Toolkit 会话，也不做 Toolkit 鉴权。 */
async function readEmulatorGrpcToken(port: number): Promise<string | undefined> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const root = join(localAppData, 'Temp', 'avd', 'running');
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => /^pid_\d+\.ini$/i.test(name)).sort().reverse();
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const text = await readFile(join(root, name), 'utf8');
      const grpcPort = /^grpc\.port=(\d+)$/mi.exec(text)?.[1];
      const token = /^grpc\.token=(.+)$/mi.exec(text)?.[1]?.trim();
      if (Number(grpcPort) === port && token) return token;
    } catch {
      // 进程启动/退出期间描述文件可能短暂不可读，继续检查其它实例。
    }
  }
  return undefined;
}

/** Android 模拟器真实运行页：Inspector 读写同一进程，截图来自 Emulator gRPC。 */
class AndroidRuntimeBrowser implements RuntimeBrowser {
  private page: AndroidRuntimePage | undefined;
  private cdp: CdpConnection | undefined;
  private device: string | undefined;
  private screen: Resolution | undefined;
  private inspectorDevicePort = 0;
  private inspectorLocalPort = 0;
  private started = false;
  private closing = false;
  private grpc: EmulatorGrpcClient | undefined;

  constructor(private readonly options: AndroidRuntimeOptions) {}

  async newPage(): Promise<RuntimeBrowserPage> {
    this.page ??= new AndroidRuntimePage(this);
    return this.page;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cdp?.close();
    this.cdp = undefined;
    if (this.inspectorLocalPort && this.device) {
      await this.adb(['forward', '--remove', `tcp:${this.inspectorLocalPort}`]).catch(() => undefined);
    }
    this.grpc?.close();
    this.grpc = undefined;
  }

  async getSessionMetadata(): Promise<Partial<PreviewSession>> {
    await this.start();
    const pid = await this.readPid();
    return {
      platform: 'android-emulator',
      pageSource: 'native-runtime',
      deviceId: this.device,
      ...(pid ? { appPid: pid } : {}),
      inspectorDevicePort: this.inspectorDevicePort,
      inspectorLocalPort: this.inspectorLocalPort,
      runtimeTransport: 'android-emulator-grpc+v8-inspector'
    };
  }

  async evaluate(fn: ((...args: never[]) => unknown) | string, arg?: unknown): Promise<unknown> {
    await this.start();
    const expression = typeof fn === 'string'
      ? fn
      : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    return this.cdp!.evaluate(expression);
  }

  async capture(): Promise<Buffer> {
    await this.start();
    try {
      return (await this.grpc!.getScreenshot(this.options.rotation ?? 'landscape')).image;
    } catch {
      const result = await this.adbBinary(['exec-out', 'screencap', '-p']);
      return result;
    }
  }

  async streamFrames(
    listener: (frame: { buffer: Buffer; width: number; height: number }) => void,
    options?: { resolution?: Resolution }
  ): Promise<() => Promise<void>> {
    await this.start();
    return this.grpc!.streamScreenshot((frame) => listener({
      buffer: frame.image,
      width: frame.width,
      height: frame.height
    }), options?.resolution, this.options.rotation ?? 'landscape');
  }

  async runtimeResolution(): Promise<Resolution> {
    await this.start();
    return this.screen ?? { width: 1, height: 1 };
  }

  async dispatch(input: RuntimeDispatchInput, runtimeResolution?: Resolution): Promise<RuntimeDispatchReceipt> {
    await this.start();
    if (input.inputType === 'key') {
      if (!input.key) throw new Error('INPUT_KEY_REQUIRED');
      const keyCode = androidKeyCode(input.key);
      await this.adb(['shell', 'input', 'keyevent', keyCode]);
      return { dispatched: true, inputType: 'key', key: input.key };
    }
    if (typeof input.x !== 'number' || typeof input.y !== 'number') {
      throw new Error('INPUT_COORDINATES_REQUIRED');
    }
    const screen = this.screen ?? runtimeResolution ?? { width: 1, height: 1 };
    const source = runtimeResolution ?? screen;
    const x = Math.max(0, Math.min(screen.width - 1, Math.round(input.x * screen.width / source.width)));
    const y = Math.max(0, Math.min(screen.height - 1, Math.round(input.y * screen.height / source.height)));
    await this.adb(['shell', 'input', 'tap', String(x), String(y)]);
    return { dispatched: true, inputType: input.inputType, x: input.x, y: input.y, pageX: x, pageY: y };
  }

  private async start(): Promise<void> {
    if (this.started) return;
    if (!this.options.packageName) throw new Error('ANDROID_PACKAGE_REQUIRED');
    this.device = this.options.deviceId ?? await this.findDevice();
    if (!this.device) throw new Error('ANDROID_DEVICE_NOT_FOUND');
    if (this.options.apkPath) {
      await this.adb(['install', '-r', this.options.apkPath], 120_000);
    }
    await this.startPackage();
    await this.connectInspector();
    this.screen = this.options.screenSize ?? await this.readScreenSize();
    const grpcPort = this.options.grpcPort ?? DEFAULT_GRPC_PORT;
    const grpcToken = this.options.grpcToken ?? await readEmulatorGrpcToken(grpcPort);
    this.grpc = new EmulatorGrpcClient(grpcPort, grpcToken);
    this.started = true;
  }

  private async findDevice(): Promise<string> {
    const result = await this.adb(['devices']);
    const lines = String(result.stdout).split(/\r?\n/).slice(1);
    const device = lines
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[0] && parts[1] === 'device');
    if (!device) throw new Error('ANDROID_DEVICE_NOT_FOUND');
    return device[0];
  }

  private async startPackage(): Promise<void> {
    if (this.options.activity) {
      const activity = this.options.activity.startsWith('.')
        ? `${this.options.packageName}/${this.options.activity}`
        : (this.options.activity.includes('/') ? this.options.activity : `${this.options.packageName}/${this.options.activity}`);
      await this.adb(['shell', 'am', 'start', '-n', activity], 30_000);
      return;
    }
    await this.adb(['shell', 'monkey', '-p', this.options.packageName, '1'], 30_000);
  }

  private async connectInspector(): Promise<void> {
    const base = this.options.inspectorPort ?? DEFAULT_INSPECTOR_PORT;
    const offset = this.options.inspectorPortOffset ?? DEFAULT_INSPECTOR_PORT_OFFSET;
    const candidates = [...new Set([base, base + offset])];
    const deadline = Date.now() + (this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      for (const remotePort of candidates) {
        const localPort = await allocateLocalPort();
        try {
          await this.adb(['forward', `tcp:${localPort}`, `tcp:${remotePort}`]);
          const target = await discoverInspectorTarget(localPort);
          if (!target) throw new Error('NATIVE_INSPECTOR_TARGET_NOT_READY');
          this.cdp = await CdpConnection.connect(rewriteInspectorWebSocketUrl(target.webSocketDebuggerUrl, localPort));
          this.inspectorDevicePort = remotePort;
          this.inspectorLocalPort = localPort;
          return;
        } catch {
          await this.adb(['forward', '--remove', `tcp:${localPort}`]).catch(() => undefined);
        }
      }
      await delay(250);
    }
    throw new Error(`NATIVE_INSPECTOR_NOT_READY:${candidates.join(',')}`);
  }

  private async readPid(): Promise<number | undefined> {
    try {
      const result = await this.adb(['shell', 'pidof', this.options.packageName]);
      const pid = Number(String(result.stdout).trim().split(/\s+/)[0]);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private async readScreenSize(): Promise<Resolution> {
    try {
      const result = await this.adb(['shell', 'wm', 'size']);
      const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/i.exec(String(result.stdout));
      if (match) return { width: Number(match[1]), height: Number(match[2]) };
    } catch {
      // fallback below
    }
    return { width: 1, height: 1 };
  }

  private adb(args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
    const selectedDevice = this.device ?? this.options.deviceId;
    return execFile(this.options.adbPath ?? 'adb', [
      ...(selectedDevice ? ['-s', selectedDevice] : []),
      ...args
    ], {
      timeout,
      encoding: 'utf8'
    }) as Promise<{ stdout: string; stderr: string }>;
  }

  private adbBinary(args: string[]): Promise<Buffer> {
    const selectedDevice = this.device ?? this.options.deviceId;
    return execFile(this.options.adbPath ?? 'adb', [
      ...(selectedDevice ? ['-s', selectedDevice] : []),
      ...args
    ], {
      timeout: 30_000,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024
    }).then((result) => Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout as string));
  }
}

class AndroidRuntimePage implements RuntimeBrowserPage {
  private closed = false;

  constructor(private readonly browser: AndroidRuntimeBrowser) {}

  async goto(): Promise<void> {
    await this.browser.evaluate('1');
  }

  evaluate<R>(fn: ((...args: never[]) => R | Promise<R>) | string, arg?: unknown): Promise<R> {
    return this.browser.evaluate(fn as never, arg) as Promise<R>;
  }

  onConsole(): void {}
  onPageError(): void {}

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async mouseClick(x: number, y: number): Promise<void> {
    await this.browser.dispatch({ inputType: 'tap', x, y });
  }

  async keyPress(key: string): Promise<void> {
    await this.browser.dispatch({ inputType: 'key', key });
  }

  async setViewportSize(): Promise<void> {}

  async screenshotElement(): Promise<Buffer> {
    return this.browser.capture();
  }

  async dispatchCanvasInput(input: RuntimeDispatchInput, resolution?: Resolution): Promise<RuntimeDispatchReceipt> {
    return this.browser.dispatch(input, resolution);
  }

  getRuntimeResolution(): Promise<Resolution> {
    return this.browser.runtimeResolution();
  }
}

export function launchAndroidRuntimeBrowser(options: AndroidRuntimeOptions): Promise<RuntimeBrowser> {
  return Promise.resolve(new AndroidRuntimeBrowser(options));
}

export interface CreatorSimulatorRuntimeOptions {
  windowTitle?: string;
  ffmpegPath?: string;
  screenSize?: Resolution;
  startTimeoutMs?: number;
}

export interface CreatorSimulatorRuntimeBridge {
  status(): Promise<{ connected: boolean; runtimeId: string | null }>;
  evaluate(runtimeId: string, expression: string): Promise<unknown>;
}

/** Creator 第三项 Native Simulator：运行数据走预览代理，画面采集自同一原生窗口。 */
class CreatorSimulatorRuntimeBrowser implements RuntimeBrowser {
  private page: CreatorSimulatorRuntimePage | undefined;
  private started = false;
  private closing = false;
  private lost = false;
  private screen: Resolution | undefined;
  private runtimeId = '';
  private window: { pid: number; title: string } | undefined;

  constructor(
    private readonly options: CreatorSimulatorRuntimeOptions,
    private readonly bridge: CreatorSimulatorRuntimeBridge
  ) {}

  async newPage(): Promise<RuntimeBrowserPage> {
    this.page ??= new CreatorSimulatorRuntimePage(this);
    return this.page;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
  }

  async getSessionMetadata(): Promise<Partial<PreviewSession>> {
    await this.start();
    const window = await this.resolveWindow().catch(() => undefined);
    return {
      platform: 'creator-simulator',
      pageSource: 'native-runtime',
      ...(window ? { appPid: window.pid } : {}),
      runtimeInstanceId: this.runtimeId,
      runtimeTransport: 'creator-preview-plugin+loopback-http+window-capture'
    };
  }

  async evaluate(fn: ((...args: never[]) => unknown) | string, arg?: unknown): Promise<unknown> {
    await this.start();
    const expression = typeof fn === 'string'
      ? fn
      : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    try {
      return await this.bridge.evaluate(this.runtimeId, expression);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes('NOT_CONNECTED') || reason.includes('REPLACED')) this.lost = true;
      throw error;
    }
  }

  async capture(): Promise<Buffer> {
    await this.start();
    const window = await this.resolveWindow();
    const result = await execFile(this.options.ffmpegPath ?? 'ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'gdigrab',
      '-framerate', '1',
      '-i', `title=${window.title}`,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      'pipe:1'
    ], {
      timeout: 15_000,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024
    });
    const image = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout as string);
    const size = readPngSize(image);
    if (size) this.screen = size;
    return image;
  }

  async streamFrames(
    listener: (frame: { buffer: Buffer; width: number; height: number }) => void,
    options?: { resolution?: Resolution }
  ): Promise<() => Promise<void>> {
    await this.start();
    const window = await this.resolveWindow();
    const sourceSize = await this.runtimeResolution();
    const requested = options?.resolution;
    const scale = requested ? ['-vf', `scale=${requested.width}:${requested.height}`] : [];
    const child = spawn(this.options.ffmpegPath ?? 'ffmpeg', [
      '-loglevel', 'error',
      '-f', 'gdigrab',
      '-framerate', '30',
      '-i', `title=${window.title}`,
      ...scale,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let pending = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (true) {
        const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) {
          pending = pending.subarray(Math.max(0, pending.length - 1));
          return;
        }
        const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) {
          if (start > 0) pending = pending.subarray(start);
          return;
        }
        const image = pending.subarray(start, end + 2);
        pending = pending.subarray(end + 2);
        const size = requested ?? readJpegSize(image) ?? sourceSize;
        listener({ buffer: image, width: size.width, height: size.height });
      }
    });
    return async () => {
      if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('close', () => resolve());
        setTimeout(resolve, 1_000);
      });
    };
  }

  async runtimeResolution(): Promise<Resolution> {
    if (this.screen) return this.screen;
    if (this.options.screenSize) return this.options.screenSize;
    try {
      await this.capture();
    } catch {
      // RuntimeDriver will still expose Inspector data if the window is hidden.
    }
    return this.screen ?? { width: 1, height: 1 };
  }

  async dispatch(input: RuntimeDispatchInput): Promise<RuntimeDispatchReceipt> {
    await this.start();
    throw new Error(`CREATOR_SIMULATOR_INPUT_UNAVAILABLE:${input.inputType}`);
  }

  private async start(): Promise<void> {
    if (this.started) return;
    const deadline = Date.now() + (this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const status = await this.bridge.status().catch(() => ({ connected: false, runtimeId: null }));
      if (status.connected && status.runtimeId) {
        this.runtimeId = status.runtimeId;
        this.started = true;
        return;
      }
      await delay(250);
    }
    throw new Error('CREATOR_SIMULATOR_RUNTIME_NOT_READY');
  }

  isClosed(): boolean {
    return this.closing || this.lost;
  }

  private async resolveWindow(): Promise<{ pid: number; title: string }> {
    if (this.options.windowTitle) {
      const detected = await findCreatorSimulatorWindow().catch(() => undefined);
      return { pid: detected?.pid ?? 1, title: this.options.windowTitle };
    }
    this.window = await findCreatorSimulatorWindow() ?? this.window;
    if (!this.window) throw new Error('CREATOR_SIMULATOR_WINDOW_NOT_FOUND');
    return this.window;
  }
}

function rewriteInspectorWebSocketUrl(value: string, localPort: number): string {
  try {
    const url = new URL(value);
    url.hostname = '127.0.0.1';
    url.port = String(localPort);
    return url.toString();
  } catch {
    return value;
  }
}

class CreatorSimulatorRuntimePage implements RuntimeBrowserPage {
  private closed = false;

  constructor(private readonly browser: CreatorSimulatorRuntimeBrowser) {}

  async goto(): Promise<void> {
    await this.browser.evaluate('1');
  }

  evaluate<R>(fn: ((...args: never[]) => R | Promise<R>) | string, arg?: unknown): Promise<R> {
    return this.browser.evaluate(fn as never, arg) as Promise<R>;
  }

  onConsole(): void {}
  onPageError(): void {}

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed || this.browser.isClosed();
  }

  async mouseClick(x: number, y: number): Promise<void> {
    await this.browser.dispatch({ inputType: 'click', x, y });
  }

  async keyPress(key: string): Promise<void> {
    await this.browser.dispatch({ inputType: 'key', key });
  }

  async setViewportSize(): Promise<void> {}

  async screenshotElement(): Promise<Buffer> {
    return this.browser.capture();
  }

  async dispatchCanvasInput(input: RuntimeDispatchInput): Promise<RuntimeDispatchReceipt> {
    return this.browser.dispatch(input);
  }

  getRuntimeResolution(): Promise<Resolution> {
    return this.browser.runtimeResolution();
  }
}

export function launchCreatorSimulatorRuntimeBrowser(
  options: CreatorSimulatorRuntimeOptions,
  bridge: CreatorSimulatorRuntimeBridge
): Promise<RuntimeBrowser> {
  return Promise.resolve(new CreatorSimulatorRuntimeBrowser(options, bridge));
}

export function isCreatorSimulatorOptions(value: unknown): value is CreatorSimulatorRuntimeOptions {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input.windowTitle === undefined || typeof input.windowTitle === 'string')
    && (input.ffmpegPath === undefined || typeof input.ffmpegPath === 'string')
    && (input.startTimeoutMs === undefined || (Number.isInteger(input.startTimeoutMs) && (input.startTimeoutMs as number) > 0))
    && (input.screenSize === undefined || isResolution(input.screenSize));
}

async function findCreatorSimulatorWindow(): Promise<{ pid: number; title: string } | undefined> {
  const command = "$value = Get-Process -Name 'SimulatorApp-Win32' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Sort-Object StartTime -Descending | Select-Object -First 1 Id, MainWindowTitle; if ($value) { $value | ConvertTo-Json -Compress }";
  const result = await execFile('powershell.exe', ['-NoProfile', '-Command', command], {
    timeout: 5_000,
    encoding: 'utf8'
  }) as { stdout: string };
  const text = String(result.stdout).trim();
  if (!text) return undefined;
  const value = JSON.parse(text) as { Id?: unknown; MainWindowTitle?: unknown };
  const pid = Number(value.Id);
  const title = typeof value.MainWindowTitle === 'string' ? value.MainWindowTitle : '';
  return Number.isSafeInteger(pid) && pid > 0 && title ? { pid, title } : undefined;
}

function isResolution(value: unknown): value is Resolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Number.isInteger(input.width) && (input.width as number) > 0
    && Number.isInteger(input.height) && (input.height as number) > 0;
}

function readPngSize(value: Buffer): Resolution | undefined {
  if (value.length < 24 || value.toString('ascii', 1, 4) !== 'PNG') return undefined;
  return { width: value.readUInt32BE(16), height: value.readUInt32BE(20) };
}

function readJpegSize(value: Buffer): Resolution | undefined {
  let offset = 2;
  while (offset + 9 < value.length) {
    if (value[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = value[offset + 1];
    const length = value.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < value.length) {
      return { width: value.readUInt16BE(offset + 7), height: value.readUInt16BE(offset + 5) };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/** 兼容现有 RuntimeDriver 的 launcher：Android 走 Native，其他平台继续浏览器。 */
export function isAndroidNativeOptions(value: unknown): value is AndroidRuntimeOptions {
  return Boolean(value && typeof value === 'object' && typeof (value as Record<string, unknown>).packageName === 'string');
}

function androidKeyCode(key: string): string {
  const names: Record<string, string> = {
    Enter: 'KEYCODE_ENTER',
    Escape: 'KEYCODE_ESCAPE',
    Backspace: 'KEYCODE_DEL',
    Tab: 'KEYCODE_TAB',
    ArrowUp: 'KEYCODE_DPAD_UP',
    ArrowDown: 'KEYCODE_DPAD_DOWN',
    ArrowLeft: 'KEYCODE_DPAD_LEFT',
    ArrowRight: 'KEYCODE_DPAD_RIGHT',
    Space: 'KEYCODE_SPACE'
  };
  if (names[key]) return names[key];
  if (/^[a-z]$/i.test(key)) return `KEYCODE_${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `KEYCODE_${key}`;
  return key.startsWith('KEYCODE_') ? key : `KEYCODE_${key.toUpperCase()}`;
}

interface ScreenshotFrame {
  image: Buffer;
  width: number;
  height: number;
}

/** Android Emulator gRPC 的最小 protobuf/HTTP2 客户端，无额外运行时依赖。 */
class EmulatorGrpcClient {
  private session: ClientHttp2Session | undefined;

  constructor(private readonly port: number, private readonly token?: string) {}

  async getScreenshot(rotation: string = 'landscape', resolution?: Resolution): Promise<ScreenshotFrame> {
    const payload = encodeImageFormat({
      format: 0,
      rotation: rotationValue(rotation),
      ...(resolution ? { width: resolution.width, height: resolution.height } : {})
    });
    const response = await this.unary('/android.emulation.control.EmulatorController/getScreenshot', payload);
    return decodeImage(response);
  }

  async streamScreenshot(
    listener: (frame: ScreenshotFrame) => void,
    resolution?: Resolution,
    rotation: string = 'landscape'
  ): Promise<() => Promise<void>> {
    const session = this.openSession();
      const request = session.request({
        ':method': 'POST',
        ':path': '/android.emulation.control.EmulatorController/streamScreenshot',
        'content-type': 'application/grpc',
        te: 'trailers',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
    });
    let pending = Buffer.alloc(0);
    let frameCount = 0;
    request.once('response', (headers) => {
      if (process.env.COCOS_AI_RUNTIME_DEBUG === '1') {
        process.stderr.write(`[cocos-ai] emulator stream status=${String(headers[':status'])}\n`);
      }
    });
    request.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (process.env.COCOS_AI_RUNTIME_DEBUG === '1' && pending.length > 0 && pending.length < 32 * 1024 * 1024) {
        process.stderr.write(`[cocos-ai] emulator stream chunk=${chunk.length} pending=${pending.length}\n`);
      }
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (pending.length < length + 5) break;
        const compressed = pending[0];
        const payload = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);
        if (compressed === 0) {
          try {
            const frame = decodeImage(payload);
            frameCount += 1;
            listener(frame);
          } catch (error) {
            if (process.env.COCOS_AI_RUNTIME_DEBUG === '1') {
              process.stderr.write(`[cocos-ai] emulator stream frame decode failed ${String(error)}\n`);
            }
            // 丢弃单帧坏包，保持后续实时帧可用。
          }
        }
      }
    });
    request.once('error', (error) => {
      if (process.env.COCOS_AI_RUNTIME_DEBUG === '1') {
        process.stderr.write(`[cocos-ai] emulator stream error frames=${frameCount} ${String(error)}\n`);
      }
    });
    request.once('end', () => {
      if (process.env.COCOS_AI_RUNTIME_DEBUG === '1') {
        process.stderr.write(`[cocos-ai] emulator stream ended frames=${frameCount}\n`);
      }
    });
    request.end(grpcFrame(encodeImageFormat({
      format: 0,
      rotation: rotationValue(rotation),
      ...(resolution ? { width: resolution.width, height: resolution.height } : {})
    })));
    return async () => {
      request.close();
      if (!request.closed) request.destroy();
    };
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }

  private unary(path: string, payload: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const session = this.openSession();
      const request = session.request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        te: 'trailers',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      });
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.once('error', reject);
      request.once('end', () => {
        try {
          const frame = readGrpcFrame(Buffer.concat(chunks));
          resolve(frame);
        } catch (error) {
          reject(error);
        }
      });
      request.end(grpcFrame(payload));
    });
  }

  private openSession(): ClientHttp2Session {
    if (!this.session || this.session.closed || this.session.destroyed) {
      this.session = connectHttp2(`http://127.0.0.1:${this.port}`);
      this.session.once('error', () => undefined);
    }
    return this.session;
  }
}

function grpcFrame(payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function readGrpcFrame(value: Buffer): Buffer {
  if (value.length < 5) throw new Error('EMULATOR_GRPC_EMPTY_RESPONSE');
  const compressed = value[0];
  const length = value.readUInt32BE(1);
  if (compressed !== 0 || value.length < length + 5) throw new Error('EMULATOR_GRPC_FRAME_INVALID');
  return value.subarray(5, 5 + length);
}

function encodeImageFormat(options: { format: number; rotation?: number; width?: number; height?: number }): Buffer {
  const chunks: Buffer[] = [encodeVarintField(1, options.format)];
  if (options.rotation !== undefined) {
    chunks.push(encodeMessageField(2, encodeVarintField(1, options.rotation)));
  }
  if (options.width) chunks.push(encodeVarintField(3, options.width));
  if (options.height) chunks.push(encodeVarintField(4, options.height));
  return Buffer.concat(chunks);
}

function encodeMessageField(field: number, value: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(value.length), value]);
}

function rotationValue(rotation: string): number {
  switch (rotation) {
    case 'portrait': return 0;
    case 'reverse-portrait': return 2;
    case 'reverse-landscape': return 3;
    default: return 1;
  }
}

function encodeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function decodeImage(payload: Buffer): ScreenshotFrame {
  let offset = 0;
  let width = 0;
  let height = 0;
  let image = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  while (offset < payload.length) {
    const tag = readVarint(payload, () => offset);
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(payload, () => offset);
      offset = value.next;
      if (field === 2) width = value.value;
      if (field === 3) height = value.value;
    } else if (wire === 2) {
      const length = readVarint(payload, () => offset);
      offset = length.next;
      const end = offset + length.value;
      if (end > payload.length) throw new Error('EMULATOR_GRPC_PROTO_INVALID');
      if (field === 1) {
        const format = decodeImageFormat(payload.subarray(offset, end));
        width = format.width;
        height = format.height;
      }
      if (field === 4) image = payload.subarray(offset, end);
      offset = end;
    } else {
      throw new Error('EMULATOR_GRPC_PROTO_UNSUPPORTED');
    }
  }
  if (!image.length) throw new Error('EMULATOR_GRPC_SCREENSHOT_EMPTY');
  return { image, width, height };
}

function decodeImageFormat(payload: Buffer): { width: number; height: number } {
  let offset = 0;
  let width = 0;
  let height = 0;
  while (offset < payload.length) {
    const tag = readVarint(payload, () => offset);
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(payload, () => offset);
      offset = value.next;
      if (field === 3) width = value.value;
      if (field === 4) height = value.value;
    } else if (wire === 2) {
      const length = readVarint(payload, () => offset);
      offset = length.next + length.value;
    } else {
      throw new Error('EMULATOR_GRPC_FORMAT_INVALID');
    }
  }
  return { width, height };
}

function readVarint(payload: Buffer, offsetReader: () => number): { value: number; next: number } {
  let offset = offsetReader();
  let value = 0;
  let shift = 0;
  while (offset < payload.length && shift < 70) {
    const byte = payload[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }
  throw new Error('EMULATOR_GRPC_VARINT_INVALID');
}
