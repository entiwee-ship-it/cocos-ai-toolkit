import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RUNTIME_METHODS, RuntimeController } from './runtime-controller.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

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

export interface CreatorClientErrorPayload {
  code: string;
  message: string;
  details: unknown;
  stage?: string;
  nextAction?: string;
  retryable?: boolean;
}

export interface CreatorClientStatus {
  transport: 'named-pipe';
  state: 'idle' | 'ready' | 'closed';
  endpointRoot: string;
}

export interface CreatorClientOptions {
  requestTimeoutMs?: number;
  maxPayloadBytes?: number;
  endpointRoot?: string;
  captureRoot?: string;
}

export class CreatorClientError extends Error {
  readonly code: string;
  readonly originalMessage: string;
  readonly details: unknown;
  readonly stage?: string;
  readonly nextAction?: string;
  readonly retryable?: boolean;

  constructor(readonly payload: CreatorClientErrorPayload) {
    super(formatCreatorClientError(payload));
    this.name = 'CreatorClientError';
    this.code = payload.code;
    this.originalMessage = payload.message;
    this.details = payload.details;
    this.stage = payload.stage;
    this.nextAction = payload.nextAction;
    this.retryable = payload.retryable;
  }
}

/** MCP/CLI 到 Creator 的短连接客户端；不监听端口，也不维护后台连接。 */
export class CreatorClient {
  private readonly endpointRoot: string;
  private readonly requestTimeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly runtime: RuntimeController;
  private readonly sockets = new Set<Socket>();
  private state: CreatorClientStatus['state'] = 'idle';

  constructor(private readonly options: CreatorClientOptions = {}) {
    this.endpointRoot = options.endpointRoot ?? resolveCreatorEndpointRoot();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.runtime = new RuntimeController({
      requestCreator: (selector, method, payload) => this.requestCreator(selector, method, payload),
      captureRoot: options.captureRoot ?? defaultCaptureRoot()
    });
  }

  /** stdio MCP 启动时只初始化本地客户端，不连接 Creator。 */
  async connect(): Promise<void> {
    if (this.state === 'ready') throw new Error('CLIENT_ALREADY_CONNECTED');
    this.state = 'ready';
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    if (this.state !== 'ready') {
      throw new CreatorClientError({
        code: 'CREATOR_CLIENT_NOT_READY',
        message: 'Creator IPC 客户端尚未启动',
        details: this.getStatus(),
        retryable: true
      });
    }
    if (method === 'server.editors') {
      return (await this.discoverLiveEndpoints()).map(({ descriptor }) => toEditorSession(descriptor));
    }
    if (RUNTIME_METHODS.has(method)) {
      return this.runtime.request(method, payload);
    }
    const request = readForwardRequest(payload);
    return this.requestCreator(request.selector, method, request.params);
  }

  getStatus(): CreatorClientStatus {
    return {
      transport: 'named-pipe',
      state: this.state,
      endpointRoot: this.endpointRoot
    };
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await this.runtime.dispose();
  }

  private async requestCreator(
    selector: { projectId: string; editorInstanceId?: string },
    method: string,
    payload: unknown
  ): Promise<unknown> {
    const endpoints = await this.discoverLiveEndpoints();
    const matches = endpoints.filter(({ descriptor }) => (
      descriptor.projectId === selector.projectId
      && (!selector.editorInstanceId || descriptor.editorInstanceId === selector.editorInstanceId)
    ));
    if (matches.length === 0) throw new Error('EDITOR_INSTANCE_NOT_FOUND');
    if (matches.length > 1) throw new Error('MULTIPLE_EDITOR_INSTANCES');
    return this.send(matches[0].descriptor.pipeName, method, payload);
  }

