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

export class ProbeClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  /**
   * 创建共享 Probe Server 客户端。
   *
   * @param url Probe Server WebSocket 地址。
   * @param timeoutMs 单次请求等待超时毫秒数。
   * @param maxPayload WebSocket 单条消息的最大接收字节数。
   */
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 10_000,
    private readonly maxPayload?: number
  ) {}

  /**
   * 连接 Probe Server 并完成客户端身份握手。
   */
  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error('CLIENT_ALREADY_CONNECTED');
    }

    const socket = new WebSocket(this.url, {
      maxPayload: resolveWebSocketMaxPayload(this.maxPayload)
    });
    this.socket = socket;
    socket.on('message', (raw) => this.handleMessage(raw));
    socket.on('close', () => this.abortPending('SERVER_CONNECTION_CLOSED'));
    socket.on('error', (error) => this.abortPending(error.message));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        this.registerPending('client.hello', () => resolve(), reject);
        socket.send(JSON.stringify({
          method: 'client.hello',
          payload: { clientName: 'cocos-ai-probe-cli' }
        }));
      });
      socket.once('error', reject);
    });
  }

  /**
   * 向 Probe Server 发送控制请求。
   *
   * @param method Server 控制方法或 Bridge 探针方法。
   * @param payload JSON 请求参数。
   * @returns Server 返回的 JSON 载荷。
   */
  async request(method: string, payload: unknown): Promise<unknown> {
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
   * 关闭客户端与 Probe Server 的连接。
   */
  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    if (socket.readyState === WebSocket.CLOSED) {
      this.socket = null;
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.close();
    });
    this.socket = null;
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

    const code = this.readErrorCode(response.payload);
    pending.reject(new Error(code));
  }

  private readErrorCode(payload: unknown): string {
    if (payload && typeof payload === 'object' && 'code' in payload) {
      const code = (payload as { code?: unknown }).code;
      if (typeof code === 'string') {
        return code;
      }
    }
    return 'SERVER_REQUEST_FAILED';
  }

  private abortPending(code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(code));
    }
    this.pending.clear();
  }
}
