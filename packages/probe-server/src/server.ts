import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { resolveWebSocketMaxPayload, ResolutionSchema, RuntimeComponentSnapshotSchema, ScenarioStepSchema } from '@cocos-ai/protocol';
import { assembleRuntimeNodeSnapshot, buildRuntimeScript, diffPng, runRuntimeScenario, RuntimeDriver, watchRuntimeProperty, type ScenarioRuntime } from '@cocos-ai/core';
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

const PreviewLaunchPayloadSchema = z.object({
  selector: z.object({
    projectId: z.string().min(1),
    editorInstanceId: z.string().min(1).optional()
  }),
  params: z.object({
    resolution: ResolutionSchema.optional(),
    channel: z.string().min(1).optional()
  }).optional()
});

const PreviewSessionPayloadSchema = z.object({
  sessionId: z.string().min(1)
});

const PreviewSessionsPayloadSchema = z.object({
  projectId: z.string().min(1).optional()
});

const RuntimeConsolePayloadSchema = z.object({
  sessionId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional()
});

const RUNTIME_METHODS = new Set([
  'server.previewLaunch',
  'server.previewStop',
  'server.previewSessions',
  'server.previewSession',
  'server.runtimeConsole',
  'server.runtimeHierarchy',
  'server.runtimeComponent',
  'server.runtimeInvoke',
  'server.runtimeWatch',
  'server.runtimeDispatchInput',
  'server.runtimeCapture',
  'server.runtimeRunScenario',
  'server.runtimeInstantiate'
]);

const RuntimeInstantiatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  assetUuid: z.string().min(1),
  parentPath: z.string().min(1),
  x: z.number().optional(),
  y: z.number().optional()
});

const RuntimeRunScenarioPayloadSchema = z.object({
  selector: z.object({
    projectId: z.string().min(1),
    editorInstanceId: z.string().min(1).optional()
  }).optional(),
  sessionId: z.string().min(1).optional(),
  steps: z.array(ScenarioStepSchema).min(1)
}).superRefine((value, context) => {
  const hasLaunch = value.steps.some((step) => step.kind === 'launch');
  if (hasLaunch && !value.sessionId && !value.selector) {
    context.addIssue({ code: 'custom', message: 'launch 步骤需要 sessionId 或 selector' });
  }
  if (!hasLaunch && !value.sessionId) {
    context.addIssue({ code: 'custom', message: '无 launch 步骤时必须提供 sessionId' });
  }
});

const RuntimeDispatchInputPayloadSchema = z.object({
  sessionId: z.string().min(1),
  inputType: z.enum(['tap', 'click', 'key']),
  x: z.number().optional(),
  y: z.number().optional(),
  key: z.string().min(1).optional()
});

const RuntimeCapturePayloadSchema = z.object({
  sessionId: z.string().min(1),
  resolution: ResolutionSchema.optional(),
  resolutions: z.array(ResolutionSchema).min(1).max(8).optional(),
  crop: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).optional(),
  overlay: z.object({
    nodeBounds: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
    anchors: z.union([z.boolean(), z.array(z.string().min(1))]).optional()
  }).optional()
}).superRefine((value, context) => {
  if (value.resolution && value.resolutions) {
    context.addIssue({ code: 'custom', message: 'resolution 与 resolutions 只能二选一' });
  }
});

const RuntimeHierarchyPayloadSchema = z.object({
  sessionId: z.string().min(1),
  maxDepth: z.number().int().positive().max(20).optional(),
  maxNodes: z.number().int().positive().max(10_000).optional(),
  path: z.string().min(1).optional(),
  includeInactive: z.boolean().optional()
});

const RuntimeComponentPayloadSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  componentType: z.string().min(1)
});

const RuntimeInvokePayloadSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  componentType: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.unknown()).optional()
});

const RuntimeWatchPayloadSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  componentType: z.string().min(1),
  property: z.string().min(1),
  // watch 最长 55s：必须低于 CLI 客户端默认超时（60s），避免结果未知。
  timeoutMs: z.number().int().positive().max(55_000).optional(),
  intervalMs: z.number().int().positive().max(10_000).optional(),
  maxChanges: z.number().int().positive().max(100).optional()
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
  /** 运行态页面驱动（阶段五）；未装配时运行态方法返回 RUNTIME_DRIVER_UNAVAILABLE。 */
  runtimeDriver?: RuntimeDriver;
  /** 截图落盘根目录（默认 `<cwd>/reports/runtime-captures`）。 */
  captureRoot?: string;
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
    if (this.options.runtimeDriver) {
      await this.options.runtimeDriver.dispose().catch(() => undefined);
    }
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
        : RUNTIME_METHODS.has(request.method)
          ? await this.handleRuntimeRequest(request.method, request.payload)
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

  /**
   * 处理运行态控制方法（阶段五）：Preview 会话生命周期与 console 读取。
   *
   * @param method 运行态方法名（server.previewLaunch 等）。
   * @param payload 方法参数。
   * @returns 方法结果。
   */
  private async handleRuntimeRequest(method: string, payload: unknown): Promise<unknown> {
    const driver = this.options.runtimeDriver;
    if (!driver) {
      throw new Error('RUNTIME_DRIVER_UNAVAILABLE');
    }
    switch (method) {
      case 'server.previewLaunch': {
        const parsed = PreviewLaunchPayloadSchema.parse(payload);
        return this.launchPreviewSession(driver, parsed.selector, parsed.params);
      }
      case 'server.previewStop': {
        const parsed = PreviewSessionPayloadSchema.parse(payload);
        return driver.close(parsed.sessionId);
      }
      case 'server.previewSessions': {
        const parsed = PreviewSessionsPayloadSchema.parse(payload);
        return driver.list(parsed.projectId);
      }
      case 'server.previewSession': {
        const parsed = PreviewSessionPayloadSchema.parse(payload);
        return driver.get(parsed.sessionId);
      }
      case 'server.runtimeConsole': {
        const parsed = RuntimeConsolePayloadSchema.parse(payload);
        return driver.readConsole(parsed.sessionId, {
          ...(parsed.sinceSeq !== undefined ? { sinceSeq: parsed.sinceSeq } : {}),
          ...(parsed.level ? { level: parsed.level } : {})
        });
      }
      case 'server.runtimeHierarchy': {
        const parsed = RuntimeHierarchyPayloadSchema.parse(payload);
        const raw = await driver.evaluate(
          parsed.sessionId,
          buildRuntimeScript('readRuntimeHierarchy', {
            ...(parsed.maxDepth !== undefined ? { maxDepth: parsed.maxDepth } : {}),
            ...(parsed.maxNodes !== undefined ? { maxNodes: parsed.maxNodes } : {}),
            ...(parsed.path ? { path: parsed.path } : {}),
            ...(parsed.includeInactive !== undefined ? { includeInactive: parsed.includeInactive } : {})
          })
        );
        if (raw && typeof raw === 'object' && (raw as { found?: unknown }).found === false) {
          throw new Error(`RUNTIME_HIERARCHY_UNAVAILABLE:${JSON.stringify(raw)}`);
        }
        return assembleRuntimeNodeSnapshot(raw, parsed.sessionId);
      }
      case 'server.runtimeComponent': {
        const parsed = RuntimeComponentPayloadSchema.parse(payload);
        const raw = await driver.evaluate(
          parsed.sessionId,
          buildRuntimeScript('readRuntimeComponent', { path: parsed.path, componentType: parsed.componentType })
        ) as Record<string, unknown>;
        if (!raw || raw.found !== true) {
          return raw ?? { found: false, reason: 'empty-response' };
        }
        return {
          ...RuntimeComponentSnapshotSchema.parse({
            source: 'preview-runtime',
            previewSessionId: parsed.sessionId,
            nodeUuid: typeof raw.nodeUuid === 'string' && raw.nodeUuid ? raw.nodeUuid : 'unknown',
            componentType: parsed.componentType,
            properties: raw.properties ?? {},
            capturedAt: new Date().toISOString()
          }),
          ...(Array.isArray(raw.skipped) ? { skipped: raw.skipped } : {})
        };
      }
      case 'server.runtimeInvoke': {
        const parsed = RuntimeInvokePayloadSchema.parse(payload);
        return driver.evaluate(
          parsed.sessionId,
          buildRuntimeScript('invokeRuntimeComponentMethod', {
            path: parsed.path,
            componentType: parsed.componentType,
            method: parsed.method,
            args: parsed.args ?? []
          })
        );
      }
      case 'server.runtimeWatch': {
        const parsed = RuntimeWatchPayloadSchema.parse(payload);
        return watchRuntimeProperty(
          async () => {
            const result = await driver.evaluate(
              parsed.sessionId,
              buildRuntimeScript('readRuntimeProperty', {
                path: parsed.path,
                componentType: parsed.componentType,
                property: parsed.property
              })
            ) as Record<string, unknown>;
            if (!result || result.found !== true) {
              throw new Error(`RUNTIME_PROPERTY_UNAVAILABLE:${JSON.stringify(result)}`);
            }
            return result.value;
          },
          {
            ...(parsed.intervalMs !== undefined ? { intervalMs: parsed.intervalMs } : {}),
            ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
            ...(parsed.maxChanges !== undefined ? { maxChanges: parsed.maxChanges } : {})
          }
        );
      }
      case 'server.runtimeDispatchInput': {
        const parsed = RuntimeDispatchInputPayloadSchema.parse(payload);
        return driver.dispatchInput(parsed.sessionId, {
          inputType: parsed.inputType,
          ...(parsed.x !== undefined ? { x: parsed.x } : {}),
          ...(parsed.y !== undefined ? { y: parsed.y } : {}),
          ...(parsed.key !== undefined ? { key: parsed.key } : {})
        });
      }
      case 'server.runtimeInstantiate': {
        const parsed = RuntimeInstantiatePayloadSchema.parse(payload);
        return driver.evaluate(
          parsed.sessionId,
          buildRuntimeScript('instantiateRuntimePrefab', {
            assetUuid: parsed.assetUuid,
            parentPath: parsed.parentPath,
            ...(parsed.x !== undefined ? { x: parsed.x } : {}),
            ...(parsed.y !== undefined ? { y: parsed.y } : {})
          })
        );
      }
      case 'server.runtimeCapture': {
        const parsed = RuntimeCapturePayloadSchema.parse(payload);
        const overlay = await this.resolveCaptureOverlay(driver, parsed.sessionId, parsed.overlay);
        const resolutions: Array<{ width: number; height: number } | undefined> = parsed.resolutions
          ?? (parsed.resolution ? [parsed.resolution] : [undefined]);
        const files: Array<Record<string, unknown>> = [];
        for (const [index, resolution] of resolutions.entries()) {
          const image = await driver.capture(parsed.sessionId, {
            ...(resolution ? { resolution } : {}),
            ...(parsed.crop ? { crop: parsed.crop } : {}),
            ...(overlay ? { overlay } : {})
          });
          const filePath = await this.saveCaptureImage(parsed.sessionId, image.buffer, index);
          files.push({
            path: filePath,
            width: image.width,
            height: image.height,
            ...(resolution ? { requestedResolution: resolution } : {}),
            actualResolution: image.actualResolution,
            cropped: Boolean(parsed.crop),
            overlays: {
              nodeBounds: Boolean(overlay?.nodeBounds.length),
              anchors: Boolean(overlay?.anchors.length)
            }
          });
        }
        return { files, capturedAt: new Date().toISOString() };
      }
      case 'server.runtimeRunScenario': {
        const parsed = RuntimeRunScenarioPayloadSchema.parse(payload);
        const runtime = this.assembleScenarioRuntime(driver, parsed.selector);
        return runRuntimeScenario(parsed.steps, runtime, {
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          ...(parsed.selector ? { projectId: parsed.selector.projectId } : {})
        });
      }
      default:
        throw new Error('METHOD_NOT_ALLOWED');
    }
  }

  private async forwardClientRequest(method: string, payload: unknown): Promise<unknown> {
    const parsedPayload = ForwardRequestPayloadSchema.parse(payload);
    return this.request(parsedPayload.selector, method, parsedPayload.params);
  }

  /**
   * 装配场景验证运行时：launch 复用 previewLaunch 通道，读取/输入/截图走 driver，
   * 图像差异比较限定基准文件必须位于截图根目录内。
   *
   * @param driver 运行态页面驱动。
   * @param selector launch 步骤新建会话所需的项目选择器。
   * @returns 场景运行时操作集。
   */
  private assembleScenarioRuntime(
    driver: RuntimeDriver,
    selector?: { projectId: string; editorInstanceId?: string }
  ): ScenarioRuntime {
    return {
      launch: async (input) => {
        if (!selector) throw new Error('SCENARIO_SELECTOR_REQUIRED');
        const session = await this.launchPreviewSession(driver, selector, {
          ...(input.resolution ? { resolution: input.resolution } : {})
        });
        return { sessionId: session.sessionId };
      },
      waitNode: async (sessionId, path, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const result = await driver.evaluate(
            sessionId,
            buildRuntimeScript('readRuntimeNodeBounds', { paths: [path] })
          ) as { entries?: Array<{ found?: boolean }> };
          if (result.entries?.[0]?.found) return { found: true };
          if (Date.now() >= deadline) return { found: false };
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      },
      readProperty: async (sessionId, path, componentType, property) => {
        const result = await driver.evaluate(
          sessionId,
          buildRuntimeScript('readRuntimeProperty', { path, componentType, property })
        ) as Record<string, unknown>;
        if (result.found !== true) {
          return { found: false, reason: typeof result.reason === 'string' ? result.reason : 'unknown' };
        }
        return { found: true, value: result.value };
      },
      dispatchInput: (sessionId, input) => driver.dispatchInput(sessionId, input as never),
      readConsole: (sessionId, sinceSeq) => Promise.resolve(driver.readConsole(sessionId, { sinceSeq })),
      capture: async (sessionId, options) => {
        const overlay = options.overlay
          ? await this.resolveCaptureOverlay(driver, sessionId, options.overlay)
          : undefined;
        const image = await driver.capture(sessionId, {
          ...(options.resolution ? { resolution: options.resolution } : {}),
          ...(options.crop ? { crop: options.crop } : {}),
          ...(overlay ? { overlay } : {})
        });
        const filePath = await this.saveCaptureImage(sessionId, image.buffer, this.nextCaptureIndex());
        return { path: filePath };
      },
      imageDiff: async (sessionId, baselinePath) => {
        const root = resolve(this.options.captureRoot ?? join(process.cwd(), 'reports', 'runtime-captures'));
        const resolvedBaseline = resolve(root, baselinePath);
        if (!resolvedBaseline.startsWith(root + sep)) {
          throw new Error('BASELINE_PATH_OUT_OF_ROOT');
        }
        const baselineBuffer = await readFile(resolvedBaseline);
        const current = await driver.capture(sessionId, {});
        const diff = diffPng(baselineBuffer, current.buffer);
        const diffPngPath = await this.saveCaptureImage(sessionId, diff.diffPng, this.nextCaptureIndex());
        return { diffRatio: diff.diffRatio, diffPngPath };
      }
    };
  }

  /** 截图文件名序号（防同毫秒撞名）。 */
  private captureIndex = 0;

  private nextCaptureIndex(): number {
    this.captureIndex += 1;
    return this.captureIndex;
  }

  /**
   * 启动 Preview 会话（previewLaunch 与 scenario launch 步骤共用）：
   * 先经 Bridge 确保 preview server 已启动并取回页面 URL，再自 launch 浏览器。
   *
   * @param driver 运行态页面驱动。
   * @param selector 目标项目与可选 Editor 实例。
   * @param params 可选分辨率与浏览器通道。
   * @returns 就绪态会话。
   */
  private async launchPreviewSession(
    driver: RuntimeDriver,
    selector: { projectId: string; editorInstanceId?: string },
    params?: { resolution?: { width: number; height: number }; channel?: string }
  ) {
    const opened = await this.request(selector, 'probe.previewOpen', {}) as { url?: unknown };
    if (!opened || typeof opened.url !== 'string' || !opened.url) {
      throw new Error('PREVIEW_URL_UNAVAILABLE');
    }
    return driver.launch({
      projectId: selector.projectId,
      ...(selector.editorInstanceId ? { editorInstanceId: selector.editorInstanceId } : {}),
      url: opened.url,
      ...(params?.resolution ? { resolution: params.resolution } : {}),
      ...(params?.channel ? { channel: params.channel } : {})
    });
  }

  /**
   * 解析截图叠加开关：布尔 true 表示全量节点（经运行时层级提取，限 50 个防爆）；
   * 字符串数组为指定节点路径；未开启时返回 undefined。
   *
   * @param driver 运行态页面驱动。
   * @param sessionId 目标会话。
   * @param overlay 协议叠加开关。
   * @returns 节点边界与锚点的路径列表。
   */
  private async resolveCaptureOverlay(
    driver: RuntimeDriver,
    sessionId: string,
    overlay: { nodeBounds?: boolean | string[]; anchors?: boolean | string[] } | undefined
  ): Promise<{ nodeBounds: string[]; anchors: string[] } | undefined> {
    if (!overlay || (overlay.nodeBounds === undefined && overlay.anchors === undefined)) {
      return undefined;
    }
    const resolvePaths = async (value: boolean | string[] | undefined): Promise<string[]> => {
      if (value === undefined || value === false) return [];
      if (Array.isArray(value)) return value;
      const hierarchy = await driver.evaluate(sessionId, buildRuntimeScript('readRuntimeHierarchy', { maxDepth: 8 })) as Record<string, unknown>;
      const paths: string[] = [];
      const walk = (node: Record<string, unknown>, prefix: string): void => {
        if (paths.length >= 50) return;
        const name = typeof node.name === 'string' ? node.name : '';
        const path = prefix ? `${prefix}/${name}` : name;
        paths.push(path);
        for (const child of (Array.isArray(node.children) ? node.children : []) as Array<Record<string, unknown>>) {
          walk(child, path);
        }
      };
      walk(hierarchy, '');
      return paths;
    };
    return {
      nodeBounds: await resolvePaths(overlay.nodeBounds),
      anchors: await resolvePaths(overlay.anchors)
    };
  }

  /**
   * 截图落盘：固定根目录 + 会话子目录 + 服务端生成文件名（不接受外部路径）。
   *
   * @param sessionId 来源会话（消毒后作目录名）。
   * @param buffer PNG 图像字节。
   * @param index 本次请求内的序号。
   * @returns 落盘后的绝对路径。
   */
  private async saveCaptureImage(sessionId: string, buffer: Buffer, index: number): Promise<string> {
    const root = this.options.captureRoot ?? join(process.cwd(), 'reports', 'runtime-captures');
    const safeSession = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    const directory = join(root, safeSession);
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
    const filePath = join(directory, `${timestamp}-${index}.png`);
    await writeFile(filePath, buffer);
    return filePath;
  }

  private parseMessage(raw: RawData): unknown | null {
    try {
      return JSON.parse(raw.toString()) as unknown;
    } catch {
      return null;
    }
  }
}