  private async discoverLiveEndpoints(): Promise<Array<{ descriptor: CreatorEndpointDescriptor }>> {
    let files: string[];
    try {
      files = (await readdir(this.endpointRoot)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if (readNodeErrorCode(error) === 'ENOENT') return [];
      throw error;
    }

    const descriptors = (await Promise.all(files.map(async (name) => {
      const filePath = join(this.endpointRoot, name);
      try {
        const value = JSON.parse(await readFile(filePath, 'utf8'));
        if (isCreatorEndpointDescriptor(value)) return { descriptor: value, filePath };
      } catch {
        // 无效或半写入描述文件不应长期污染发现目录。
      }
      await unlink(filePath).catch(() => undefined);
      return null;
    }))).filter((value): value is { descriptor: CreatorEndpointDescriptor; filePath: string } => Boolean(value));

    const live = await Promise.all(descriptors.map(async ({ descriptor, filePath }) => {
      try {
        const described = await this.send(descriptor.pipeName, 'bridge.describe', {});
        if (!isCreatorEndpointDescriptor(described)) {
          await unlink(filePath).catch(() => undefined);
          return null;
        }
        if (
          described.editorInstanceId !== descriptor.editorInstanceId
          || described.projectId !== descriptor.projectId
          || described.pipeName !== descriptor.pipeName
        ) {
          await unlink(filePath).catch(() => undefined);
          return null;
        }
        return { descriptor: described };
      } catch {
        await unlink(filePath).catch(() => undefined);
        return null;
      }
    }));
    return live.filter((value): value is { descriptor: CreatorEndpointDescriptor } => Boolean(value));
  }

  private send(pipeName: string, method: string, payload: unknown): Promise<unknown> {
    const requestId = randomUUID();
    const request = `${JSON.stringify({
      type: 'request',
      requestId,
      method,
      payload
    })}\n`;
    const requestBytes = Buffer.byteLength(request);
    const startedAt = performance.now();

    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      let settled = false;
      let requestSent = false;
      let responseBytes = 0;
      const chunks: Buffer[] = [];
      const socket = createConnection(pipeName);
      this.sockets.add(socket);

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        this.sockets.delete(socket);
        socket.destroy();
        action();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        const reason = error instanceof Error ? error.message : String(error);
        const outcomeUnknown = requestSent && isPotentialWriteMethod(method);
        const timedOut = reason === 'CREATOR_IPC_REQUEST_TIMEOUT';
        const tooLarge = reason === 'IPC_PAYLOAD_TOO_LARGE';
        this.logRequest(method, requestId, startedAt, requestBytes, responseBytes, 'error');
        finish(() => rejectRequest(new CreatorClientError({
          code: outcomeUnknown
            ? 'OUTCOME_UNKNOWN'
            : timedOut
              ? 'CREATOR_IPC_REQUEST_TIMEOUT'
              : tooLarge
                ? 'IPC_PAYLOAD_TOO_LARGE'
                : 'CREATOR_IPC_UNAVAILABLE',
          message: outcomeUnknown
            ? '连接中断，写入结局未知'
            : timedOut
              ? 'Creator IPC 请求超时'
              : tooLarge
                ? 'Creator IPC 响应超过接收上限'
                : 'Creator IPC 不可达',
          details: {
            method,
            requestId,
            pipeName,
            reason,
            elapsedMs: Math.round(performance.now() - startedAt)
          },
          ...(outcomeUnknown
            ? { nextAction: '先重读当前文档或资产状态；确认结局前禁止重试写入' }
            : { retryable: !tooLarge })
        })));
      };

      socket.setTimeout(this.requestTimeoutMs, () => fail(new Error('CREATOR_IPC_REQUEST_TIMEOUT')));
      socket.once('connect', () => {
        try {
          requestSent = true;
          socket.write(request);
        } catch (error) {
          fail(error);
        }
      });
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        const newline = chunk.indexOf(10);
        const part = newline >= 0 ? chunk.subarray(0, newline) : chunk;
        chunks.push(part);
        responseBytes += part.byteLength;
        if (responseBytes > this.maxPayloadBytes) {
          fail(new Error('IPC_PAYLOAD_TOO_LARGE'));
          return;
        }
        if (newline < 0) return;
        try {
          const response = JSON.parse(Buffer.concat(chunks, responseBytes).toString('utf8')) as {
            type?: unknown;
            correlationId?: unknown;
            ok?: unknown;
            payload?: unknown;
          };
          if (response.type !== 'response' || response.correlationId !== requestId) {
            throw new Error('INVALID_IPC_RESPONSE');
          }
          this.logRequest(
            method,
            requestId,
            startedAt,
            requestBytes,
            responseBytes,
            response.ok === true ? 'success' : 'error'
          );
          if (response.ok === true) {
            finish(() => resolveRequest(response.payload));
            return;
          }
          finish(() => rejectRequest(new CreatorClientError(readErrorPayload(response.payload))));
        } catch (error) {
          fail(error);
        }
      });
      socket.once('error', fail);
      socket.once('close', () => {
        if (!settled) fail(new Error('CREATOR_IPC_CONNECTION_CLOSED'));
      });
    });
  }

  private logRequest(
    method: string,
    requestId: string,
    startedAt: number,
    requestBytes: number,
    responseBytes: number,
    outcome: string
  ): void {
    const elapsedMs = performance.now() - startedAt;
    const threshold = slowRequestThresholdMs(method);
    const payloadThreshold = method === 'probe.assetIndex' ? 1024 * 1024 : 256 * 1024;
    if (
      process.env.COCOS_AI_REQUEST_LOG !== 'debug'
      && elapsedMs < threshold
      && requestBytes < payloadThreshold
      && responseBytes < payloadThreshold
    ) return;
    process.stderr.write(`${JSON.stringify({
      type: 'cocos-ai.request',
      layer: 'creator-ipc-client',
      method,
      requestId,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      requestBytes,
      responseBytes,
      outcome
    })}\n`);
  }
}

