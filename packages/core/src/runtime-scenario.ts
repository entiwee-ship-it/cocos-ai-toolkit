import { ScenarioReportSchema, type Resolution, type ScenarioReport, type ScenarioStep, type ScenarioStepResult } from '@cocos-ai/protocol';

/**
 * 自动场景验证编排：按步骤序列驱动 Preview 运行时，
 * 逐步产出 expected/actual/passed 证据。结构化数据为真值，截图为辅助证据。
 * 运行时操作经 ScenarioRuntime 注入（Probe Server 以 driver + Bridge 装配）。
 */

/** 场景运行时操作集（由装配方实现）。 */
export interface ScenarioRuntime {
  /** 启动 Preview 会话（launch 步骤且无既有会话时调用）。 */
  launch(input: { projectId: string; resolution?: Resolution }): Promise<{ sessionId: string }>;
  /** 有界等待节点出现。 */
  waitNode(sessionId: string, path: string, timeoutMs: number): Promise<{ found: boolean }>;
  /** 读取组件属性（序列化形态）。 */
  readProperty(sessionId: string, path: string, componentType: string, property: string): Promise<{ found: boolean; value?: unknown; reason?: string }>;
  /** 派发输入。 */
  dispatchInput(sessionId: string, input: { inputType: string; x?: number; y?: number; key?: string }): Promise<unknown>;
  /** 在运行时节点下实例化 Prefab。 */
  instantiatePrefab(sessionId: string, input: {
    assetUuid: string;
    parentPath: string;
    x?: number;
    y?: number;
  }): Promise<{ done: boolean; reason?: string; error?: string; [key: string]: unknown }>;
  /** 关闭 Preview 会话。 */
  stop(sessionId: string): Promise<{ closed: boolean; [key: string]: unknown }>;
  /** 增量读取 console。 */
  readConsole(sessionId: string, sinceSeq: number): Promise<{ entries: Array<{ level: string; text: string }>; nextSeq: number }>;
  /** 截图并落盘，返回文件路径。 */
  capture(sessionId: string, options: {
    resolution?: Resolution;
    crop?: { x: number; y: number; width: number; height: number };
    overlay?: { nodeBounds?: boolean | string[]; anchors?: boolean | string[] };
  }): Promise<{ path: string }>;
  /** 当前画面与基准图像差异比较，返回差异比例与差异图路径。 */
  imageDiff(sessionId: string, baselinePath: string, threshold: number): Promise<{ diffRatio: number; diffPngPath: string }>;
}

export interface RunScenarioOptions {
  /** 既有会话（launch 步骤复用）。 */
  sessionId?: string;
  /** launch 步骤新建会话所需的项目 ID。 */
  projectId?: string;
  /** console 轮询间隔毫秒，默认 250。 */
  consolePollMs?: number;
  /** assert-console 默认超时毫秒，默认 3000。 */
  consoleTimeoutMs?: number;
  now?: () => Date;
}

/**
 * 按序执行场景步骤并产出报告。
 *
 * @param steps 场景步骤序列（协议 ScenarioStep）。
 * @param runtime 场景运行时操作集。
 * @param options 会话与轮询参数。
 * @returns 场景报告（通过协议 Schema 校验）。
 */
export async function runRuntimeScenario(
  steps: ScenarioStep[],
  runtime: ScenarioRuntime,
  options: RunScenarioOptions = {}
): Promise<ScenarioReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results: ScenarioStepResult[] = [];
  let sessionId = options.sessionId;
  let aborted = false;
  let hadFailure = false;
  // Console 游标以场景启动时刻为基准：断言匹配场景运行期间出现的日志，
  // 覆盖"动作同步产生日志"的典型用法（步骤开始前已入缓冲也能匹配）。
  let consoleCursor = 0;
  if (sessionId) {
    try {
      consoleCursor = (await runtime.readConsole(sessionId, 0)).nextSeq;
    } catch (error) {
      const cleanupFailures: Array<{ index: number; error?: string; actual?: unknown }> = [];
      for (const [index, step] of steps.entries()) {
        if (step.kind !== 'stop' || step.always !== true) continue;
        const cleanup = await executeStep(
          step,
          index,
          runtime,
          options,
          () => sessionId,
          () => undefined,
          () => consoleCursor
        );
        if (!cleanup.passed) {
          cleanupFailures.push({
            index,
            ...(cleanup.error ? { error: cleanup.error } : {}),
            ...(cleanup.actual !== undefined ? { actual: cleanup.actual } : {})
          });
        }
      }
      if (cleanupFailures.length) {
        const baselineMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`${baselineMessage};SCENARIO_ALWAYS_STOP_FAILED:${JSON.stringify(cleanupFailures)}`);
      }
      throw error;
    }
  }

  for (const [index, step] of steps.entries()) {
    if (aborted && !(step.kind === 'stop' && step.always === true)) {
      continue;
    }
    const result = await executeStep(step, index, runtime, options, () => sessionId, (next) => {
      sessionId = next;
      // 新 launch 的会话缓冲全新；stop 后也清掉旧游标。
      consoleCursor = 0;
    }, () => consoleCursor);
    results.push(result);
    if (!result.passed) {
      hadFailure = true;
      if (step.onFail !== 'continue') {
        aborted = true;
      }
    }
  }

  return ScenarioReportSchema.parse({
    steps: results,
    passed: !hadFailure && results.every((result) => result.passed),
    startedAt,
    finishedAt: now().toISOString()
  });
}

