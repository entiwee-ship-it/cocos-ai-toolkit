import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolveWebSocketMaxPayload } from '@cocos-ai/protocol';
import WebSocket, { type RawData } from 'ws';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
  requestId: string;
  startedAt: number;
  requestBytes: number;
  editorInstanceId?: string;
}

interface ServerResponse {
  type: 'response';
  correlationId: string;
  ok: boolean;
  payload: unknown;
}

export interface ProbeClientErrorPayload {
  code: string;
  message: string;
  details: unknown;
  stage?: string;
  nextAction?: string;
  retryable?: boolean;
}

export interface ProbeClientStatus {
  url: string;
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
  reconnectAttempt: number;
  nextRetryAt: string | null;
}

export class ProbeClientError extends Error {
  readonly code: string;
  readonly originalMessage: string;
  readonly details: unknown;
  readonly stage?: string;
  readonly nextAction?: string;
  readonly retryable: boolean;

  constructor(readonly payload: ProbeClientErrorPayload) {
    super(formatProbeClientError(payload));
    this.name = 'ProbeClientError';
    this.code = payload.code;
    this.originalMessage = payload.message;
    this.details = payload.details;
    this.stage = payload.stage;
    this.nextAction = payload.nextAction;
    this.retryable = payload.retryable === true;
  }
}

