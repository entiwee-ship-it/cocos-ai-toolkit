import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { toProbeErrorPayload } from './probe-errors';

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export interface CreatorEndpointDescriptor {
  schemaVersion: 1;
  editorInstanceId: string;
  projectId: string;
  projectPath: string;
  creatorVersion: string;
  bridgeVersion: string;
  bridgeBuildId?: string;
  capabilities: string[];
  processId: number;
  pipeName: string;
  startedAt: string;
}

export interface CreatorIpcServerStatus {
  state: 'idle' | 'starting' | 'ready' | 'stopped' | 'error';
  pipeName: string;
  endpointFile: string;
  activeRequests: number;
  totalRequests: number;
  lastRequestAt: string | null;
  lastError: string | null;
}

export type CreatorIpcLifecycleEvent =
  | { type: 'starting'; pipeName: string }
  | { type: 'ready'; pipeName: string; endpointFile: string }
  | { type: 'request-failed'; method?: string; reason: string }
  | { type: 'stopped'; pipeName: string };

export interface CreatorIpcServerOptions {
  describe(): CreatorEndpointDescriptor;
  handlers: Readonly<Record<string, (payload: unknown) => Promise<unknown>>>;
  endpointRoot?: string;
  maxPayloadBytes?: number;
  requestTimeoutMs?: number;
  onLifecycleEvent?: (event: CreatorIpcLifecycleEvent) => void;
}

interface IpcRequest {
  type: 'request';
  requestId: string;
  method: string;
  payload: unknown;
}

/** Creator 主进程内的本机命名管道端点；每条连接只处理一个请求。 */
export class CreatorIpcServer {
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private state: CreatorIpcServerStatus['state'] = 'idle';
  private activeRequests = 0;
  private totalRequests = 0;
  private lastRequestAt: string | null = null;
  private lastError: string | null = null;
  private descriptor: CreatorEndpointDescriptor | null = null;

  constructor(private readonly options: CreatorIpcServerOptions) {}

  async start(): Promise<CreatorIpcServerStatus> {
    if (this.server) throw new Error('CREATOR_IPC_ALREADY_STARTED');
    const descriptor = this.options.describe();
    this.descriptor = descriptor;
    this.state = 'starting';
    this.emit({ type: 'starting', pipeName: descriptor.pipeName });

    const server = createServer({ allowHalfOpen: true }, (socket) => this.handleConnection(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(descriptor.pipeName, () => {
          server.off('error', onError);
          resolve();
        });
      });
      writeEndpointDescriptor(descriptor, this.options.endpointRoot);
      this.state = 'ready';
      this.emit({
        type: 'ready',
        pipeName: descriptor.pipeName,
        endpointFile: endpointFilePath(descriptor, this.options.endpointRoot)
      });
      server.on('error', (error) => {
        this.state = 'error';
        this.lastError = error.message;
        this.emit({ type: 'request-failed', reason: error.message });
      });
      return this.getStatus();
    } catch (error) {
      this.server = null;
      this.state = 'error';
      this.lastError = readReason(error);
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    const descriptor = this.descriptor;
    this.server = null;
    if (descriptor) removeEndpointDescriptor(descriptor, this.options.endpointRoot);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.state = 'stopped';
    if (descriptor) this.emit({ type: 'stopped', pipeName: descriptor.pipeName });
  }

  getStatus(): CreatorIpcServerStatus {
    const descriptor = this.descriptor ?? this.options.describe();
    return {
      state: this.state,
      pipeName: descriptor.pipeName,
      endpointFile: endpointFilePath(descriptor, this.options.endpointRoot),
      activeRequests: this.activeRequests,
      totalRequests: this.totalRequests,
      lastRequestAt: this.lastRequestAt,
      lastError: this.lastError
    };
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('CREATOR_IPC_REQUEST_TIMEOUT')));
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', (error) => {
      this.lastError = error.message;
    });
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      const newline = chunk.indexOf(10);
      const part = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      chunks.push(part);
      bytes += part.byteLength;
      if (bytes > (this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)) {
        handled = true;
        this.respond(socket, 'invalid', false, {
          code: 'IPC_PAYLOAD_TOO_LARGE',
          message: 'IPC_PAYLOAD_TOO_LARGE',
          details: { maxPayloadBytes: this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES }
        });
        return;
      }
      if (newline < 0) return;
      handled = true;
      void this.handleRequest(socket, Buffer.concat(chunks, bytes).toString('utf8'));
    });
  }

  private async handleRequest(socket: Socket, raw: string): Promise<void> {
    let request: IpcRequest;
    try {
      const value = JSON.parse(raw) as Partial<IpcRequest>;
      if (
        value.type !== 'request'
        || typeof value.requestId !== 'string'
        || !value.requestId
        || typeof value.method !== 'string'
        || !value.method
      ) {
        this.respond(socket, 'invalid', false, {
          code: 'INVALID_IPC_REQUEST',
          message: 'INVALID_IPC_REQUEST',
          details: {}
        });
        return;
      }
      request = value as IpcRequest;
    } catch (error) {
      this.respond(socket, 'invalid', false, toProbeErrorPayload(error));
      return;
    }

    this.activeRequests += 1;
    this.totalRequests += 1;
    this.lastRequestAt = new Date().toISOString();
    try {
      if (request.method === 'bridge.describe') {
        this.respond(socket, request.requestId, true, this.options.describe());
        return;
      }
      const handler = this.options.handlers[request.method];
      if (!handler) {
        this.respond(socket, request.requestId, false, {
          code: 'METHOD_NOT_ALLOWED',
          message: 'METHOD_NOT_ALLOWED',
          details: { method: request.method }
        });
        return;
      }
      this.respond(socket, request.requestId, true, await handler(request.payload));
    } catch (error) {
      this.lastError = readReason(error);
      this.emit({ type: 'request-failed', method: request.method, reason: this.lastError });
      this.respond(socket, request.requestId, false, toProbeErrorPayload(error));
    } finally {
      this.activeRequests -= 1;
    }
  }

  private respond(socket: Socket, correlationId: string, ok: boolean, payload: unknown): void {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify({ type: 'response', correlationId, ok, payload })}\n`);
  }

  private emit(event: CreatorIpcLifecycleEvent): void {
    try {
      this.options.onLifecycleEvent?.(event);
    } catch {
      // 管理日志失败不能影响 Creator 编辑通道。
    }
  }
}

export function buildCreatorPipeName(editorInstanceId: string): string {
  const id = createHash('sha256').update(editorInstanceId).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\cocos-ai-creator-${id}`;
}

export function resolveCreatorEndpointRoot(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  return environment.COCOS_AI_ENDPOINT_ROOT
    ?? join(environment.LOCALAPPDATA ?? tmpdir(), 'CocosAI', 'creator-endpoints');
}

function endpointFilePath(descriptor: CreatorEndpointDescriptor, endpointRoot?: string): string {
  const root = endpointRoot ?? resolveCreatorEndpointRoot();
  const id = createHash('sha256').update(descriptor.editorInstanceId).digest('hex').slice(0, 16);
  return join(root, `${descriptor.processId}-${id}.json`);
}

function writeEndpointDescriptor(descriptor: CreatorEndpointDescriptor, endpointRoot?: string): void {
  const filePath = endpointFilePath(descriptor, endpointRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { encoding: 'utf8', mode: 0o600 });
  rmSync(filePath, { force: true });
  renameSync(temporary, filePath);
}

function removeEndpointDescriptor(descriptor: CreatorEndpointDescriptor, endpointRoot?: string): void {
  rmSync(endpointFilePath(descriptor, endpointRoot), { force: true });
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