async function executeStep(
  step: ScenarioStep,
  index: number,
  runtime: ScenarioRuntime,
  options: RunScenarioOptions,
  readSessionId: () => string | undefined,
  writeSessionId: (sessionId: string | undefined) => void,
  readConsoleCursor: () => number
): Promise<ScenarioStepResult> {
  const base = { index, kind: step.kind as string };
  try {
    switch (step.kind) {
      case 'launch': {
        const existing = readSessionId();
        if (existing) {
          return { ...base, passed: true, actual: existing };
        }
        if (!options.projectId) {
          return { ...base, passed: false, error: 'SCENARIO_PROJECT_ID_REQUIRED' };
        }
        const launched = await runtime.launch({
          projectId: options.projectId,
          ...(step.resolution ? { resolution: step.resolution } : {})
        });
        writeSessionId(launched.sessionId);
        return { ...base, passed: true, actual: launched.sessionId };
      }
      case 'wait-node': {
        const sid = requireSessionId(readSessionId());
        const timeoutMs = step.timeoutMs ?? 5_000;
        const result = await runtime.waitNode(sid, step.path, timeoutMs);
        return {
          ...base,
          passed: result.found,
          expected: step.path,
          actual: result.found ? step.path : 'not-found',
          ...(result.found ? {} : { error: `等待节点超时（${timeoutMs}ms）` })
        };
      }
      case 'assert-property': {
        const sid = requireSessionId(readSessionId());
        const parsed = parsePropertyPath(step.property);
        if (!parsed) {
          return { ...base, passed: false, error: `INVALID_PROPERTY_PATH:${step.property}（应为 组件类型.属性路径）` };
        }
        const result = await runtime.readProperty(sid, step.path, parsed.componentType, parsed.property);
        if (!result.found) {
          return { ...base, passed: false, expected: step.expected, actual: null, error: result.reason ?? 'property-not-found' };
        }
        const passed = deepEqual(result.value, step.expected);
        return { ...base, passed, expected: step.expected, actual: result.value };
      }
      case 'dispatch-input': {
        const sid = requireSessionId(readSessionId());
        const receipt = await runtime.dispatchInput(sid, {
          inputType: step.inputType,
          ...(step.x !== undefined ? { x: step.x } : {}),
          ...(step.y !== undefined ? { y: step.y } : {}),
          ...(step.key !== undefined ? { key: step.key } : {})
        });
        return { ...base, passed: true, actual: receipt as never };
      }
      case 'instantiate-prefab': {
        const sid = requireSessionId(readSessionId());
        const result = await runtime.instantiatePrefab(sid, {
          assetUuid: step.assetUuid,
          parentPath: step.parentPath,
          ...(step.x !== undefined ? { x: step.x } : {}),
          ...(step.y !== undefined ? { y: step.y } : {})
        });
        return {
          ...base,
          passed: result.done === true,
          expected: { done: true },
          actual: result,
          ...(result.done === true ? {} : {
            error: `INSTANTIATE_PREFAB_FAILED:${result.reason ?? 'unknown'}${result.error ? `:${result.error}` : ''}`
          })
        };
      }
      case 'assert-console': {
        const sid = requireSessionId(readSessionId());
        const timeoutMs = step.timeoutMs ?? options.consoleTimeoutMs ?? 3_000;
        const pollMs = options.consolePollMs ?? 250;
        const pattern = new RegExp(step.pattern);
        const deadline = Date.now() + timeoutMs;
        let cursor = readConsoleCursor();
        while (true) {
          const page = await runtime.readConsole(sid, cursor);
          cursor = page.nextSeq;
          const hit = page.entries.find((entry) => (!step.level || entry.level === step.level) && pattern.test(entry.text));
          if (hit) {
            return { ...base, passed: true, expected: step.pattern, actual: hit.text };
          }
          if (Date.now() >= deadline) {
            return { ...base, passed: false, expected: step.pattern, actual: null, error: `超时（${timeoutMs}ms）未匹配 Console` };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        }
      }
      case 'capture': {
        const sid = requireSessionId(readSessionId());
        const captured = await runtime.capture(sid, {
          ...(step.resolution ? { resolution: step.resolution } : {}),
          ...(step.crop ? { crop: step.crop } : {}),
          ...(step.overlay ? { overlay: step.overlay } : {})
        });
        return { ...base, passed: true, evidence: captured.path };
      }
      case 'assert-image-diff': {
        const sid = requireSessionId(readSessionId());
        const result = await runtime.imageDiff(sid, step.baselinePath, step.threshold);
        const passed = result.diffRatio <= step.threshold;
        return {
          ...base,
          passed,
          expected: step.threshold,
          actual: result.diffRatio,
          evidence: result.diffPngPath
        };
      }
      case 'stop': {
        const sid = requireSessionId(readSessionId());
        const result = await runtime.stop(sid);
        if (result.closed !== true) {
          return { ...base, passed: false, expected: { closed: true }, actual: result, error: 'PREVIEW_CLOSE_NOT_CONFIRMED' };
        }
        writeSessionId(undefined);
        return { ...base, passed: true, actual: result };
      }
      default:
        return { ...base, passed: false, error: `UNKNOWN_STEP_KIND:${(step as { kind: string }).kind}` };
    }
  } catch (error) {
    return { ...base, passed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new Error('SCENARIO_SESSION_REQUIRED');
  }
  return sessionId;
}

/** 解析 `组件类型.属性路径`：cc. 前缀的组件类型本身含点，拆分点取第二个点（如 cc.Label.string → cc.Label + string）。 */
function parsePropertyPath(value: string): { componentType: string; property: string } | null {
  const firstDot = value.indexOf('.');
  if (firstDot <= 0 || firstDot === value.length - 1) return null;
  const boundary = value.startsWith('cc.') ? value.indexOf('.', firstDot + 1) : firstDot;
  if (boundary <= 0 || boundary === value.length - 1) return null;
  return { componentType: value.slice(0, boundary), property: value.slice(boundary + 1) };
}

/** 深比较（JSON 语义）。 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null || typeof left !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key]
  ));
}