export function resolveCreatorEndpointRoot(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  return environment.COCOS_AI_ENDPOINT_ROOT
    ?? join(environment.LOCALAPPDATA ?? tmpdir(), 'CocosAI', 'creator-endpoints');
}

function defaultCaptureRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'reports', 'runtime-captures');
}

function readForwardRequest(payload: unknown): {
  selector: { projectId: string; editorInstanceId?: string };
  params: unknown;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_REQUEST');
  const record = payload as Record<string, unknown>;
  const selector = record.selector;
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error('INVALID_REQUEST');
  const selectorRecord = selector as Record<string, unknown>;
  if (typeof selectorRecord.projectId !== 'string' || !selectorRecord.projectId) {
    throw new Error('PROJECT_ID_REQUIRED');
  }
  const editorInstanceId = selectorRecord.editorInstanceId;
  if (editorInstanceId !== undefined && (typeof editorInstanceId !== 'string' || !editorInstanceId)) {
    throw new Error('INVALID_EDITOR_INSTANCE_ID');
  }
  return {
    selector: {
      projectId: selectorRecord.projectId,
      ...(typeof editorInstanceId === 'string' ? { editorInstanceId } : {})
    },
    params: record.params
  };
}

function isCreatorEndpointDescriptor(value: unknown): value is CreatorEndpointDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.editorInstanceId === 'string'
    && Boolean(record.editorInstanceId)
    && typeof record.projectId === 'string'
    && Boolean(record.projectId)
    && typeof record.projectPath === 'string'
    && Boolean(record.projectPath)
    && typeof record.creatorVersion === 'string'
    && typeof record.bridgeVersion === 'string'
    && Array.isArray(record.capabilities)
    && record.capabilities.every((item) => typeof item === 'string')
    && Number.isInteger(record.processId)
    && typeof record.pipeName === 'string'
    && Boolean(record.pipeName)
    && typeof record.startedAt === 'string';
}

function toEditorSession(descriptor: CreatorEndpointDescriptor) {
  return {
    editorInstanceId: descriptor.editorInstanceId,
    projectId: descriptor.projectId,
    projectPath: descriptor.projectPath,
    creatorVersion: descriptor.creatorVersion,
    bridgeVersion: descriptor.bridgeVersion,
    ...(descriptor.bridgeBuildId ? { bridgeBuildId: descriptor.bridgeBuildId } : {}),
    capabilities: [...descriptor.capabilities]
  };
}

function readErrorPayload(payload: unknown): CreatorClientErrorPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { code: 'CREATOR_REQUEST_FAILED', message: 'Creator request failed', details: payload };
  }
  const record = payload as Record<string, unknown>;
  const code = typeof record.code === 'string' && record.code ? record.code : 'CREATOR_REQUEST_FAILED';
  return {
    code,
    message: typeof record.message === 'string' && record.message ? record.message : code,
    details: record.details ?? {},
    ...(typeof record.stage === 'string' ? { stage: record.stage } : {}),
    ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {})
  };
}

function formatCreatorClientError(payload: CreatorClientErrorPayload): string {
  return [
    payload.code,
    payload.message !== payload.code ? payload.message : null,
    payload.stage ? `stage=${payload.stage}` : null,
    payload.details && typeof payload.details === 'object' ? `details=${JSON.stringify(payload.details)}` : null,
    payload.nextAction ? `nextAction=${payload.nextAction}` : null
  ].filter(Boolean).join(': ');
}

function readNodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
}

function isPotentialWriteMethod(method: string): boolean {
  return method === 'probe.directWrite'
    || method === 'probe.saveDocument'
    || method === 'probe.importAsset'
    || method === 'probe.deleteAsset'
    || method === 'probe.refreshAsset';
}

function slowRequestThresholdMs(method: string): number {
  if (method === 'probe.assetIndex' || method === 'probe.assetSearch') return 150;
  if (method === 'probe.node' || method === 'probe.hierarchy') return 50;
  if (method === 'probe.directWrite') return 2_000;
  if (method === 'server.previewLaunch') return 5_000;
  return 1_000;
}
