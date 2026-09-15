import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  NativeSimulatorHost,
  type NativeSimulatorHighlight,
  type NativeSimulatorInput,
  type NativeSimulatorHostStatus,
  type NativeWindowLayout
} from './native-simulator-host';

const MAX_BODY_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

interface WorkbenchClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  request(method: string, payload: unknown): Promise<any>;
  streamRuntimeHierarchy(
    sessionId: string,
    listener: (snapshot: Record<string, any>) => void,
    options: {
      intervalMs: number;
      maxDepth: number;
      maxNodes: number;
      includeInactive: boolean;
      onError(error: unknown): void;
    }
  ): Promise<() => Promise<void>>;
}

interface WorkbenchSelector {
  projectId: string;
  editorInstanceId: string;
}

export type WorkbenchCreatorRequest = (
  selector: WorkbenchSelector,
  method: string,
  payload: unknown
) => Promise<unknown>;

interface WorkbenchNativeHost {
  getStatus(): NativeSimulatorHostStatus;
  start(layout: NativeWindowLayout): Promise<NativeSimulatorHostStatus>;
  stop(): Promise<void>;
  setHighlight(value: NativeSimulatorHighlight | null): void;
}

type NativeHostFactory = (options: {
  parentProcessId: number;
  childProcessId: number;
  parentTitles: string[];
  onInput: (input: NativeSimulatorInput) => void;
}) => WorkbenchNativeHost;

type WorkbenchState = 'idle' | 'starting' | 'stopping' | 'ready' | 'error';

/** 人用 Workbench：真实运行树、属性和嵌入窗口都绑定同一 Simulator 会话。 */
export class WorkbenchHost {
  private server: Server | null = null;
  private client: WorkbenchClient | null = null;
  private session: Record<string, any> | null = null;
  private hierarchy: Record<string, any> | null = null;
  private stopHierarchy: (() => Promise<void>) | null = null;
  private nativeHost: WorkbenchNativeHost | null = null;
  private starting: Promise<Record<string, any>> | null = null;
  private state: WorkbenchState = 'idle';
  private userStopped = false;
  private lastError: string | null = null;
  private lastUpdateAt: string | null = null;
  private port = 0;
  private selectedPath: string | null = null;
  private readonly nativeInputEvents: Array<{ sessionId: string; input: NativeSimulatorInput }> = [];
  private pendingNativePointerMove: { sessionId: string; input: NativeSimulatorInput } | null = null;
  private nativeInputSending = false;

  constructor(
    private readonly selector: WorkbenchSelector,
    client?: WorkbenchClient,
    private readonly createNativeHost: NativeHostFactory = (options) => new NativeSimulatorHost(options),
    private readonly requestCreator?: WorkbenchCreatorRequest
  ) {
    this.client = client ?? null;
  }

