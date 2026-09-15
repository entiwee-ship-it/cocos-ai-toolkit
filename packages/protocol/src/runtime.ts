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

/** 运行会话平台；Android 是 Native Workbench 的默认验收平台。 */
export const RuntimePlatformSchema = z.enum([
  'browser',
  'android-emulator',
  'creator-simulator'
]);

/** Preview/Native 会话：结构化数据始终来自同一个真实运行进程。 */
export const PreviewSessionSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional(),
  /** 浏览器为真实 URL，Native 为可追踪的 synthetic URL。 */
  url: z.string().url(),
  pageSource: z.enum(['self-launched', 'native-runtime']),
  platform: RuntimePlatformSchema.default('browser'),
  state: z.enum(['launching', 'ready', 'closed', 'lost']),
  deviceId: z.string().min(1).optional(),
  appPid: z.number().int().positive().optional(),
  /** 同一 Creator Simulator 进程内运行代理的实例身份。 */
  runtimeInstanceId: z.string().min(1).optional(),
  inspectorDevicePort: z.number().int().positive().optional(),
  inspectorLocalPort: z.number().int().positive().optional(),
  runtimeTransport: z.string().min(1).optional(),
  /** 场景 epoch 与节点 revision 由真实运行进程计算。 */
  sceneUuid: z.string().min(1).optional(),
  sceneEpoch: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional(),
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

/** 来源以当前引擎实例信息为准；运行时创建者未记录时不猜测系统或业务脚本。 */
export const RuntimeNodeOriginSchema = z.object({
  kind: z.enum(['prefab', 'scene', 'runtime']),
  assetUuid: z.string().min(1).optional(),
  fileId: z.string().optional(),
  rootUuid: z.string().optional(),
  rootPath: z.string().optional(),
  instanceRoot: z.boolean().optional(),
  sourceUrl: z.string().nullable().optional(),
  sourceName: z.string().nullable().optional(),
  available: z.boolean().optional()
});

const RuntimePointSchema = z.object({ x: z.number(), y: z.number() });
const RuntimeRectSchema = RuntimePointSchema.extend({ width: z.number().nonnegative(), height: z.number().nonnegative() });

/** 画布 CSS 像素范围，原点在左上角；四角保留旋转后的真实形状。 */
export const RuntimeNodeBoundsSchema = z.object({
  path: z.string(), found: z.boolean(), hasBounds: z.boolean().optional(), reason: z.string().optional(),
  points: z.array(RuntimePointSchema).length(4).optional(), rect: RuntimeRectSchema.optional(), anchor: RuntimePointSchema.optional(),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  camera: z.object({ name: z.string(), priority: z.number() }).optional()
});

/** 工作台和 AI 共用的单节点实时详情。 */
export const RuntimeNodeDetailsSchema = z.object({
  source: z.literal('preview-runtime'), previewSessionId: z.string().min(1), capturedAt: z.string().min(1),
  found: z.literal(true), nodeUuid: z.string().min(1), name: z.string(), path: z.string().min(1), parentUuid: z.string().nullable(),
  active: z.boolean(), activeInHierarchy: z.boolean(), dynamic: z.boolean(),
  layer: z.number().int().nonnegative(), layerName: z.string(), depth: z.number().int().nonnegative(), siblingIndex: z.number().int().nonnegative(),
  components: z.array(RuntimeComponentSummarySchema), origin: RuntimeNodeOriginSchema, bounds: RuntimeNodeBoundsSchema,
  sceneUuid: z.string(), sceneEpoch: z.number().int().nonnegative(), revision: z.number().int().nonnegative()
});

export interface RuntimeNodeInput {
  uuid: string;
  name: string;
  /** 同名节点带稳定索引的运行时路径，例如 /Canvas~0/Button~1。 */
  path?: string;
  parentUuid?: string;
  active: boolean;
  activeInHierarchy?: boolean;
  /** 动态创建节点（非场景序列化来源），与编辑态节点严格区分。 */
  dynamic: boolean;
  origin?: z.infer<typeof RuntimeNodeOriginSchema>;
  components: Array<z.infer<typeof RuntimeComponentSummarySchema>>;
  children?: RuntimeNodeInput[];
  truncated?: boolean;
}

