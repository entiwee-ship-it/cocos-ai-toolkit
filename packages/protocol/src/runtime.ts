import { z } from 'zod';

/**
 * 运行态与视觉验证协议。
 * 运行态数据一律携带 `source: 'preview-runtime'` 标记，与编辑态序列化数据严格区分；
 * 运行时结果不应用回编辑态。视觉结果仅作辅助证据，结构化数据是真值基础。
 */

/** 分辨率（像素，正整数）。 */
export const ResolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

/** Preview 页面会话：仅支持工具自 launch 的页面（pageSource 固定）。 */
export const PreviewSessionSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional(),
  /** 实际打开的 URL（自 launch 一律规范化为 127.0.0.1）。 */
  url: z.string().url(),
  pageSource: z.literal('self-launched'),
  state: z.enum(['launching', 'ready', 'closed', 'lost']),
  /** 请求分辨率（可选）。 */
  requestedResolution: ResolutionSchema.optional(),
  /** 实际生效分辨率：受页面容器约束可能与请求值不同，必须回传。 */
  actualResolution: ResolutionSchema.optional(),
  launchedAt: z.string().min(1)
});

/** 运行时组件摘要。 */
export const RuntimeComponentSummarySchema = z.object({
  type: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional()
});

export interface RuntimeNodeInput {
  uuid: string;
  name: string;
  active: boolean;
  /** 动态创建节点（非场景序列化来源），与编辑态节点严格区分。 */
  dynamic: boolean;
  components: Array<z.infer<typeof RuntimeComponentSummarySchema>>;
  children?: RuntimeNodeInput[];
  truncated?: boolean;
}

/** 运行时节点（递归）。 */
export const RuntimeNodeSchema: z.ZodType<RuntimeNodeInput> = z.lazy(() =>
  z.object({
    uuid: z.string(),
    name: z.string(),
    active: z.boolean(),
    dynamic: z.boolean(),
    components: z.array(RuntimeComponentSummarySchema),
    children: z.array(RuntimeNodeSchema).optional(),
    /** 子树被深度或节点数上限截断（读取不完整，AI 必须知晓）。 */
    truncated: z.boolean().optional()
  })
);

/** 运行时节点快照：整树或子树。 */
export const RuntimeNodeSnapshotSchema = z.object({
  source: z.literal('preview-runtime'),
  previewSessionId: z.string().min(1),
  capturedAt: z.string().min(1),
  root: RuntimeNodeSchema,
  /** 实际序列化的节点总数。 */
  nodeCount: z.number().int().positive().optional(),
  /** 整树被截断标记。 */
  truncated: z.boolean().optional()
});

/** 运行时组件快照：单组件属性包。 */
export const RuntimeComponentSnapshotSchema = z.object({
  source: z.literal('preview-runtime'),
  previewSessionId: z.string().min(1),
  nodeUuid: z.string().min(1),
  componentType: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  capturedAt: z.string().min(1)
});

/** 时间窗口采样模式：逐帧，或按固定毫秒间隔。 */
export const RuntimeSampleWindowModeSchema = z.union([
  z.literal('perFrame'),
  z.object({
    intervalMs: z.number().int().positive().max(10_000)
  })
]);

/** 采样前可选触发的组件方法。 */
export const RuntimeSampleWindowTriggerSchema = z.object({
  method: z.string().min(1),
  args: z.array(z.unknown()).optional()
});

/** 页面内时间窗口采样入参。 */
export const RuntimeSampleWindowInputSchema = z.object({
  path: z.string().min(1),
  componentType: z.string().min(1),
  properties: z.array(z.string().min(1)).min(1).max(20),
  mode: RuntimeSampleWindowModeSchema,
  /** 必须低于 60 秒客户端超时，避免结果状态未知。 */
  durationMs: z.number().int().positive().max(55_000),
  trigger: RuntimeSampleWindowTriggerSchema.optional()
});

/** 单帧运行时属性样本；节点销毁后 values 为空并保留 nodeValid=false。 */
export const RuntimeSampleFrameSchema = z.object({
  frame: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  values: z.record(z.string(), z.unknown()),
  nodeValid: z.boolean()
});

/** 采样前方法触发结果。 */
export const RuntimeSampleWindowTriggerResultSchema = z.object({
  invoked: z.boolean(),
  method: z.string().min(1),
  /** 异步方法在采样窗口结束时是否仍未完成。 */
  pending: z.boolean().optional(),
  returnValue: z.unknown().optional(),
  reason: z.string().optional(),
  error: z.string().optional()
});

/** 页面内时间窗口采样快照。 */
export const RuntimeSampleWindowSnapshotSchema = z.object({
  source: z.literal('preview-runtime'),
  previewSessionId: z.string().min(1),
  capturedAt: z.string().min(1),
  path: z.string().min(1),
  nodeUuid: z.string().min(1),
  componentType: z.string().min(1),
  mode: RuntimeSampleWindowModeSchema,
  durationMs: z.number().int().positive().max(55_000),
  samples: z.array(RuntimeSampleFrameSchema),
  trigger: RuntimeSampleWindowTriggerResultSchema.optional(),
  /** 高刷新率下超过本地 3600 条样本上限时为 true。 */
  truncated: z.boolean().optional(),
  /** requestAnimationFrame 未在窗口内回调时由 wall-clock watchdog 返回部分证据。 */
  timedOut: z.boolean().optional()
});

