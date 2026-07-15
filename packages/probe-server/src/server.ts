import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolveWebSocketMaxPayload } from '@cocos-ai/protocol';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { RequestRouter } from './request-router.js';
import { SessionRegistry, type SessionSelector } from './session-registry.js';

const BridgeHelloSchema = z.object({
  method: z.literal('bridge.hello'),
  payload: z.object({
    editorInstanceId: z.string().min(1),
    projectId: z.string().min(1),
    projectPath: z.string().min(1),
    creatorVersion: z.string().min(1),
    bridgeVersion: z.string().min(1),
    capabilities: z.array(z.string())
  })
});

const BridgeResponseSchema = z.object({
  type: z.literal('response'),
  correlationId: z.string().min(1),
  ok: z.boolean(),
  payload: z.unknown()
});

const ClientHelloSchema = z.object({
  method: z.literal('client.hello'),
  payload: z.object({
    clientName: z.string().min(1)
  })
});

const ClientRequestSchema = z.object({
  type: z.literal('request'),
  requestId: z.string().min(1),
  method: z.string().min(1),
  payload: z.unknown()
});

const ForwardRequestPayloadSchema = z.object({
  selector: z.object({
    projectId: z.string().min(1),
    editorInstanceId: z.string().min(1).optional()
  }),
  params: z.unknown()
});

export interface ProbeServerOptions {
  /** 仅允许使用的本机监听地址。 */
  host: string;
  /** 监听端口，零表示由系统分配临时端口。 */
  port: number;
  /** 转发 Bridge 请求的等待超时毫秒数。 */
  requestTimeoutMs: number;
  /** WebSocket 单条消息的最大接收字节数。 */
  maxPayload?: number;
}

export interface ProbeServerAddress {
  host: string;
  port: number;
}

export class ProbeServer {
  readonly sessions = new SessionRegistry();

  private readonly requestRouter = new RequestRouter();
  private readonly sockets = new Map<string, WebSocket>();
  private server: WebSocketServer | null = null;

  constructor(private readonly options: ProbeServerOptions) {}

  /**
   * 启动仅监听本机地址的 WebSocket Server。
   *
   * @returns Server 实际监听地址，端口为零时返回系统分配端口。
   */
  async start(): Promise<ProbeServerAddress> {
    if (this.options.host !== '127.0.0.1') {
      throw new Error('PROBE_SERVER_MUST_BIND_LOOPBACK');
    }
    if (this.server) {
      throw new Error('PROBE_SERVER_ALREADY_STARTED');
    }

    const server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      maxPayload: resolveWebSocketMaxPayload(this.options.maxPayload)
    });
    this.server = server;
    server.on('connection', (socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const address = server.address() as AddressInfo;
    return { host: this.options.host, port: address.port };
  }

  /**
   * 向唯一匹配的 Bridge 发送白名单探针请求。
   *
   * @param selector 项目和编辑器实例选择条件。
   * @param method Bridge 探针方法名。
   * @param payload JSON 请求参数。
   * @returns Bridge 响应载荷。
   */
  async request(selector: SessionSelector, method: string, payload: unknown): Promise<unknown> {
    const session = this.sessions.resolve(selector);
    const socket = this.sockets.get(session.editorInstanceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('EDITOR_INSTANCE_DISCONNECTED');
    }

    const requestId = randomUUID();
    const response = this.requestRouter.wait(requestId, this.options.requestTimeoutMs);
    socket.send(JSON.stringify({ type: 'request', requestId, method, payload }));
    return response;
  }

  /**
   * 停止 Server 并终止所有未完成请求。
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.requestRouter.abortAll();
    for (const socket of server.clients) {
      socket.close();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
    this.sockets.clear();
  }

  /**
   * 为单个 WebSocket 连接登记握手、请求和回收逻辑。
   *
   * @param socket 当前接入的 Bridge 或控制客户端连接。
   */
  private handleConnection(socket: WebSocket): void {
    let editorInstanceId: string | null = null;
    let initialized = false;
    let role: 'bridge' | 'client' | null = null;

    socket.on('message', (raw) => {
      const message = this.parseMessage(raw);
      if (!message) {
        socket.close(1008, 'INVALID_JSON');
        return;
      }

      if (!initialized) {
        const helloResult = BridgeHelloSchema.safeParse(message);
        if (helloResult.success) {
          initialized = true;
          role = 'bridge';
          editorInstanceId = helloResult.data.payload.editorInstanceId;
          this.sessions.register(helloResult.data.payload);
          this.sockets.set(editorInstanceId, socket);
          socket.send(JSON.stringify({ type: 'response', correlationId: 'bridge.hello', ok: true, payload: {} }));
          return;
        }

        const clientHelloResult = ClientHelloSchema.safeParse(message);
        if (clientHelloResult.success) {
          initialized = true;
          role = 'client';
          socket.send(JSON.stringify({ type: 'response', correlationId: 'client.hello', ok: true, payload: {} }));
          return;
        }

        socket.close(1008, 'HELLO_REQUIRED');
        return;
      }

      if (role === 'client') {
        const clientRequestResult = ClientRequestSchema.safeParse(message);
        if (!clientRequestResult.success) {
          socket.close(1008, 'INVALID_CLIENT_REQUEST');
          return;
        }

        void this.handleClientRequest(socket, clientRequestResult.data);
        return;
      }

      const responseResult = BridgeResponseSchema.safeParse(message);
      if (!responseResult.success) {
        socket.close(1008, 'INVALID_BRIDGE_RESPONSE');
        return;
      }

      this.requestRouter.complete(
        responseResult.data.correlationId,
        responseResult.data.ok,
        responseResult.data.payload
      );
    });

    socket.on('close', () => {
      if (!editorInstanceId || this.sockets.get(editorInstanceId) !== socket) {
        return;
      }
      this.sockets.delete(editorInstanceId);
      this.sessions.remove(editorInstanceId);
    });
    socket.on('error', () => {
      // ws 会自行处理 1009 等协议错误；其它仍保持打开的异常连接只关闭当前 socket。
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1011, 'SOCKET_ERROR');
      }
    });
  }

  private async handleClientRequest(
    socket: WebSocket,
    request: z.infer<typeof ClientRequestSchema>
  ): Promise<void> {
    try {
      const payload = request.method === 'server.editors'
        ? this.sessions.list()
        : await this.forwardClientRequest(request.method, request.payload);

      socket.send(JSON.stringify({
        type: 'response',
        correlationId: request.requestId,
        ok: true,
        payload
      }));
    } catch (error) {
      socket.send(JSON.stringify({
        type: 'response',
        correlationId: request.requestId,
        ok: false,
        payload: {
          code: error instanceof Error ? error.message : 'UNKNOWN_SERVER_ERROR'
        }
      }));
    }
  }

  private async forwardClientRequest(method: string, payload: unknown): Promise<unknown> {
    const parsedPayload = ForwardRequestPayloadSchema.parse(payload);
    return this.request(parsedPayload.selector, method, parsedPayload.params);
  }

  private parseMessage(raw: RawData): unknown | null {
    try {
      return JSON.parse(raw.toString()) as unknown;
    } catch {
      return null;
    }
  }
}
