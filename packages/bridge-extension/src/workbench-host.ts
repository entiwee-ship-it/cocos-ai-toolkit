import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NativeSimulatorHost,
  type NativeSimulatorHostStatus,
  type NativeWindowLayout
} from './native-simulator-host';

const MAX_BODY_BYTES = 1024 * 1024;

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

interface WorkbenchNativeHost {
  getStatus(): NativeSimulatorHostStatus;
  start(layout: NativeWindowLayout): Promise<NativeSimulatorHostStatus>;
  stop(): Promise<void>;
}

type NativeHostFactory = (options: {
  parentProcessId: number;
  childProcessId: number;
  parentTitles: string[];
}) => WorkbenchNativeHost;

/** 人用 Workbench：真实运行树、属性和嵌入窗口都绑定同一 Simulator 会话。 */
export class WorkbenchHost {
  private server: Server | null = null;
  private client: WorkbenchClient | null = null;
  private session: Record<string, any> | null = null;
  private hierarchy: Record<string, any> | null = null;
  private stopHierarchy: (() => Promise<void>) | null = null;
  private nativeHost: WorkbenchNativeHost | null = null;
  private starting: Promise<Record<string, any>> | null = null;
  private state: 'idle' | 'starting' | 'ready' | 'error' = 'idle';
  private lastError: string | null = null;
  private lastUpdateAt: string | null = null;
  private port = 0;

  constructor(
    private readonly selector: WorkbenchSelector,
    client?: WorkbenchClient,
    private readonly createNativeHost: NativeHostFactory = (options) => new NativeSimulatorHost(options)
  ) {
    this.client = client ?? null;
  }

  async start(): Promise<{ url: string }> {
    if (this.server) return { url: this.url() };
    if (!this.client) this.client = await createClient();
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
    await this.detachNativeWindow();
    await this.stopHierarchy?.().catch(() => undefined);
    this.stopHierarchy = null;
    const sessionId = typeof this.session?.sessionId === 'string' ? this.session.sessionId : '';
    if (sessionId) await this.client?.request('server.previewStop', { sessionId }).catch(() => undefined);
    this.session = null;
    await this.client?.close().catch(() => undefined);
    this.client = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
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
    if (request.method === 'POST' && url.pathname === '/api/start') {
      await this.startSession(false);
      sendJson(response, 200, await this.readState());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/reconnect') {
      await this.startSession(true);
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
        componentType
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/property') {
      const body = await readJsonBody(request);
      if (
        typeof body.path !== 'string'
        || !body.path
        || typeof body.componentType !== 'string'
        || !body.componentType
        || typeof body.property !== 'string'
        || !body.property
      ) {
        sendJson(response, 400, { error: 'PROPERTY_WRITE_INPUT_INVALID' });
        return;
      }
      sendJson(response, 200, await this.requireClient().request('server.runtimeSetProperty', {
        sessionId: this.requireSessionId(),
        path: body.path,
        componentType: body.componentType,
        property: body.property,
        value: body.value
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/native-window') {
      const body = await readJsonBody(request);
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
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    await this.serveStatic(url.pathname, response);
  }

  private async startSession(reconnect: boolean): Promise<Record<string, any>> {
    if (this.starting) return this.starting;
    if (!reconnect && this.state === 'ready' && this.session?.state === 'ready') return this.session;
    const starting = (async () => {
      this.state = 'starting';
      this.lastError = null;
      await this.detachNativeWindow();
      await this.stopHierarchy?.().catch(() => undefined);
      this.stopHierarchy = null;
      const previousId = typeof this.session?.sessionId === 'string' ? this.session.sessionId : '';
      if (previousId) await this.requireClient().request('server.previewStop', { sessionId: previousId }).catch(() => undefined);
      const session = await this.requireClient().request('server.previewLaunch', {
        selector: this.selector,
        params: { platform: 'creator-simulator' }
      });
      this.session = session;
      this.hierarchy = null;
      this.stopHierarchy = await this.requireClient().streamRuntimeHierarchy(
        this.requireSessionId(),
        (snapshot) => {
          this.hierarchy = snapshot;
          this.lastUpdateAt = new Date().toISOString();
        },
        {
          intervalMs: 100,
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

  private async readState(): Promise<Record<string, unknown>> {
    const runtime = await this.requireClient().request('probe.simulatorRuntimeStatus', {
      selector: this.selector,
      params: {}
    }).catch((error: unknown) => ({ connected: false, error: readReason(error) }));
    return {
      status: this.state,
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
        error: null
      },
      error: this.lastError
    };
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
        parentTitles: [input.parentTitle, 'Cocos AI 运行工作台', 'Cocos AI Runtime Workbench']
      });
    }
    return this.nativeHost.start(input.layout);
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

async function createClient(): Promise<WorkbenchClient> {
  const entry = pathToFileURL(resolve(__dirname, '..', '..', 'client', 'dist', 'index.js')).href;
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<{ CreatorClient: new () => WorkbenchClient }>;
  const module = await dynamicImport(entry);
  const client = new module.CreatorClient();
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
