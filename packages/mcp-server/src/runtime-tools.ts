import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appendWriteJournalEntry } from '@cocos-ai/core';
import { PreviewSessionSchema, RuntimeNodeSnapshotSchema, ScenarioStepSchema } from '@cocos-ai/protocol';
import { z as zod } from 'zod';
import type { CocosReadonlyToolService, CocosReadonlyToolServiceOptions } from './tools.js';

/**
 * 阶段五运行态与视觉验证 MCP 工具。
 * 只读组默认开放；launch/stop/invoke/dispatch/scenario 属动作类，仅在显式
 * --enable-writes 时注册。运行态数据不应用回编辑态，视觉结果仅作辅助证据。
 */

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true
} as const;

const SessionIdInput = {
  sessionId: zod.string().min(1)
};

const NodePathComponentInput = {
  ...SessionIdInput,
  path: zod.string().min(1),
  componentType: zod.string().min(1)
};

const ResolutionInput = zod.object({
  width: zod.number().int().positive(),
  height: zod.number().int().positive()
});

const CropInput = zod.object({
  x: zod.number().int().nonnegative(),
  y: zod.number().int().nonnegative(),
  width: zod.number().int().positive(),
  height: zod.number().int().positive()
});

const OverlayValueInput = zod.union([zod.boolean(), zod.array(zod.string().min(1))]);

const SessionsOutputSchema = zod.object({
  sessions: zod.array(PreviewSessionSchema)
});

const ConsoleOutputSchema = zod.object({
  entries: zod.array(zod.record(zod.string(), zod.unknown())),
  nextSeq: zod.number().int().nonnegative()
});

const WatchOutputSchema = zod.object({
  timedOut: zod.boolean(),
  initialValue: zod.unknown().optional(),
  changes: zod.array(zod.record(zod.string(), zod.unknown()))
});

const CaptureOutputSchema = zod.object({
  files: zod.array(zod.record(zod.string(), zod.unknown())),
  capturedAt: zod.string()
});

/** 运行态读取结果的宽松对象形态（found 命中/未命中两态）。 */
const RuntimeRecordOutputSchema = zod.looseObject({});

/** 校验目标 Bridge 具备 preview 能力。 */
function assertPreviewCapability(editor: { capabilities: string[] }): void {
  if (!editor.capabilities.includes('probe.previewOpen')) {
    throw new Error('BRIDGE_CAPABILITY_MISSING:probe.previewOpen');
  }
}

/**
 * 运行态工具服务：经共享 Probe Client 调用 Probe Server 的运行态方法。
 */
export class CocosRuntimeToolService {
  constructor(
    private readonly options: CocosReadonlyToolServiceOptions,
    private readonly editors: CocosReadonlyToolService
  ) {}

  /** 列出 Preview 会话（可按项目过滤）。 */
  async listPreviewSessions(input: { projectId?: string }) {
    const sessions = await this.options.probeClient.request('server.previewSessions', {
      ...(input.projectId ? { projectId: input.projectId } : {})
    });
    const output = SessionsOutputSchema.parse({ sessions });
    await this.audit('cocos_preview_sessions', input, output);
    return output;
  }