/** Console 条目：seq 为单调游标，供增量拉取。 */
export const ConsoleEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
  text: z.string(),
  stack: z.string().optional(),
  timestamp: z.string().min(1)
});

/** 目标区域裁剪（页面 CSS 像素坐标系）。 */
export const CaptureCropSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

/** 叠加绘制开关：true 为全量节点（限 50 个防爆），字符串数组为指定节点路径。 */
export const CaptureOverlaySchema = z.object({
  nodeBounds: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
  anchors: z.union([z.boolean(), z.array(z.string().min(1))]).optional()
});

/** 截图选项：当前仅 Game 视图（Scene 视图为已知限制）。 */
export const RuntimeCaptureOptionsSchema = z.object({
  view: z.literal('game'),
  /** 单张截图的请求分辨率。 */
  resolution: ResolutionSchema.optional(),
  /** 多分辨率逐一出图。 */
  resolutions: z.array(ResolutionSchema).min(1).optional(),
  crop: CaptureCropSchema.optional(),
  overlay: CaptureOverlaySchema.optional(),
  format: z.enum(['png', 'jpeg']).default('png')
}).superRefine((options, context) => {
  if (options.resolution && options.resolutions) {
    context.addIssue({ code: 'custom', message: 'resolution 与 resolutions 只能二选一' });
  }
});

/** 单张截图产物。 */
export const CaptureFileSchema = z.object({
  /** 落盘文件路径。 */
  path: z.string().min(1),
  /** 实际像素尺寸。 */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  requestedResolution: ResolutionSchema.optional(),
  actualResolution: ResolutionSchema.optional(),
  cropped: z.boolean(),
  overlays: z.object({
    nodeBounds: z.boolean(),
    anchors: z.boolean()
  })
});

/** 截图结果。 */
export const RuntimeCaptureResultSchema = z.object({
  files: z.array(CaptureFileSchema).min(1),
  capturedAt: z.string().min(1)
});

/** 步骤失败策略：abort 中止场景（默认），continue 继续后续步骤。 */
export const ScenarioOnFailSchema = z.enum(['abort', 'continue']);

/** 自动场景验证步骤。 */
export const ScenarioStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('launch'),
    resolution: ResolutionSchema.optional(),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('wait-node'),
    path: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('assert-property'),
    path: z.string().min(1),
    property: z.string().min(1),
    expected: z.unknown().optional(),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('dispatch-input'),
    inputType: z.enum(['tap', 'click', 'key']),
    x: z.number().optional(),
    y: z.number().optional(),
    key: z.string().optional(),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('instantiate-prefab'),
    assetUuid: z.string().min(1),
    parentPath: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('assert-console'),
    /** 匹配文本（正则）。 */
    pattern: z.string().min(1),
    level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional(),
    timeoutMs: z.number().int().positive().optional(),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('capture'),
    resolution: ResolutionSchema.optional(),
    crop: CaptureCropSchema.optional(),
    overlay: CaptureOverlaySchema.optional(),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('assert-image-diff'),
    baselinePath: z.string().min(1),
    /** 允许的差异像素比例阈值，0..1。 */
    threshold: z.number().min(0).max(1),
    onFail: ScenarioOnFailSchema.optional()
  }),
  z.object({
    kind: z.literal('stop'),
    /** 前序步骤默认中止后仍执行，用于 finally 式 Preview 清理。 */
    always: z.boolean().optional(),
    onFail: ScenarioOnFailSchema.optional()
  })
]);

/** 场景报告步骤结果：expected/actual 显式可选（Zod 4 语义）。 */
export const ScenarioStepResultSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.string().min(1),
  passed: z.boolean(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  error: z.string().optional(),
  /** 证据文件路径（截图等）。 */
  evidence: z.string().optional()
});

/** 自动场景验证报告。 */
export const ScenarioReportSchema = z.object({
  steps: z.array(ScenarioStepResultSchema),
  passed: z.boolean(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1)
});

export type Resolution = z.infer<typeof ResolutionSchema>;
export type PreviewSession = z.infer<typeof PreviewSessionSchema>;
export type RuntimeNodeSnapshot = z.infer<typeof RuntimeNodeSnapshotSchema>;
export type RuntimeComponentSnapshot = z.infer<typeof RuntimeComponentSnapshotSchema>;
export type RuntimeSampleWindowMode = z.infer<typeof RuntimeSampleWindowModeSchema>;
export type RuntimeSampleWindowInput = z.infer<typeof RuntimeSampleWindowInputSchema>;
export type RuntimeSampleFrame = z.infer<typeof RuntimeSampleFrameSchema>;
export type RuntimeSampleWindowSnapshot = z.infer<typeof RuntimeSampleWindowSnapshotSchema>;
export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;
export type RuntimeCaptureOptions = z.infer<typeof RuntimeCaptureOptionsSchema>;
export type RuntimeCaptureResult = z.infer<typeof RuntimeCaptureResultSchema>;
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;
export type ScenarioStepResult = z.infer<typeof ScenarioStepResultSchema>;
export type ScenarioReport = z.infer<typeof ScenarioReportSchema>;