export class ProbeClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private nextRetryAt: number | null = null;
  private connectedPromise: Promise<void> | null = null;
  private signalConnected: (() => void) | null = null;
  private signalDisconnected: ((error: Error) => void) | null = null;

  /**
   * 创建共享 Probe Server 客户端。
   *
   * @param url Probe Server WebSocket 地址。
   * @param timeoutMs 单次请求等待超时毫秒数。
   * @param maxPayload WebSocket 单条消息的最大接收字节数。
   * @param reconnectBaseMs 断线重连基础退避毫秒数。
   * @param reconnectMaxMs 断线重连最大退避毫秒数。
   * @param sessionToken 可选 WebSocket Bearer Token；服务端未启用认证时留空。
   */
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 10_000,
    private readonly maxPayload?: number,
    private readonly reconnectBaseMs = 500,
    private readonly reconnectMaxMs = 10_000,
    private readonly sessionToken?: string
  ) {}

  /**
   * 连接 Probe Server 并完成客户端身份握手。
   * 首次连接失败或握手后中断都会按带抖动的指数退避自动重连，直到 close()。
   */
  async connect(): Promise<void> {
    if (this.socket || this.reconnectTimer || this.connectedPromise) {
      throw new Error('CLIENT_ALREADY_CONNECTED');
    }
    this.disposed = false;
    this.beginConnectionEpoch();
    void this.openSocket().catch(() => undefined);
    await this.waitConnected();
  }

  /**
   * 向 Probe Server 发送控制请求。
   * 后端离线时立即返回 PROBE_SERVER_UNAVAILABLE；恢复后同一实例可直接继续请求。
   *
   * @param method Server 控制方法或 Bridge 探针方法。
   * @param payload JSON 请求参数。
   * @returns Server 返回的 JSON 载荷。
   */
  async request(method: string, payload: unknown): Promise<unknown> {
    if (!this.connected) {
      throw new ProbeClientError({
        code: 'PROBE_SERVER_UNAVAILABLE',
        message: 'Probe Server 当前不可用',
        details: this.getStatus(),
        nextAction: '等待 Creator Bridge 自动启动 Probe，或确认 127.0.0.1:32188 监听后重试',
        retryable: true
      });
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('CLIENT_NOT_CONNECTED');
    }

    const requestId = randomUUID();
    const message = JSON.stringify({ type: 'request', requestId, method, payload });
    const response = new Promise<unknown>((resolve, reject) => {
      this.registerPending(requestId, method, payload, Buffer.byteLength(message, 'utf8'), resolve, reject);
    });

    socket.send(message);
    return response;
  }

  /** 返回当前连接状态，供 MCP 在 Probe 离线时生成可行动结果。 */
  getStatus(): ProbeClientStatus {
    const state = this.disposed
      ? 'closed'
      : this.connected
        ? 'connected'
        : this.reconnectTimer
          ? 'reconnecting'
          : this.socket
            ? 'connecting'
            : 'idle';
    return {
      url: this.url,
      state,
      reconnectAttempt: this.reconnectAttempt,
      nextRetryAt: this.nextRetryAt === null ? null : new Date(this.nextRetryAt).toISOString()
    };
  }

  /**
   * 关闭客户端与 Probe Server 的连接，并停止自动重连。
   */
  async close(): Promise<void> {
    this.disposed = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextRetryAt = null;
    const socket = this.socket;
    this.socket = null;
    this.abortPending('SERVER_CONNECTION_CLOSED');
    this.signalDisconnected?.(new Error('CLIENT_NOT_CONNECTED'));
    this.connectedPromise = null;
    this.signalConnected = null;
    this.signalDisconnected = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.close();
    });
  }

  /** 建立一次 WebSocket 连接，握手成功后标记当前连接可用。 */
  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        maxPayload: resolveWebSocketMaxPayload(this.maxPayload),
        ...(this.sessionToken ? { headers: { Authorization: `Bearer ${this.sessionToken}` } } : {})
      });
      this.socket = socket;
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };

      socket.on('open', () => {
        this.nextRetryAt = null;
        this.registerPending('client.hello', 'client.hello', {}, 0, () => settle(() => {
          this.connected = true;
          this.reconnectAttempt = 0;
          this.signalConnected?.();
          this.signalConnected = null;
          this.signalDisconnected = null;
          resolve();
        }), (error) => settle(() => reject(error)));
        socket.send(JSON.stringify({
          method: 'client.hello',
          payload: { clientName: 'cocos-ai-probe-cli' }
        }));
      });
      socket.on('message', (raw) => this.handleMessage(raw));
      socket.on('close', () => this.handleClose(socket));
      socket.on('error', (error) => {
        this.abortPending(error.message);
        settle(() => reject(error));
        socket.terminate();
      });
    });
  }

  /** 为等待连接恢复的请求开启一个新的连接纪元。 */
  private beginConnectionEpoch(): void {
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.signalConnected = resolve;
      this.signalDisconnected = reject;
    });
    // 连接纪元可能在没有请求等待时被 close() 终止，预挂拒绝处理避免未处理 Promise。
    void this.connectedPromise.catch(() => undefined);
  }

  /** 等待当前连接纪元的握手完成；从未连接或等待超时时报未连接。 */
  private async waitConnected(): Promise<void> {
    const connected = this.connectedPromise;
    if (!connected) {
      throw new Error('CLIENT_NOT_CONNECTED');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connected,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('CLIENT_NOT_CONNECTED')), this.timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 连接关闭：终止在途请求；首次握手成功过的连接按指数退避自动重连。 */
  private handleClose(socket: WebSocket): void {
    this.abortPending('SERVER_CONNECTION_CLOSED');
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    const wasConnected = this.connected;
    this.connected = false;
    if (this.disposed) {
      this.signalDisconnected?.(new Error('SERVER_CONNECTION_CLOSED'));
      this.signalConnected = null;
      this.signalDisconnected = null;
      return;
    }
    if (wasConnected || !this.connectedPromise) this.beginConnectionEpoch();
    this.scheduleReconnect();
  }

  /** 按带抖动的指数退避安排下一次连接，首次连接失败同样持续恢复。 */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const baseDelay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt));
    const delay = Math.min(
      this.reconnectMaxMs,
      baseDelay + Math.floor(baseDelay * 0.2 * Math.random())
    );
    this.reconnectAttempt += 1;
    this.nextRetryAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextRetryAt = null;
      void this.openSocket().catch(() => undefined);
    }, delay);
  }

  private registerPending(
    correlationId: string,
    method: string,
    payload: unknown,
    requestBytes: number,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void
  ): void {
    const startedAt = performance.now();
    const timeout = setTimeout(() => {
      const pending = this.pending.get(correlationId);
      this.pending.delete(correlationId);
      if (pending) this.logRequest(pending, 0, 'timeout');
      reject(new ProbeClientError({
        code: 'SERVER_REQUEST_TIMEOUT',
        message: 'Probe Server 请求超时',
        details: {
          method,
          requestId: correlationId,
          timeoutMs: this.timeoutMs,
          elapsedMs: Math.round(performance.now() - startedAt)
        },
        nextAction: '确认 Probe 与 Creator Bridge 仍在线后重试只读请求；写请求先重读状态',
        retryable: !isPotentialWriteMethod(method)
      }));
    }, this.timeoutMs);
    this.pending.set(correlationId, {
      resolve,
      reject,
      timeout,
      method,
      requestId: correlationId,
      startedAt,
      requestBytes,
      ...readEditorTarget(payload)
    });
  }

  private handleMessage(raw: RawData): void {
    let response: ServerResponse;
    try {
      response = JSON.parse(raw.toString()) as ServerResponse;
    } catch {
      this.abortPending('INVALID_SERVER_RESPONSE');
      return;
    }

    const pending = this.pending.get(response.correlationId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.correlationId);
    this.logRequest(pending, Buffer.byteLength(raw.toString(), 'utf8'), response.ok ? 'success' : 'error');
    if (response.ok) {
      pending.resolve(response.payload);
      return;
    }

    pending.reject(new ProbeClientError(this.readErrorPayload(response.payload)));
  }

  private readErrorPayload(payload: unknown): ProbeClientErrorPayload {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const code = typeof record.code === 'string' && record.code
        ? record.code
        : 'SERVER_REQUEST_FAILED';
      return {
        code,
        message: typeof record.message === 'string' && record.message ? record.message : code,
        details: record.details ?? {},
        ...(typeof record.stage === 'string' ? { stage: record.stage } : {}),
        ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {}),
        ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {})
      };
    }
    return { code: 'SERVER_REQUEST_FAILED', message: 'Server request failed', details: payload };
  }

  private abortPending(code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      this.logRequest(pending, 0, 'connection-closed');
      const outcomeUnknown = isPotentialWriteMethod(pending.method);
      pending.reject(new ProbeClientError({
        code: outcomeUnknown ? 'OUTCOME_UNKNOWN' : code,
        message: outcomeUnknown ? '连接中断，写入结局未知' : code,
        details: {
          method: pending.method,
          requestId: pending.requestId,
          elapsedMs: Math.round(performance.now() - pending.startedAt)
        },
        ...(outcomeUnknown ? { nextAction: '先重读当前文档或资产状态；确认结局前禁止重试写入' } : {}),
        retryable: !outcomeUnknown
      }));
    }
    this.pending.clear();
  }

  /** 仅记录慢请求或大载荷，不输出业务 payload。 */
  private logRequest(pending: PendingRequest, responseBytes: number, outcome: string): void {
    const elapsedMs = performance.now() - pending.startedAt;
    const threshold = slowRequestThresholdMs(pending.method);
    const payloadThreshold = slowPayloadThresholdBytes(pending.method);
    if (
      process.env.COCOS_AI_REQUEST_LOG !== 'debug'
      && elapsedMs < threshold
      && pending.requestBytes < payloadThreshold
      && responseBytes < payloadThreshold
    ) return;
    process.stderr.write(`${JSON.stringify({
      type: 'cocos-ai.request',
      layer: 'probe-client',
      method: pending.method,
      requestId: pending.requestId,
      ...(pending.editorInstanceId ? { editorInstanceId: pending.editorInstanceId } : {}),
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      requestBytes: pending.requestBytes,
      responseBytes,
      outcome
    })}\n`);
  }
}

function formatProbeClientError(payload: ProbeClientErrorPayload): string {
  return [
    payload.code,
    payload.message !== payload.code ? payload.message : null,
    payload.stage ? `stage=${payload.stage}` : null,
    payload.details && typeof payload.details === 'object'
      ? `details=${JSON.stringify(payload.details)}`
      : null,
    payload.nextAction ? `nextAction=${payload.nextAction}` : null
  ].filter(Boolean).join(': ');
}

function readEditorTarget(payload: unknown): { editorInstanceId?: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const selector = (payload as { selector?: unknown }).selector;
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return {};
  const editorInstanceId = (selector as { editorInstanceId?: unknown }).editorInstanceId;
  return typeof editorInstanceId === 'string' && editorInstanceId ? { editorInstanceId } : {};
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

function slowPayloadThresholdBytes(method: string): number {
  return method === 'probe.assetIndex' ? 1024 * 1024 : 256 * 1024;
}