  /** 启动 Preview 会话（校验编辑器在线与 Bridge preview 能力）。 */
  async launchPreview(input: {
    projectId: string;
    editorInstanceId?: string;
    resolution?: { width: number; height: number };
    channel?: string;
  }) {
    const editor = await this.editors.resolveEditor(input);
    assertPreviewCapability(editor);
    const session = await this.options.probeClient.request('server.previewLaunch', {
      selector: { projectId: editor.projectId, editorInstanceId: editor.editorInstanceId },
      params: {
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.channel ? { channel: input.channel } : {})
      }
    });
    const output = PreviewSessionSchema.parse(session);
    await this.audit('cocos_preview_launch', input, output);
    return output;
  }

  /** 停止 Preview 会话。 */
  async stopPreview(input: { sessionId: string }) {
    const result = await this.options.probeClient.request('server.previewStop', { sessionId: input.sessionId });
    const output = zod.object({ closed: zod.literal(true) }).parse(result);
    await this.audit('cocos_preview_stop', input, output);
    return output;
  }

  /**
   * 读取运行时整树或指定子树快照。
   *
   * @param input Preview 会话、深度/节点上限、可选节点路径和未激活节点过滤选项。
   * @returns Probe Server 返回的协议化运行时节点快照。
   */
  async getRuntimeHierarchy(input: {
    sessionId: string;
    maxDepth?: number;
    maxNodes?: number;
    path?: string;
    includeInactive?: boolean;
  }) {
    const result = await this.options.probeClient.request('server.runtimeHierarchy', {
      sessionId: input.sessionId,
      ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
      ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
      ...(input.path ? { path: input.path } : {}),
      ...(input.includeInactive !== undefined ? { includeInactive: input.includeInactive } : {})
    });
    const output = zod.record(zod.string(), zod.unknown()).parse(result);
    await this.audit('cocos_runtime_get_hierarchy', input, output);
    return output;
  }

  /** 读取运行时组件属性包。 */
  async inspectRuntimeComponent(input: { sessionId: string; path: string; componentType: string }) {
    const result = await this.options.probeClient.request('server.runtimeComponent', {
      sessionId: input.sessionId,
      path: input.path,
      componentType: input.componentType
    });
    const output = zod.record(zod.string(), zod.unknown()).parse(result);
    await this.audit('cocos_runtime_inspect_component', input, output);
    return output;
  }

  /** 读取运行时 Console（游标增量 + 级别过滤）。 */
  async getRuntimeConsole(input: { sessionId: string; sinceSeq?: number; level?: string }) {
    const result = await this.options.probeClient.request('server.runtimeConsole', {
      sessionId: input.sessionId,
      ...(input.sinceSeq !== undefined ? { sinceSeq: input.sinceSeq } : {}),
      ...(input.level ? { level: input.level } : {})
    });
    const output = zod.object({
      entries: zod.array(zod.record(zod.string(), zod.unknown())),
      nextSeq: zod.number().int().nonnegative()
    }).parse(result);
    await this.audit('cocos_runtime_get_console', input, output);
    return output;
  }

  /** 监听运行时属性变化（server 侧有界轮询，变化即返回）。 */
  async watchRuntimeProperty(input: {
    sessionId: string;
    path: string;
    componentType: string;
    property: string;
    timeoutMs?: number;
    intervalMs?: number;
    maxChanges?: number;
  }) {
    const result = await this.options.probeClient.request('server.runtimeWatch', {
      sessionId: input.sessionId,
      path: input.path,
      componentType: input.componentType,
      property: input.property,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
      ...(input.maxChanges !== undefined ? { maxChanges: input.maxChanges } : {})
    });
    const output = zod.object({
      timedOut: zod.boolean(),
      initialValue: zod.unknown().optional(),
      changes: zod.array(zod.record(zod.string(), zod.unknown()))
    }).parse(result);
    await this.audit('cocos_runtime_watch_property', input, output);
    return output;
  }

  /** 调用运行时组件方法（门控）。 */
  async invokeRuntimeMethod(input: {
    sessionId: string;
    path: string;
    componentType: string;
    method: string;
    args?: unknown[];
  }) {
    const result = await this.options.probeClient.request('server.runtimeInvoke', {
      sessionId: input.sessionId,
      path: input.path,
      componentType: input.componentType,
      method: input.method,
      ...(input.args ? { args: input.args } : {})
    });
    const output = zod.record(zod.string(), zod.unknown()).parse(result);
    await this.audit('cocos_runtime_invoke_method', input, output);
    return output;
  }

  /** 派发运行时输入（门控；坐标为画布 CSS 像素）。 */
  async dispatchRuntimeInput(input: {
    sessionId: string;
    inputType: 'tap' | 'click' | 'key';
    x?: number;
    y?: number;
    key?: string;
  }) {
    const result = await this.options.probeClient.request('server.runtimeDispatchInput', {
      sessionId: input.sessionId,
      inputType: input.inputType,
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {}),
      ...(input.key !== undefined ? { key: input.key } : {})
    });
    const output = zod.record(zod.string(), zod.unknown()).parse(result);
    await this.audit('cocos_runtime_dispatch_input', input, output);
    return output;
  }

  /** 在 Preview 运行时实例化 Prefab（仅改变运行时场景，不写工程文件）。 */
  async instantiateRuntimePrefab(input: {
    sessionId: string;
    assetUuid: string;
    parentPath: string;
    x?: number;
    y?: number;
  }) {
    const result = await this.options.probeClient.request('server.runtimeInstantiate', {
      sessionId: input.sessionId,
      assetUuid: input.assetUuid,
      parentPath: input.parentPath,
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {})
    });
    const output = zod.object({
      done: zod.boolean(),
      nodePath: zod.string().optional(),
      parentName: zod.string().optional(),
      reason: zod.string().optional(),
      error: zod.string().optional()
    }).parse(result);
    await this.audit('cocos_runtime_instantiate_prefab', input, output);
    return output;
  }

  /** 截图与视觉验证（单张/多分辨率/裁剪/边界锚点叠加，产物落盘返回路径）。 */
  async captureRuntime(input: {
    sessionId: string;
    resolution?: { width: number; height: number };
    resolutions?: Array<{ width: number; height: number }>;
    crop?: { x: number; y: number; width: number; height: number };
    overlayNodeBounds?: boolean | string[];
    overlayAnchors?: boolean | string[];
  }) {
    const result = await this.options.probeClient.request('server.runtimeCapture', {
      sessionId: input.sessionId,
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.resolutions ? { resolutions: input.resolutions } : {}),
      ...(input.crop ? { crop: input.crop } : {}),
      ...(input.overlayNodeBounds !== undefined || input.overlayAnchors !== undefined
        ? {
            overlay: {
              ...(input.overlayNodeBounds !== undefined ? { nodeBounds: input.overlayNodeBounds } : {}),
              ...(input.overlayAnchors !== undefined ? { anchors: input.overlayAnchors } : {})
            }
          }
        : {})
    });
    const output = zod.object({
      files: zod.array(zod.record(zod.string(), zod.unknown())),
      capturedAt: zod.string()
    }).parse(result);
    await this.audit('cocos_runtime_capture', input, output);
    return output;
  }

  /** 执行自动场景验证（门控）。 */
  async runRuntimeScenario(input: {
    sessionId?: string;
    projectId?: string;
    editorInstanceId?: string;
    steps: unknown[];
  }) {
    const steps = zod.array(ScenarioStepSchema).min(1).parse(input.steps);
    const result = await this.options.probeClient.request('server.runtimeRunScenario', {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.projectId
        ? {
            selector: {
              projectId: input.projectId,
              ...(input.editorInstanceId ? { editorInstanceId: input.editorInstanceId } : {})
            }
          }
        : {}),
      steps
    });
    const output = zod.record(zod.string(), zod.unknown()).parse(result);
    await this.audit('cocos_runtime_run_scenario', input, output);
    return output;
  }

  /** 审计落盘（与 design 工具同形态）。 */
  private async audit(event: string, request: unknown, result: unknown): Promise<void> {
    await mkdir(this.options.reportRoot, { recursive: true });
    await appendWriteJournalEntry(this.options.reportRoot, {
      transactionId: `mcp-runtime-${randomUUID()}`,
      idempotencyKey: '',
      at: new Date().toISOString(),
      event,
      source: 'mcp',
      request,
      details: { status: 'ok' }
    });
  }
}