/** 运行时节点（递归）。 */
export const RuntimeNodeSchema: z.ZodType<RuntimeNodeInput> = z.lazy(() =>
      z.object({
        uuid: z.string(),
        name: z.string(),
        path: z.string().min(1).optional(),
        parentUuid: z.string().min(1).optional(),
        active: z.boolean(),
        activeInHierarchy: z.boolean().optional(),
    dynamic: z.boolean(),
    origin: RuntimeNodeOriginSchema.optional(),
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
  sceneUuid: z.string().min(1).optional(),
  sceneEpoch: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional(),
  /** 实际序列化的节点总数。 */
  nodeCount: z.number().int().positive().optional(),
  /** 整树被截断标记。 */
  truncated: z.boolean().optional()
});

/** 运行时组件快照：单组件属性包。 */
export const RuntimePropertyMetadataSchema = z.object({
  /** 运行时值的稳定类别，例如 number、enum、vector、reference。 */
  kind: z.string().min(1),
  /** 当前运行进程是否允许通过公开属性写入。 */
  editable: z.boolean(),
  /** Cocos Inspector 的动态可见性结果。 */
  visible: z.boolean().optional(),
  /** 属性是否来自 Cocos 类的 __props__/__attrs__ 声明。 */
  declared: z.boolean().optional(),
  /** 不能编辑时的稳定原因码，由前端映射为中文提示。 */
  readOnlyReason: z.string().min(1).optional(),
  /** Cocos 属性声明类型或构造器名称。 */
  declaredType: z.string().min(1).optional(),
  /** Cocos Inspector 显示名称。 */
  displayName: z.string().min(1).optional(),
  /** Cocos Inspector 提示文本。 */
  tooltip: z.string().min(1).optional(),
  /** Cocos Inspector 分组名称。 */
  group: z.string().min(1).optional(),
  /** 原生分组的 id、style、name、displayOrder。 */
  groupInfo: z.record(z.string(), z.unknown()).optional(),
  /** 只读复合属性的原生结构，供展开查看引用和数组成员。 */
  details: z.unknown().optional(),
  /** Cocos Inspector 显示顺序。 */
  displayOrder: z.number().optional(),
  /** 数字属性的最小值。 */
  min: z.number().optional(),
  /** 数字属性的最大值。 */
  max: z.number().optional(),
  /** 数字属性的步进值。 */
  step: z.number().optional(),
  /** 枚举属性的值和显示名称。 */
  enumOptions: z.array(z.object({
    name: z.string(),
    value: z.number()
  })).optional()
});

export const RuntimeComponentSnapshotSchema = z.object({
  source: z.literal('preview-runtime'),
  previewSessionId: z.string().min(1),
  nodeUuid: z.string().min(1),
  componentType: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  /** 属性 Inspector 元数据；旧运行时未提供时允许缺省。 */
  propertyMeta: z.record(z.string(), RuntimePropertyMetadataSchema).optional(),
  /** 字段结构由同一 Creator 实例的原生 Dump 产生。 */
  inspectorSource: z.literal('creator').optional(),
  /** 原生组件标题是否显示启用开关。 */
  showEnabled: z.boolean().optional(),
  /** 读取 getter/function 失败或被跳过的属性名。 */
  skipped: z.array(z.string()).optional(),
  revision: z.number().int().nonnegative().optional(),
  capturedAt: z.string().min(1)
});

/** 运行时公开属性写入结果；写入必须携带回读值。 */
export const RuntimePropertyWriteSnapshotSchema = z.object({
  source: z.literal('preview-runtime'),
  previewSessionId: z.string().min(1),
  nodeUuid: z.string().min(1),
  componentType: z.string().min(1),
  property: z.string().min(1),
  value: z.unknown(),
  readback: z.unknown(),
  revision: z.number().int().nonnegative().optional(),
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
export type RuntimePlatform = z.infer<typeof RuntimePlatformSchema>;
export type PreviewSession = z.infer<typeof PreviewSessionSchema>;
export type RuntimeNodeSnapshot = z.infer<typeof RuntimeNodeSnapshotSchema>;
export type RuntimeNodeDetails = z.infer<typeof RuntimeNodeDetailsSchema>;
export type RuntimePropertyMetadata = z.infer<typeof RuntimePropertyMetadataSchema>;
export type RuntimeComponentSnapshot = z.infer<typeof RuntimeComponentSnapshotSchema>;
export type RuntimePropertyWriteSnapshot = z.infer<typeof RuntimePropertyWriteSnapshotSchema>;
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
