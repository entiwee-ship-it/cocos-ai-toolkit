import { randomUUID } from 'node:crypto';
import { resolveWebSocketMaxPayload } from '@cocos-ai/protocol';
import WebSocket, { type RawData } from 'ws';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
}

export class ProbeClientError extends Error {
  readonly code: string;
  readonly originalMessage: string;
  readonly details: unknown;
  readonly stage?: string;
  readonly nextAction?: string;

  constructor(readonly payload: ProbeClientErrorPayload) {
    super(formatProbeClientError(payload));
    this.name = 'ProbeClientError';
    this.code = payload.code;
    this.originalMessage = payload.message;
    this.details = payload.details;
    this.stage = payload.stage;
    this.nextAction = payload.nextAction;
  }
}

export class ProbeClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;
  private everConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
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
   */
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 10_000,
    private readonly maxPayload?: number,
    private readonly reconnectBaseMs = 500,
    private readonly reconnectMaxMs = 10_000
  ) {}

  /**
   * 连接 Probe Server 并完成客户端身份握手。
   * 首次握手成功后连接中断会按指数退避自动重连，直到 close()。
   */
  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error('CLIENT_ALREADY_CONNECTED');
    }
    this.disposed = false;
    this.beginConnectionEpoch();
    await this.openSocket();
  }

  /**
   * 向 Probe Server 发送控制请求。
   * 断线重连期间到来的请求会等待连接恢复，等待超过 timeoutMs 报 CLIENT_NOT_CONNECTED。
   *
   * @param method Server 控制方法或 Bridge 探针方法。
   * @param payload JSON 请求参数。
   * @returns Server 返回的 JSON 载荷。
   */
  async request(method: string, payload: unknown): Promise<unknown> {
    await this.waitConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('CLIENT_NOT_CONNECTED');
    }

    const requestId = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      this.registerPending(requestId, resolve, reject);
    });

    socket.send(JSON.stringify({ type: 'request', requestId, method, payload }));
    return response;
  }

  /**
   * 关闭客户端与 Probe Server 的连接，并停止自动重连。
   */
  async close(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.abortPending('SERVER_CONNECTION_CLOSED');
    this.signalDisconnected?.(new Error('CLIENT_NOT_CONNECTED'));
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
        maxPayload: resolveWebSocketMaxPayload(this.maxPayload)
      });
      this.socket = socket;
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };

      socket.on('open', () => {
        this.reconnectAttempt = 0;
        this.registerPending('client.hello', () => settle(() => {
          this.everConnected = true;
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
    if (this.disposed || !this.everConnected) {
      this.signalDisconnected?.(new Error('SERVER_CONNECTION_CLOSED'));
      this.signalConnected = null;
      this.signalDisconnected = null;
      return;
    }

    this.beginConnectionEpoch();
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 重连失败会经由 error/close 事件再次进入 handleClose 继续退避。
      void this.openSocket().catch(() => undefined);
    }, delay);
  }

  private registerPending(
    correlationId: string,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void
  ): void {
    const timeout = setTimeout(() => {
      this.pending.delete(correlationId);
      reject(new Error('SERVER_REQUEST_TIMEOUT'));
    }, this.timeoutMs);
    this.pending.set(correlationId, { resolve, reject, timeout });
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
        ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {})
      };
    }
    return { code: 'SERVER_REQUEST_FAILED', message: 'Server request failed', details: payload };
  }

  private abortPending(code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(code));
    }
    this.pending.clear();
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