  async start(): Promise<{ url: string }> {
    if (this.server) return { url: this.url() };
    if (!this.client) this.client = await createClient(this.requestCreator);
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        sendJson(response, 500, { error: readReason(error) });
      });
    });
    this.server = server;
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => rejectStart(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        if (!this.port) rejectStart(new Error('WORKBENCH_PORT_UNAVAILABLE'));
        else resolveStart();
      });
    });
    return { url: this.url() };
  }

  async stop(): Promise<void> {
    await this.stopSession();
    await this.client?.close().catch(() => undefined);
    this.client = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
  }

  /**
   * 停止当前 Workbench 运行会话，但保留本地 HTTP 服务供下一次启动复用。
   *
   * @returns 无返回值；调用完成后状态回到 idle。
   */
  async stopSession(userInitiated = false): Promise<void> {
    if (userInitiated) this.userStopped = true;
    this.state = 'stopping';
    const session = this.session;
    const sessionId = typeof(session?.sessionId) === 'string' ? session.sessionId : '';
    const processId = Number(session?.appPid);
    const ownedSession = Boolean(sessionId) || (Number.isInteger(processId) && processId > 0);
    this.clearNativeInput();
    await this.stopHierarchy?.().catch(() => undefined);
    this.stopHierarchy = null;
    if (sessionId) {
      await this.client?.request('server.previewStop', { sessionId }).catch(() => undefined);
    }
    const simulatorProcessFound = await terminateCreatorSimulatorProcesses(process.pid, processId);
    // 先结束 Simulator，再退出透明 Native Host，停止时不会短暂恢复独立窗口。
    await this.detachNativeWindow();
    if (ownedSession || simulatorProcessFound) await this.waitForRuntimeDisconnect();
    this.session = null;
    this.hierarchy = null;
    this.state = 'idle';
    this.lastError = null;
  }

  /** 等待 Preview Server 清除旧 Simulator 心跳，避免停止或切换分辨率后立即误连旧实例。 */
  private async waitForRuntimeDisconnect(): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const runtime = await this.client?.request('probe.simulatorRuntimeStatus', {
        selector: this.selector,
        params: {}
      }).catch(() => ({ connected: false }));
      if (runtime?.connected !== true) return;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
    }
    // 进程已经被明确结束时，残留心跳属于服务端延迟；不能阻塞 Workbench 的停止状态。
  }

  private url(): string {
    if (!this.port) throw new Error('WORKBENCH_NOT_STARTED');
    return `http://127.0.0.1:${this.port}/`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: 'LOOPBACK_REQUIRED' });
      return;
    }
    const url = new URL(request.url ?? '/', this.url());
    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, await this.readState());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/stop') {
      await this.stopSession(true);
      sendJson(response, 200, await this.readState());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/start') {
      this.userStopped = false;
      await this.startSession();
      sendJson(response, 200, await this.readState());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/hierarchy') {
      if (!this.hierarchy) {
        sendJson(response, 409, { error: 'RUNTIME_HIERARCHY_NOT_READY' });
        return;
      }
      sendJson(response, 200, this.hierarchy);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/node') {
      const path = url.searchParams.get('path');
      if (!path) { sendJson(response, 400, { error: 'NODE_PATH_REQUIRED' }); return; }
      if (url.searchParams.get('sessionId') !== this.session?.sessionId) {
        sendJson(response, 409, { error: 'WORKBENCH_SESSION_CHANGED' }); return;
      }
      sendJson(response, 200, await this.readSnapshot({ view: 'node', path, includeSource: url.searchParams.get('includeSource') !== 'false' }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/selection') {
      const body = await readJsonBody(request);
      if (body.sessionId !== this.session?.sessionId || !body.sessionId) {
        sendJson(response, 409, { error: 'WORKBENCH_SESSION_CHANGED' }); return;
      }
      if (body.path !== null && (typeof body.path !== 'string' || !body.path)) {
        sendJson(response, 400, { error: 'NODE_PATH_REQUIRED' }); return;
      }
      this.selectedPath = body.path;
      sendJson(response, 200, { selectedPath: this.selectedPath });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/reveal-source') {
      const body = await readJsonBody(request);
      if (body.sessionId !== this.session?.sessionId || !body.sessionId) {
        sendJson(response, 409, { error: 'WORKBENCH_SESSION_CHANGED' }); return;
      }
      if (typeof body.path !== 'string' || !body.path) { sendJson(response, 400, { error: 'NODE_PATH_REQUIRED' }); return; }
      const node = await this.readSnapshot({ view: 'node', path: body.path });
      if (!node.origin?.available || !node.origin.assetUuid || node.origin.assetUuid !== body.assetUuid) {
        sendJson(response, 409, { error: 'NODE_SOURCE_CHANGED' }); return;
      }
      sendJson(response, 200, await this.requireClient().request('probe.assetReveal', { selector: this.selector, params: { uuid: node.origin.assetUuid } }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/component') {
      const path = url.searchParams.get('path') ?? '';
      const componentType = url.searchParams.get('componentType') ?? '';
      if (!path || !componentType) {
        sendJson(response, 400, { error: 'COMPONENT_QUERY_INVALID' });
        return;
      }
      sendJson(response, 200, await this.requireClient().request('server.runtimeComponent', {
        sessionId: this.requireSessionId(),
        path,
        componentType,
        inspector: true
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/console') {
      const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0);
      if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
        sendJson(response, 400, { error: 'CONSOLE_CURSOR_INVALID' });
        return;
      }
      sendJson(response, 200, await this.requireClient().request('server.runtimeConsole', {
        sessionId: this.requireSessionId(),
        sinceSeq
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/simulator-settings') {
      sendJson(response, 200, await this.requireClient().request('probe.simulatorSettings', {
        selector: this.selector,
        params: {}
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/simulator-settings') {
      const body = await readJsonBody(request);
      const settings = await this.requireClient().request('probe.simulatorSettingsUpdate', {
        selector: this.selector,
        params: body
      });
      const wasRunning = this.state === 'ready' || Boolean(this.session?.sessionId);
      if (wasRunning) {
        await this.stopSession();
        await this.startSession();
      }
      sendJson(response, 200, { settings, state: await this.readState() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/property') {
      const body = await readJsonBody(request);
      if (
        typeof body.sessionId !== 'string'
        || !body.sessionId
        || typeof body.path !== 'string'
        || !body.path
        || typeof body.componentType !== 'string'
        || !body.componentType
        || typeof body.property !== 'string'
        || !body.property
      ) {
        sendJson(response, 400, { error: 'PROPERTY_WRITE_INPUT_INVALID' });
        return;
      }
      const sessionId = this.session?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId || body.sessionId !== sessionId) {
        sendJson(response, 409, { error: 'WORKBENCH_SESSION_CHANGED' });
        return;
      }
      sendJson(response, 200, await this.requireClient().request('server.runtimeSetProperty', {
        sessionId,
        path: body.path,
        componentType: body.componentType,
        property: body.property,
        value: body.value,
        inspector: true
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/native-window') {
      const body = await readJsonBody(request);
      if (this.state !== 'ready' || !this.session?.sessionId || body.sessionId !== this.session.sessionId) {
        sendJson(response, 409, { error: 'WORKBENCH_SESSION_CHANGED' });
        return;
      }
      let input: ReturnType<typeof readNativeWindowRequest>;
      try {
        input = readNativeWindowRequest(body);
      } catch (error) {
        sendJson(response, 400, { error: readReason(error) });
        return;
      }
      sendJson(response, 200, await this.embedNativeWindow(input));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/native-window/detach') {
      await this.detachNativeWindow();
      sendJson(response, 200, { detached: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/native-input') {
      const body = await readJsonBody(request);
      if (this.state !== 'ready' || body.sessionId !== this.session?.sessionId || !body.sessionId) {
        sendJson(response, 409, { error: 'WORKBENCH_SESSION_CHANGED' }); return;
      }
      if (!this.nativeHost || this.nativeHost.getStatus().state !== 'ready') {
        sendJson(response, 409, { error: 'NATIVE_SIMULATOR_HOST_NOT_READY' }); return;
      }
      try {
        this.enqueueNativeInput(readNativeInput(body));
        sendJson(response, 202, { accepted: true });
      } catch (error) { sendJson(response, 400, { error: readReason(error) }); }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/native-highlight') {
      const body = await readJsonBody(request);
      if (this.state !== 'ready' || body.sessionId !== this.session?.sessionId || !body.sessionId) {
        sendJson(response, 409, { error: 'WORKBENCH_SESSION_CHANGED' }); return;
      }
      if (!this.nativeHost || this.nativeHost.getStatus().state !== 'ready') {
        sendJson(response, 409, { error: 'NATIVE_SIMULATOR_HOST_NOT_READY' }); return;
      }
      try {
        this.nativeHost.setHighlight(body.clear === true ? null : readNativeHighlight(body));
        sendJson(response, 200, { accepted: true });
      } catch (error) { sendJson(response, 400, { error: readReason(error) }); }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    await this.serveStatic(url.pathname, response);
  }

  private async startSession(): Promise<Record<string, any>> {
    if (this.starting) return this.starting;
    if (this.state === 'ready' && this.session?.state === 'ready') return this.session;
    const starting = (async () => {
      if (this.state === 'error' || this.session || this.nativeHost) {
        await this.stopSession();
      }
      this.state = 'starting';
      this.lastError = null;
      const session = await this.requireClient().request('server.previewLaunch', {
        selector: this.selector,
        params: { platform: 'creator-simulator' }
      });
      this.session = session;
      this.selectedPath = null;
      this.hierarchy = null;
      this.stopHierarchy = await this.requireClient().streamRuntimeHierarchy(
        this.requireSessionId(),
        (snapshot) => {
          this.hierarchy = snapshot;
          this.lastUpdateAt = new Date().toISOString();
        },
        {
          intervalMs: 500,
          maxDepth: 20,
          maxNodes: 10_000,
          includeInactive: true,
          onError: (error) => {
            this.lastError = readReason(error);
            if (this.lastError.includes('PREVIEW_SESSION_LOST')) this.state = 'error';
          }
        }
      );
      this.state = 'ready';
      setTimeout(() => {
        void this.closeSimulatorDebugger().catch(() => undefined);
      }, 500);
      return session;
    })().catch((error) => {
      this.state = 'error';
      this.lastError = readReason(error);
      throw error;
    }).finally(() => {
      this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async closeSimulatorDebugger(): Promise<void> {
    const client = this.requestCreator ? await createClient() : this.requireClient();
    try {
      await client.request('probe.simulatorDebuggerClose', { selector: this.selector, params: {} });
    } finally {
      if (client !== this.client) await client.close().catch(() => undefined);
    }
  }

  private async readState(): Promise<Record<string, unknown>> {
    const runtime = await this.requireClient().request('probe.simulatorRuntimeStatus', {
      selector: this.selector,
      params: {}
    }).catch((error: unknown) => ({ connected: false, error: readReason(error) }));
    return {
      status: this.state,
      selectedPath: this.selectedPath,
      session: this.session,
      runtime,
      hierarchy: this.hierarchy ? {
        sceneUuid: this.hierarchy.sceneUuid,
        sceneEpoch: this.hierarchy.sceneEpoch,
        revision: this.hierarchy.revision,
        nodeCount: this.hierarchy.nodeCount,
        truncated: this.hierarchy.truncated === true
      } : null,
      lastUpdateAt: this.lastUpdateAt,
      nativeWindow: this.nativeHost?.getStatus() ?? {
        state: 'idle',
        parentProcessId: process.pid,
        childProcessId: null,
        parentWindowHandle: null,
        simulatorWindowHandle: null,
        embeddedWindowHandle: null,
        error: null
      },
      userStopped: this.userStopped,
      error: this.lastError
    };
  }

  /**
   * 直接读取本工作台拥有的运行会话，供 HTTP 界面与独立 AI 客户端共用。
   * @param input view 指定概览、节点树、节点、组件或日志；path 缺省使用当前选择；其余字段控制读取范围。
   * @returns 同一会话的真实快照；不会启动、重连或停止模拟器。
   */
  async readSnapshot(input: {
    view?: 'overview' | 'hierarchy' | 'node' | 'component' | 'console';
    sessionId?: string; path?: string; componentType?: string; maxDepth?: number; maxNodes?: number; includeInactive?: boolean;
    includeSource?: boolean; sinceSeq?: number; level?: string;
  } = {}): Promise<Record<string, any>> {
    const view = input.view || 'overview';
    const currentSessionId = this.session?.sessionId;
    if (input.sessionId && input.sessionId !== currentSessionId) throw new Error('WORKBENCH_SESSION_CHANGED');
    if (view === 'overview') {
      const snapshot = await this.readState();
      if (this.session?.sessionId !== currentSessionId) throw new Error('WORKBENCH_SESSION_CHANGED');
      return { ...snapshot, url: this.url(), capturedAt: new Date().toISOString() };
    }
    const sessionId = this.requireSessionId();
    if (this.state !== 'ready') throw new Error('WORKBENCH_SESSION_NOT_READY');
    const path = input.path || this.selectedPath;
    if ((view === 'node' || view === 'component') && !path) throw new Error('WORKBENCH_NODE_NOT_SELECTED');
    let result: Record<string, any>;
    if (view === 'hierarchy') {
      result = await this.requireClient().request('server.runtimeHierarchy', {
        sessionId, ...(input.path ? { path: input.path } : {}), maxDepth: input.maxDepth ?? 8, maxNodes: input.maxNodes ?? 2000,
        includeInactive: input.includeInactive !== false
      });
    } else if (view === 'node') {
      result = await this.requireClient().request('server.runtimeNode', { sessionId, path, includeSource: input.includeSource !== false });
    } else if (view === 'component') {
      if (!input.componentType) throw new Error('COMPONENT_TYPE_REQUIRED');
      result = await this.requireClient().request('server.runtimeComponent', { sessionId, path, componentType: input.componentType, inspector: true });
    } else if (view === 'console') {
      result = await this.requireClient().request('server.runtimeConsole', { sessionId, sinceSeq: input.sinceSeq ?? 0, ...(input.level ? { level: input.level } : {}) });
      result = { ...result, previewSessionId: sessionId, capturedAt: new Date().toISOString() };
    } else throw new Error('WORKBENCH_VIEW_INVALID');
    // 迟到响应不能混入用户刚启动的新会话。
    if (this.session?.sessionId !== sessionId || this.state !== 'ready') throw new Error('WORKBENCH_SESSION_CHANGED');
    return result;
  }

  async detachNativeWindow(): Promise<void> {
    const host = this.nativeHost;
    this.nativeHost = null;
    await host?.stop().catch(() => undefined);
  }

  private async embedNativeWindow(input: {
    layout: NativeWindowLayout;
    parentTitle: string;
  }): Promise<NativeSimulatorHostStatus> {
    const sessionProcessId = Number(this.session?.appPid);
    const childProcessId = Number.isInteger(sessionProcessId) && sessionProcessId > 0 ? sessionProcessId : 0;
    if (
      this.nativeHost
      && childProcessId > 0
      && this.nativeHost.getStatus().childProcessId !== childProcessId
    ) {
      await this.detachNativeWindow();
    }
    if (!this.nativeHost) {
      this.nativeHost = this.createNativeHost({
        parentProcessId: process.pid,
        childProcessId,
        parentTitles: [input.parentTitle, 'Cocos AI 运行工作台', 'Cocos AI Runtime Workbench'],
        onInput: (nativeInput) => this.enqueueNativeInput(nativeInput)
      });
    }
    return this.nativeHost.start(input.layout);
  }

  /** 离散输入严格保序；mousemove 只保留最新值，且不会排在点击前面。 */
  private enqueueNativeInput(input: NativeSimulatorInput): void {
    const sessionId = this.session?.sessionId;
    if (this.state !== 'ready' || !sessionId) return;
    const queued = { sessionId, input };
    if (input.type === 'pointermove') this.pendingNativePointerMove = queued;
    else {
      this.pendingNativePointerMove = null;
      this.nativeInputEvents.push(queued);
    }
    void this.pumpNativeInput();
  }

  private async pumpNativeInput(): Promise<void> {
    if (this.nativeInputSending) return;
    this.nativeInputSending = true;
    try {
      while (this.nativeInputEvents.length > 0 || this.pendingNativePointerMove) {
        const queued = this.nativeInputEvents.shift() ?? this.pendingNativePointerMove;
        if (!queued) break;
        if (queued === this.pendingNativePointerMove) this.pendingNativePointerMove = null;
        if (this.state !== 'ready' || this.session?.sessionId !== queued.sessionId) continue;
        try {
          await this.requireClient().request('server.runtimeDispatchInput', {
            sessionId: queued.sessionId,
            inputType: queued.input.type,
            ...queued.input
          });
        } catch (error) {
          this.lastError = `输入未送达：${readReason(error)}`;
        }
      }
    } finally {
      this.nativeInputSending = false;
      if (this.nativeInputEvents.length > 0 || this.pendingNativePointerMove) void this.pumpNativeInput();
    }
  }

  private clearNativeInput(): void {
    this.nativeInputEvents.length = 0;
    this.pendingNativePointerMove = null;
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const files: Record<string, string> = {
      '/': 'index.html',
      '/app.js': 'app.js',
      '/style.css': 'style.css'
    };
    const name = files[pathname];
    if (!name) {
      sendJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }
    const staticRoot = resolve(__dirname, '..', 'static', 'workbench');
    const filePath = join(staticRoot, name);
    const content = await readFile(filePath);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
      'content-type': contentType(filePath)
    });
    response.end(content);
  }

  private requireClient(): WorkbenchClient {
    if (!this.client) throw new Error('WORKBENCH_CLIENT_NOT_READY');
    return this.client;
  }

  private requireSessionId(): string {
    const value = this.session?.sessionId;
    if (typeof value !== 'string' || !value) throw new Error('WORKBENCH_SESSION_NOT_READY');
    return value;
  }
}

/** 强制结束当前 Creator 启动的全部 Simulator，覆盖 Workbench 尚未建立 session 的路径。 */
async function terminateCreatorSimulatorProcesses(parentProcessId: number, knownProcessId: number): Promise<boolean> {
  const processIds = new Set<number>();
  if (Number.isInteger(knownProcessId) && knownProcessId > 0 && knownProcessId !== process.pid) {
    processIds.add(knownProcessId);
  }
  if (process.platform === 'win32') {
    const command = `$items = Get-CimInstance Win32_Process -Filter \"Name = 'SimulatorApp-Win32.exe'\" | `
      + `Where-Object { $_.ParentProcessId -eq ${parentProcessId} } | `
      + 'Select-Object -ExpandProperty ProcessId; $items';
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command
    ], { windowsHide: true, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: '' }));
    for (const value of String(result.stdout).split(/\s+/)) {
      const processId = Number(value);
      if (Number.isInteger(processId) && processId > 0 && processId !== process.pid) processIds.add(processId);
    }
  }
  for (const processId of processIds) {
    try { process.kill(processId); } catch { /* 进程已退出时继续清理其它资源。 */ }
    if (process.platform === 'win32') {
      await execFileAsync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
        windowsHide: true
      }).catch(() => undefined);
    }
  }
  return processIds.size > 0;
}

async function createClient(requestCreator?: WorkbenchCreatorRequest): Promise<WorkbenchClient> {
  const entry = pathToFileURL(resolve(__dirname, '..', '..', 'client', 'dist', 'index.js')).href;
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<{ CreatorClient: new (options?: { requestCreator?: WorkbenchCreatorRequest }) => WorkbenchClient }>;
  const module = await dynamicImport(entry);
  const client = new module.CreatorClient(requestCreator ? { requestCreator } : undefined);
  await client.connect();
  return client;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readNativeWindowRequest(body: Record<string, any>): {
  layout: NativeWindowLayout;
  parentTitle: string;
} {
  const layout = {
    x: body.x,
    y: body.y,
    width: body.width,
    height: body.height,
    viewportWidth: body.viewportWidth,
    viewportHeight: body.viewportHeight
  } as NativeWindowLayout;
  const values = Object.values(layout);
  if (
    values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    || layout.x < 0
    || layout.y < 0
    || layout.width < 32
    || layout.height < 32
    || layout.viewportWidth <= 0
    || layout.viewportHeight <= 0
    || layout.x + layout.width > layout.viewportWidth + 2
    || layout.y + layout.height > layout.viewportHeight + 2
  ) throw new Error('INVALID_NATIVE_WINDOW_LAYOUT');
  const parentTitle = typeof body.parentTitle === 'string'
    ? body.parentTitle.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
    : '';
  return { layout, parentTitle };
}

function readNativeHighlight(body: Record<string, any>): NativeSimulatorHighlight {
  const viewport = body.viewport;
  const points = body.points;
  const anchor = body.anchor;
  if (
    !viewport || typeof viewport !== 'object' || Array.isArray(viewport)
    || !Number.isFinite(viewport.width) || viewport.width <= 0
    || !Number.isFinite(viewport.height) || viewport.height <= 0
    || !Array.isArray(points) || points.length !== 4
    || points.some((point) => !point || typeof point !== 'object' || Array.isArray(point)
      || !Number.isFinite(point.x) || !Number.isFinite(point.y))
    || !anchor || typeof anchor !== 'object' || Array.isArray(anchor)
    || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)
  ) throw new Error('INVALID_NATIVE_HIGHLIGHT');
  return { viewport, points, anchor } as NativeSimulatorHighlight;
}

function readNativeInput(body: Record<string, any>): NativeSimulatorInput {
  const type = body.type;
  if (type === 'keydown' || type === 'keyup') {
    if (
      typeof body.key !== 'string' || !body.key || body.key.length > 64
      || typeof body.code !== 'string' || !body.code || body.code.length > 64
      || !Number.isInteger(body.keyCode) || body.keyCode < 0 || body.keyCode > 65_535
    ) throw new Error('INVALID_NATIVE_SIMULATOR_KEY');
    return { type, key: body.key, code: body.code, keyCode: body.keyCode };
  }
  if (
    !Number.isInteger(body.x) || body.x < 0
    || !Number.isInteger(body.y) || body.y < 0
    || !Number.isInteger(body.buttons) || body.buttons < 0 || body.buttons > 7
  ) throw new Error('INVALID_NATIVE_SIMULATOR_POINTER');
  if (type === 'wheel') {
    if (!Number.isFinite(body.delta) || Math.abs(body.delta) > 10_000) {
      throw new Error('INVALID_NATIVE_SIMULATOR_WHEEL');
    }
    return { type, x: body.x, y: body.y, buttons: body.buttons, delta: body.delta };
  }
  if (
    (type === 'pointerdown' || type === 'pointermove' || type === 'pointerup')
    && Number.isInteger(body.button) && body.button >= 0 && body.button <= 2
  ) return { type, x: body.x, y: body.y, button: body.button, buttons: body.buttons };
  throw new Error('INVALID_NATIVE_SIMULATOR_INPUT');
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        rejectBody(new Error('WORKBENCH_BODY_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolveBody(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch (error) {
        rejectBody(error);
      }
    });
    request.once('error', rejectBody);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(value));
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