/** 登记默认开放的运行态只读工具。 */
export function registerCocosRuntimeReadonlyTools(
  server: McpServer,
  service: CocosRuntimeToolService
): void {
  server.registerTool('cocos_preview_sessions', {
    description: '列出当前 Probe Server 管理的 Preview 页面会话（状态、URL、实际生效分辨率）。',
    inputSchema: {
      projectId: zod.string().min(1).optional()
    },
    outputSchema: SessionsOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.listPreviewSessions(input)));

  server.registerTool('cocos_runtime_get_hierarchy', {
    description: '读取 Preview 运行时整树或指定 path 子树；可排除 inactive 子树，动态节点带 dynamic 标注。',
    inputSchema: {
      ...SessionIdInput,
      maxDepth: zod.number().int().positive().max(20).optional(),
      maxNodes: zod.number().int().positive().max(10_000).optional(),
      path: zod.string().min(1).optional(),
      includeInactive: zod.boolean().optional()
    },
    outputSchema: RuntimeNodeSnapshotSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.getRuntimeHierarchy(input)));

  server.registerTool('cocos_runtime_inspect_component', {
    description: '按节点路径与组件类型读取运行时组件属性包（cc. 前缀自动兼容；未命中返回候选清单）。',
    inputSchema: {
      ...NodePathComponentInput
    },
    outputSchema: RuntimeRecordOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.inspectRuntimeComponent(input)));

  server.registerTool('cocos_runtime_get_console', {
    description: '读取 Preview 运行时 Console（seq 游标增量拉取、级别过滤、error 带堆栈）。',
    inputSchema: {
      ...SessionIdInput,
      sinceSeq: zod.number().int().nonnegative().optional(),
      level: zod.enum(['log', 'info', 'warn', 'error', 'debug']).optional()
    },
    outputSchema: ConsoleOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.getRuntimeConsole(input)));

  server.registerTool('cocos_runtime_watch_property', {
    description: '监听运行时组件属性变化（server 侧轮询，变化即返回；支持点路径嵌套属性）。',
    inputSchema: {
      ...NodePathComponentInput,
      property: zod.string().min(1),
      timeoutMs: zod.number().int().positive().max(55_000).optional(),
      intervalMs: zod.number().int().positive().max(10_000).optional(),
      maxChanges: zod.number().int().positive().max(100).optional()
    },
    outputSchema: WatchOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.watchRuntimeProperty(input)));

  server.registerTool('cocos_runtime_capture', {
    description: 'Game 视图截图：指定/多分辨率、目标区域裁剪、节点边界与锚点叠加；产物落盘返回路径（视觉结果仅作辅助证据）。',
    inputSchema: {
      ...SessionIdInput,
      resolution: ResolutionInput.optional(),
      resolutions: zod.array(ResolutionInput).min(1).max(8).optional(),
      crop: CropInput.optional(),
      overlayNodeBounds: OverlayValueInput.optional(),
      overlayAnchors: OverlayValueInput.optional()
    },
    outputSchema: CaptureOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.captureRuntime(input)));
}

