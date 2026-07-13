import WebSocket, { type RawData } from 'ws';
import { toProbeErrorPayload } from './probe-errors';

interface BridgeRequest {
  type: 'request';
  requestId: string;
  method: string;
  payload: unknown;
}

export interface BridgeClientOptions {
  url: string;
  sessionToken?: string;
  hello: () => unknown;
  handlers: Readonly<Record<string, (payload: unknown) => Promise<unknown>>>;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  constructor(private readonly options: BridgeClientOptions) {}

  connect(): void {
    if (this.disposed || this.socket) {
      return;
    }

    const headers = this.options.sessionToken
      ? { Authorization: `Bearer ${this.options.sessionToken}` }
      : undefined;
    const socket = new WebSocket(this.options.url, { headers });
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify(this.options.hello()));
    });
    socket.on('message', (raw) => void this.handleMessage(socket, raw));
    socket.on('close', () => this.handleClose(socket));
    socket.on('error', () => {
      socket.close();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private async handleMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const request = this.parseRequest(raw);
    if (!request) {
      return;
    }

    const handler = this.options.handlers[request.method];
    if (!handler) {
      this.sendResponse(socket, request.requestId, false, {
        code: 'METHOD_NOT_ALLOWED',
        details: { method: request.method }
      });
      return;
    }

    try {
      const payload = await handler(request.payload);
      this.sendResponse(socket, request.requestId, true, payload);
    } catch (error) {
      this.sendResponse(socket, request.requestId, false, toProbeErrorPayload(error));
    }
  }

  private parseRequest(raw: RawData): BridgeRequest | null {
    try {
      const value = JSON.parse(raw.toString()) as Partial<BridgeRequest>;
      if (value.type !== 'request' || typeof value.requestId !== 'string' || typeof value.method !== 'string') {
        return null;
      }
      return value as BridgeRequest;
    } catch {
      return null;
    }
  }

  private sendResponse(socket: WebSocket, correlationId: string, ok: boolean, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: 'response', correlationId, ok, payload }));
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    if (this.disposed) {
      return;
    }

    const base = this.options.reconnectBaseMs ?? 500;
    const maximum = this.options.reconnectMaxMs ?? 10_000;
    const delay = Math.min(maximum, base * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