/** 登记仅在显式 enableWrites 时开放的运行态动作工具。 */
export function registerCocosRuntimeGatedTools(
  server: McpServer,
  service: CocosRuntimeToolService
): void {
  server.registerTool('cocos_preview_launch', {
    description: '启动 Preview 并打开工具自管的浏览器页面（返回就绪会话与实际生效分辨率）。',
    inputSchema: {
      projectId: zod.string().min(1),
      editorInstanceId: zod.string().min(1).optional(),
      resolution: ResolutionInput.optional(),
      channel: zod.enum(['chrome', 'msedge']).optional()
    },
    outputSchema: PreviewSessionSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.launchPreview(input)));

  server.registerTool('cocos_preview_stop', {
    description: '停止指定 Preview 页面会话（仅工具自 launch 的页面）。',
    inputSchema: {
      ...SessionIdInput
    },
    outputSchema: RuntimeRecordOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.stopPreview(input)));

  server.registerTool('cocos_runtime_invoke_method', {
    description: '调用运行时组件方法（白名单参数、生命周期与危险方法黑名单、返回值序列化回传）。',
    inputSchema: {
      ...NodePathComponentInput,
      method: zod.string().min(1),
      args: zod.array(zod.unknown()).optional()
    },
    outputSchema: RuntimeRecordOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.invokeRuntimeMethod(input)));

  server.registerTool('cocos_runtime_dispatch_input', {
    description: '向 Preview 页面派发输入（tap/click 为画布 CSS 像素坐标，key 为按键；回执不保证游戏响应，须后续断言验证）。',
    inputSchema: {
      ...SessionIdInput,
      inputType: zod.enum(['tap', 'click', 'key']),
      x: zod.number().nonnegative().optional(),
      y: zod.number().nonnegative().optional(),
      key: zod.string().min(1).optional()
    },
    outputSchema: RuntimeRecordOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.dispatchRuntimeInput(input)));

  server.registerTool('cocos_runtime_instantiate_prefab', {
    description: '在 Preview 运行时加载并实例化 Prefab，挂到指定节点；只影响运行时，不写工程文件。',
    inputSchema: {
      ...SessionIdInput,
      assetUuid: zod.string().trim().min(1),
      parentPath: zod.string().trim().min(1),
      x: zod.number().optional(),
      y: zod.number().optional()
    },
    outputSchema: RuntimeRecordOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.instantiateRuntimePrefab(input)));

  server.registerTool('cocos_runtime_run_scenario', {
    description: '执行自动场景验证：launch/wait-node/assert-property/dispatch-input/assert-console/capture/assert-image-diff 步骤编排，产出逐项证据报告。',
    inputSchema: {
      sessionId: zod.string().min(1).optional(),
      projectId: zod.string().min(1).optional(),
      editorInstanceId: zod.string().min(1).optional(),
      steps: zod.array(ScenarioStepSchema).min(1)
    },
    outputSchema: RuntimeRecordOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.runRuntimeScenario(input)));
}

function toToolResult(value: unknown) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}
