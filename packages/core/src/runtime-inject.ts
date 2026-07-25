/**
 * 页面注入函数集（阶段五）。
 * 这些函数经 runtime-driver 的 evaluate 通道序列化后在 Preview 页面内执行：
 * 必须自包含——函数体只允许引用自身参数与 globalThis，
 * 不得引用模块作用域的任何辅助函数/常量（序列化后不存在）。
 * Node 侧测试通过 stubGlobal 构造假引擎环境直接调用，并用 toString+eval 验证自包含性。
 */

export interface GameReadyState {
  ready: boolean;
  reason?: string;
  sceneName?: string;
  childCount?: number;
}

/**
 * 注入脚本打包：把注册表内全部注入函数的源码拼接为一个 async IIFE，
 * 末尾调用 entry 指定函数。函数间可互相调用（同脚本作用域），
 * 但每个函数仍只允许引用本注册表内的函数与 globalThis。
 *
 * @param entry 入口函数名（必须已注册）。
 * @param args 传给入口函数的参数（JSON 序列化内联）。
 * @returns 可直接交给 page.evaluate 执行的脚本字符串。
 */
export function buildRuntimeScript(entry: string, ...args: unknown[]): string {
  const sources = RUNTIME_INJECT_FUNCTIONS.map((fn) => fn.toString());
  const call = `${entry}(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
  return `(async () => {\n${sources.join('\n')}\nreturn ${call};\n})()`;
}

/**
 * 探测游戏就绪状态：引擎可导入且场景已加载。
 *
 * @returns ready 为 true 时携带场景名与顶层节点数；否则带 reason 诊断。
 */
export async function probeGameReady(): Promise<GameReadyState> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
  };
  if (!globalObject.System?.import) {
    return { ready: false, reason: 'system-missing' };
  }
  try {
    const cc = await globalObject.System.import('cc') as {
      director?: { getScene?: () => { name?: unknown; children?: unknown } | null };
    };
    const scene = cc?.director?.getScene?.();
    if (!scene) {
      return { ready: false, reason: 'scene-missing' };
    }
    return {
      ready: true,
      sceneName: typeof scene.name === 'string' ? scene.name : '',
      childCount: Array.isArray(scene.children) ? scene.children.length : 0
    };
  } catch {
    return { ready: false, reason: 'cc-import-failed' };
  }
}

/**
 * 设置游戏分辨率并派发 resize 事件，等待引擎适配后返回**实际生效**分辨率。
 * 实际生效值受页面容器约束，可能与请求值不同（探针实测 720x1280 生效为 720x826）。
 *
 * @param resolution 请求分辨率。
 * @returns 实际生效分辨率。
 */
export async function setRuntimeResolution(resolution: { width: number; height: number }): Promise<{ width: number; height: number }> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
    dispatchEvent?: (event: unknown) => boolean;
    Event?: new (type: string) => unknown;
    setTimeout?: (callback: () => void, ms: number) => unknown;
  };
  const cc = await globalObject.System!.import!('cc') as {
    screen: { windowSize: { width: number; height: number } };
    Size: new (width: number, height: number) => { width: number; height: number };
  };
  cc.screen.windowSize = new cc.Size(resolution.width, resolution.height);
  globalObject.dispatchEvent!(new globalObject.Event!('resize'));
  await new Promise<void>((resolve) => {
    globalObject.setTimeout!(() => resolve(), 100);
  });
  const size = cc.screen.windowSize;
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

/**
 * 读取当前实际生效分辨率。
 *
 * @returns 当前 cc.screen.windowSize 的整数宽高。
 */
export async function readRuntimeResolution(): Promise<{ width: number; height: number }> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
  };
  const cc = await globalObject.System!.import!('cc') as {
    screen: { windowSize: { width: number; height: number } };
  };
  const size = cc.screen.windowSize;
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

/**
 * 读取 GameCanvas 元素的页面包围盒（CSS 像素，左上角原点）。
 * 输入模拟的坐标换算基础：画布内坐标 + 包围盒偏移 = 页面坐标。
 *
 * @returns 包围盒；画布缺失时返回 null。
 */
export async function readCanvasRect(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const globalObject = globalThis as {
    document?: { getElementById?: (id: string) => { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } } | null };
  };
  const canvas = globalObject.document?.getElementById?.('GameCanvas');
  if (!canvas?.getBoundingClientRect) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * 读取指定节点路径的边界矩形与锚点（画布 CSS 像素坐标系）。
 * 世界坐标（原点屏幕中心、Y 向上）经 cc.screen.windowSize 与画布 CSS 尺寸换算。
 *
 * @param options paths 节点路径列表。
 * @returns 逐项 found/rect/anchor；无 UITransform 的节点标注 hasBounds:false。
 */
export async function readRuntimeNodeBounds(options: { paths: string[] }): Promise<Record<string, unknown>> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
    document?: { getElementById?: (id: string) => { getBoundingClientRect?: () => { width: number; height: number } } | null };
  };
  if (!globalObject.System?.import) return { entries: [] };
  const cc = await globalObject.System.import('cc') as {
    director?: { getScene?: () => Record<string, unknown> | null };
    screen: { windowSize: { width: number; height: number } };
    UITransform?: unknown;
  };
  const scene = cc?.director?.getScene?.();
  if (!scene) return { entries: [] };
  const canvasRect = globalObject.document?.getElementById?.('GameCanvas')?.getBoundingClientRect?.();
  const winSize = cc.screen.windowSize;
  const scaleX = canvasRect && winSize.width > 0 ? canvasRect.width / winSize.width : 1;
  const scaleY = canvasRect && winSize.height > 0 ? canvasRect.height / winSize.height : 1;
  const toCss = (worldX: number, worldY: number): { x: number; y: number } => ({
    x: (worldX + winSize.width / 2) * scaleX,
    y: (winSize.height - (worldY + winSize.height / 2)) * scaleY
  });

  const entries: Array<Record<string, unknown>> = [];
  for (const path of options.paths ?? []) {
    const located = findRuntimeNodeByPath(scene, path);
    if (!located.node) {
      entries.push({ path, found: false });
      continue;
    }
    const node = located.node as {
      getComponent?: (type: unknown) => { getBoundingBoxToWorld?: () => { x: number; y: number; width: number; height: number } } | null;
      worldPosition?: { x: number; y: number };
    };
    const ui = typeof node.getComponent === 'function' ? node.getComponent(cc.UITransform) : null;
    if (!ui || typeof ui.getBoundingBoxToWorld !== 'function') {
      entries.push({ path, found: true, hasBounds: false });
      continue;
    }
    const box = ui.getBoundingBoxToWorld();
    const topLeft = toCss(box.x, box.y + box.height);
    const bottomRight = toCss(box.x + box.width, box.y);
    const entry: Record<string, unknown> = {
      path,
      found: true,
      hasBounds: true,
      rect: { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y }
    };
    if (node.worldPosition) {
      entry.anchor = toCss(node.worldPosition.x, node.worldPosition.y);
    }
    entries.push(entry);
  }
  return { entries };
}

/** 读取组件类型名（兼容压缩/自定义组件）。 */
function readRuntimeComponentType(component: unknown): string {
  const record = component as { __typename__?: unknown; constructor?: { name?: unknown } };
  if (typeof record?.__typename__ === 'string' && record.__typename__) return record.__typename__;
  if (typeof record?.constructor?.name === 'string' && record.constructor.name) return record.constructor.name;
  return 'unknown';
}

/**
 * 序列化运行时属性值：原始类型直返；ValueType 与普通对象递归（跳过 constructor/下划线键/函数）；
 * 节点引用标记；循环引用与超深防护；重型对象按键数熔断。
 */
function serializeRuntimeValue(value: unknown, depth: number, seen: Set<unknown>): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return { __type: 'function' };
  if (seen.has(value)) return { __type: 'circular-reference' };
  if (depth > 4) return { __type: 'max-depth-exceeded' };
  if (Array.isArray(value)) {
    seen.add(value);
    const items = value.slice(0, 50).map((item) => serializeRuntimeValue(item, depth + 1, seen));
    if (value.length > 50) items.push({ __type: 'truncated', total: value.length } as never);
    seen.delete(value);
    return items;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // 节点引用：duck typing（uuid + children + active）
    if (typeof record.uuid === 'string' && Array.isArray(record.children) && typeof record.active === 'boolean') {
      return { __type: 'node-reference', uuid: record.uuid, name: typeof record.name === 'string' ? record.name : '' };
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    const keys = Object.keys(record).filter((key) => key !== 'constructor' && !key.startsWith('__') && !key.startsWith('_'));
    if (keys.length > 30) {
      seen.delete(value);
      return { __type: 'complex-object', keys: keys.length };
    }
    for (const key of keys) {
      const item = record[key];
      if (typeof item === 'function') continue;
      output[key] = serializeRuntimeValue(item, depth + 1, seen);
    }
    seen.delete(value);
    return output;
  }
  return null;
}

/**
 * 序列化运行时场景层级：节点身份、active、组件类型、动态创建标注；
 * 深度与节点数上限截断并显式标注（AI 必须知晓读取不完整）。
 *
 * @param options 运行时层级读取选项。
 * @param options.maxDepth 最大序列化深度，默认 8。
 * @param options.maxNodes 最大序列化节点数，默认 2000。
 * @param options.path 可选节点路径；提供时只读取目标子树。
 * @param options.includeInactive 是否包含未激活节点，默认 true。
 * @returns 协议 RuntimeNode 形态的树（含 nodeCount/truncated 汇总）。
 */
async function readRuntimeHierarchy(options: {
  maxDepth?: number;
  maxNodes?: number;
  path?: string;
  includeInactive?: boolean;
}): Promise<Record<string, unknown>> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
  };
  if (!globalObject.System?.import) return { found: false, reason: 'system-missing' };
  const cc = await globalObject.System.import('cc') as {
    director?: { getScene?: () => Record<string, unknown> | null };
  };
  const scene = cc?.director?.getScene?.();
  if (!scene) return { found: false, reason: 'scene-missing' };

  // 指定路径时从目标节点开始序列化；未命中沿用组件定位的候选子节点证据。
  let root = scene;
  if (typeof options.path === 'string' && options.path) {
    const located = findRuntimeNodeByPath(scene, options.path);
    if (!located.node) {
      const parent = located.failedAtParent;
      const siblings = parent && Array.isArray(parent.children)
        ? (parent.children as Array<Record<string, unknown>>)
          .map((child) => (typeof child.name === 'string' ? child.name : ''))
        : [];
      return { found: false, reason: 'node-not-found', availableChildren: siblings };
    }
    root = located.node;
  }

  const maxDepth = typeof options.maxDepth === 'number' && options.maxDepth > 0 ? Math.floor(options.maxDepth) : 8;
  const includeInactive = options.includeInactive !== false;
  const state = {
    nodeCount: 0,
    truncated: false,
    maxNodes: typeof options.maxNodes === 'number' && options.maxNodes > 0 ? Math.floor(options.maxNodes) : 2_000
  };

  const serializeNode = (node: Record<string, unknown>, depth: number): Record<string, unknown> => {
    state.nodeCount += 1;
    const result: Record<string, unknown> = {
      uuid: typeof node.uuid === 'string' ? node.uuid : '',
      name: typeof node.name === 'string' ? node.name : '',
      active: node.active !== false,
      // 场景序列化来源的节点带 fileId（_id），运行时动态创建的为空。
      dynamic: !node._id,
      components: (Array.isArray(node.components) ? node.components : []).map((component) => ({
        type: readRuntimeComponentType(component)
      }))
    };
    // 未激活子树在过滤模式下完全跳过，不占深度或节点额度。
    const children = (Array.isArray(node.children) ? node.children as Array<Record<string, unknown>> : [])
      .filter((child) => includeInactive || child.active !== false);
    if (depth >= maxDepth) {
      if (children.length > 0) {
        result.truncated = true;
        state.truncated = true;
      }
      return result;
    }
    const serializedChildren: Array<Record<string, unknown>> = [];
    for (const child of children) {
      if (state.nodeCount >= state.maxNodes) {
        result.truncated = true;
        state.truncated = true;
        break;
      }
      serializedChildren.push(serializeNode(child, depth + 1));
    }
    if (serializedChildren.length > 0) result.children = serializedChildren;
    return result;
  };

  const tree = serializeNode(root, 1);
  tree.nodeCount = state.nodeCount;
  if (state.truncated) tree.truncated = true;
  return tree;
}

/** 按 `/` 分隔的名称路径查找节点；首段与场景名相同则跳过。 */
function findRuntimeNodeByPath(
  scene: Record<string, unknown>,
  path: string
): { node?: Record<string, unknown>; failedAtParent?: Record<string, unknown> } {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  let current = scene;
  let index = segments[0] === (scene.name as string) ? 1 : 0;
  for (; index < segments.length; index += 1) {
    const children = Array.isArray(current.children) ? current.children as Array<Record<string, unknown>> : [];
    const next = children.find((child) => child.name === segments[index]);
    if (!next) return { failedAtParent: current };
    current = next;
  }
  return { node: current };
}

/**
 * 共用定位：按节点路径与组件类型定位运行时组件（含 cc. 前缀兼容匹配）。
 *
 * @param options path 节点路径；componentType 组件类型。
 * @returns found 命中时携带 node/component/actualComponentType；未命中时携带 reason 与候选清单。
 */
async function locateRuntimeComponent(options: { path: string; componentType: string }): Promise<Record<string, unknown>> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
  };
  if (!globalObject.System?.import) return { found: false, reason: 'system-missing' };
  const cc = await globalObject.System.import('cc') as {
    director?: { getScene?: () => Record<string, unknown> | null };
  };
  const scene = cc?.director?.getScene?.();
  if (!scene) return { found: false, reason: 'scene-missing' };

  const located = findRuntimeNodeByPath(scene, options.path);
  if (!located.node) {
    const parent = located.failedAtParent;
    const siblings = parent && Array.isArray(parent.children)
      ? (parent.children as Array<Record<string, unknown>>).map((child) => (typeof child.name === 'string' ? child.name : ''))
      : [];
    return { found: false, reason: 'node-not-found', availableChildren: siblings };
  }
  const node = located.node;
  const components = Array.isArray(node.components) ? node.components : [];
  // 运行时内置组件类型名不带 cc. 前缀（__typename__ 为 UITransform 而非 cc.UITransform）；
  // 精确未命中时尝试去前缀兼容匹配，并回传实际匹配类型名。
  let component = components.find((item) => readRuntimeComponentType(item) === options.componentType) as Record<string, unknown> | undefined;
  let actualComponentType = options.componentType;
  if (!component && options.componentType.startsWith('cc.')) {
    const bareType = options.componentType.slice(3);
    component = components.find((item) => readRuntimeComponentType(item) === bareType) as Record<string, unknown> | undefined;
    if (component) actualComponentType = bareType;
  }
  if (!component) {
    return {
      found: false,
      reason: 'component-not-found',
      nodeUuid: typeof node.uuid === 'string' ? node.uuid : '',
      availableComponents: components.map((item) => readRuntimeComponentType(item))
    };
  }
  return {
    found: true,
    node,
    component,
    actualComponentType,
    nodeUuid: typeof node.uuid === 'string' ? node.uuid : ''
  };
}

/**
 * 按节点路径与组件类型读取运行时组件属性包。
 *
 * @param options path 节点路径（如 Canvas/panel/btn）；componentType 组件类型（如 cc.Label）。
 * @returns found 命中标记、节点 uuid、序列化属性与被跳过的字段清单。
 */
async function readRuntimeComponent(options: { path: string; componentType: string }): Promise<Record<string, unknown>> {
  const located = await locateRuntimeComponent(options);
  if (located.found !== true) return located;
  const component = located.component as Record<string, unknown>;

  const skipped: string[] = [];
  const seen = new Set<unknown>([component]);
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(component)) {
    if (key === 'constructor' || key.startsWith('__')) continue;
    let value: unknown;
    try {
      value = component[key];
    } catch {
      skipped.push(key);
      continue;
    }
    if (typeof value === 'function') {
      skipped.push(key);
      continue;
    }
    properties[key] = serializeRuntimeValue(value, 1, seen);
  }
  return {
    found: true,
    nodeUuid: located.nodeUuid,
    componentType: located.actualComponentType,
    properties,
    skipped
  };
}

/** 校验 invoke 参数 JSON 安全：拒绝函数/undefined/Symbol/bigint 与携带 __type 标记的对象。 */
function isRuntimeArgsSafe(value: unknown, depth: number): boolean {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return true;
  if (valueType !== 'object') return false;
  if (depth > 6) return false;
  if (Array.isArray(value)) return value.every((item) => isRuntimeArgsSafe(item, depth + 1));
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.includes('__type')) return false;
  return keys.every((key) => isRuntimeArgsSafe((value as Record<string, unknown>)[key], depth + 1));
}

/** 沿原型链收集组件全部方法名（class 方法在原型上，不可枚举）。 */
function listRuntimeMethods(component: unknown): string[] {
  const methods = new Set<string>();
  let cursor = component as Record<string, unknown> | null;
  while (cursor && cursor !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(cursor)) {
      if (key === 'constructor' || key.startsWith('__')) continue;
      try {
        if (typeof cursor[key] === 'function') methods.add(key);
      } catch {
        // 读取失败的键忽略
      }
    }
    cursor = Object.getPrototypeOf(cursor) as Record<string, unknown> | null;
  }
  return [...methods];
}

/**
 * 在已经定位的组件上调用方法，共享危险方法与参数安全校验。
 *
 * @param located 已定位的组件、节点 UUID 与实际组件类型。
 * @param options 方法调用选项。
 * @param options.method 方法名。
 * @param options.args 可选位置参数。
 * @returns invoked 调用标记、序列化返回值或失败原因。
 */
async function invokeLocatedRuntimeMethod(
  located: Record<string, unknown>,
  options: { method: string; args?: unknown[] }
): Promise<Record<string, unknown>> {
  // 生命周期与危险方法黑名单（内联字面量：模块级常量在打包脚本作用域中不存在）。
  const blocklist = [
    'onLoad', 'start', 'update', 'lateUpdate', 'onEnable', 'onDisable', 'onDestroy',
    'onFocusInEditor', 'onLostFocusInEditor', 'resetInEditor',
    'eval', 'Function', 'constructor'
  ];
  if (blocklist.includes(options.method)) {
    return { invoked: false, method: options.method, reason: 'method-not-allowed' };
  }
  const args = Array.isArray(options.args) ? options.args : [];
  if (!args.every((arg) => isRuntimeArgsSafe(arg, 1))) {
    return { invoked: false, method: options.method, reason: 'invalid-args' };
  }
  const component = located.component as Record<string, unknown>;
  const method = component[options.method];
  if (typeof method !== 'function') {
    return {
      found: false,
      invoked: false,
      method: options.method,
      reason: 'method-not-found',
      nodeUuid: located.nodeUuid,
      availableMethods: listRuntimeMethods(component)
    };
  }
  try {
    const returnValue = await (method as (...rest: unknown[]) => unknown).apply(component, args);
    return {
      found: true,
      invoked: true,
      method: options.method,
      nodeUuid: located.nodeUuid,
      componentType: located.actualComponentType,
      returnValue: serializeRuntimeValue(returnValue, 1, new Set())
    };
  } catch (error) {
    return {
      found: true,
      invoked: false,
      method: options.method,
      reason: 'method-threw',
      nodeUuid: located.nodeUuid,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * 按路径定位组件并调用指定方法。
 *
 * @param options 运行时组件方法调用选项。
 * @param options.path 节点路径。
 * @param options.componentType 组件类型。
 * @param options.method 方法名。
 * @param options.args 可选位置参数。
 * @returns invoked 调用标记、序列化返回值或定位/调用失败原因。
 */
async function invokeRuntimeComponentMethod(options: {
  path: string;
  componentType: string;
  method: string;
  args?: unknown[];
}): Promise<Record<string, unknown>> {
  const located = await locateRuntimeComponent({ path: options.path, componentType: options.componentType });
  if (located.found !== true) return located;
  return invokeLocatedRuntimeMethod(located, { method: options.method, args: options.args ?? [] });
}

/**
 * 在一次页面 evaluate 内完成时间窗口采样，避免跨进程轮询错过短过渡。
 *
 * @param options 时间窗口采样选项。
 * @param options.path 节点路径。
 * @param options.componentType 组件类型。
 * @param options.properties 要采样的属性点路径。
 * @param options.mode 逐帧模式或固定毫秒间隔。
 * @param options.durationMs 采样持续时间。
 * @param options.trigger 采样前可选调用的组件方法与参数。
 * @returns 定位身份、逐帧样本、可选触发结果与截断标记。
 */
async function sampleRuntimeWindow(options: {
  path: string;
  componentType: string;
  properties: string[];
  mode: 'perFrame' | { intervalMs: number };
  durationMs: number;
  trigger?: { method: string; args?: unknown[] };
}): Promise<Record<string, unknown>> {
  const located = await locateRuntimeComponent({ path: options.path, componentType: options.componentType });
  if (located.found !== true) return located;

  const component = located.component as Record<string, unknown>;
  const node = located.node as Record<string, unknown>;
  let triggerResult: Record<string, unknown> | undefined;
  if (options.trigger) {
    triggerResult = await invokeLocatedRuntimeMethod(located, {
      method: options.trigger.method,
      args: options.trigger.args ?? []
    });
    if (triggerResult.invoked !== true) {
      return {
        found: false,
        reason: 'trigger-failed',
        nodeUuid: located.nodeUuid,
        componentType: located.actualComponentType,
        trigger: triggerResult
      };
    }
  }

  const globalObject = globalThis as {
    performance?: { now?: () => number };
    requestAnimationFrame?: (callback: (timestamp: number) => void) => unknown;
    setTimeout?: (callback: () => void, delay: number) => unknown;
  };
  const now = (): number => typeof globalObject.performance?.now === 'function'
    ? globalObject.performance.now()
    : Date.now();
  const startedAt = now();
  const samples: Array<Record<string, unknown>> = [];
  const maxSamples = 3_600;
  let frame = 0;
  let truncated = false;

  const capture = (): boolean => {
    const timestamp = now();
    let nodeValid = true;
    try {
      nodeValid = node.isValid !== false && component.isValid !== false;
    } catch {
      nodeValid = false;
    }

    const values: Record<string, unknown> = {};
    if (nodeValid) {
      for (const property of options.properties) {
        const segments = property.split('.').filter((segment) => segment.length > 0);
        let value: unknown = component;
        try {
          for (const segment of segments) {
            if (value === null || value === undefined || typeof value !== 'object') {
              value = undefined;
              break;
            }
            value = (value as Record<string, unknown>)[segment];
          }
          values[property] = serializeRuntimeValue(value, 1, new Set([component]));
        } catch {
          values[property] = null;
        }
      }
    }

    if (samples.length < maxSamples) {
      samples.push({ frame, t: timestamp, values, nodeValid });
    } else {
      truncated = true;
    }
    frame += 1;
    return timestamp - startedAt >= options.durationMs;
  };

  capture();
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (capture()) {
        resolve();
        return;
      }
      schedule();
    };
    const schedule = (): void => {
      if (options.mode === 'perFrame' && typeof globalObject.requestAnimationFrame === 'function') {
        globalObject.requestAnimationFrame(() => tick());
        return;
      }
      const delay = options.mode === 'perFrame' ? 16 : options.mode.intervalMs;
      if (typeof globalObject.setTimeout === 'function') {
        globalObject.setTimeout(tick, delay);
        return;
      }
      Promise.resolve().then(tick);
    };
    schedule();
  });

  return {
    found: true,
    nodeUuid: located.nodeUuid,
    componentType: located.actualComponentType,
    mode: options.mode,
    durationMs: options.durationMs,
    samples,
    ...(triggerResult ? { trigger: triggerResult } : {}),
    ...(truncated ? { truncated: true } : {})
  };
}

/**
 * 读取运行时组件属性（支持 `a.b.c` 点路径），用于属性监听与断言。
 *
 * @param options path 节点路径；componentType 组件类型；property 属性路径。
 * @returns found 命中标记与序列化属性值。
 */
async function readRuntimeProperty(options: { path: string; componentType: string; property: string }): Promise<Record<string, unknown>> {
  const located = await locateRuntimeComponent({ path: options.path, componentType: options.componentType });
  if (located.found !== true) return located;
  const component = located.component as Record<string, unknown>;
  const segments = options.property.split('.').filter((segment) => segment.length > 0);
  let value: unknown = component;
  for (const segment of segments) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return { found: false, reason: 'property-not-found', nodeUuid: located.nodeUuid, property: options.property };
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (value === undefined) {
    return { found: false, reason: 'property-not-found', nodeUuid: located.nodeUuid, property: options.property };
  }
  return {
    found: true,
    nodeUuid: located.nodeUuid,
    componentType: located.actualComponentType,
    property: options.property,
    value: serializeRuntimeValue(value, 1, new Set([component]))
  };
}

/**
 * 运行时实例化 Prefab 并挂到指定节点（仅运行时，不写工程文件）。
 * 用于 UI 效果的快速预览验证。
 *
 * @param options assetUuid Prefab 资产 UUID；parentPath 父节点路径；x/y 可选放置坐标。
 * @returns done 完成标记与实例节点路径；失败带 reason。
 */
async function instantiateRuntimePrefab(options: {
  assetUuid: string;
  parentPath: string;
  x?: number;
  y?: number;
}): Promise<Record<string, unknown>> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
  };
  if (!globalObject.System?.import) return { done: false, reason: 'system-missing' };
  const cc = await globalObject.System.import('cc') as {
    assetManager?: { loadAny?: (request: unknown, callback: (error: unknown, asset: unknown) => void) => void };
    instantiate?: (prefab: unknown) => Record<string, unknown>;
    director?: { getScene?: () => Record<string, unknown> | null };
  };
  const scene = cc?.director?.getScene?.();
  if (!scene) return { done: false, reason: 'scene-missing' };
  const located = findRuntimeNodeByPath(scene, options.parentPath);
  if (!located.node) return { done: false, reason: 'parent-not-found' };
  const parent = located.node as { addChild?: (child: unknown) => void };
  if (typeof parent.addChild !== 'function') return { done: false, reason: 'parent-invalid' };
  const loadAny = cc.assetManager?.loadAny;
  if (typeof loadAny !== 'function') {
    return { done: false, reason: 'asset-manager-missing' };
  }
  const instantiate = cc.instantiate;
  if (typeof instantiate !== 'function') {
    return { done: false, reason: 'instantiate-missing' };
  }

  const prefab = await new Promise<unknown>((resolve, reject) => {
    loadAny(options.assetUuid, (error: unknown, asset: unknown) => {
      if (error) reject(error);
      else resolve(asset);
    });
  }).catch((error: unknown) => ({ __loadError: error instanceof Error ? error.message : String(error) }));
  if (prefab && typeof prefab === 'object' && (prefab as Record<string, unknown>).__loadError) {
    return { done: false, reason: 'prefab-load-failed', error: (prefab as Record<string, unknown>).__loadError };
  }
  const instance = instantiate(prefab) as Record<string, unknown> & {
    name?: string;
    setPosition?: (x: number, y: number, z?: number) => void;
  };
  parent.addChild(instance);
  if (typeof options.x === 'number' && typeof options.y === 'number' && typeof instance.setPosition === 'function') {
    instance.setPosition(options.x, options.y);
  }
  const parentName = typeof (located.node as Record<string, unknown>).name === 'string'
    ? (located.node as Record<string, unknown>).name as string
    : '';
  return {
    done: true,
    nodePath: `${options.parentPath}/${typeof instance.name === 'string' && instance.name ? instance.name : 'prefab-instance'}`,
    parentName
  };
}

/** 注入函数注册表：buildRuntimeScript 全量打包（顺序无关，函数声明提升）。 */
const RUNTIME_INJECT_FUNCTIONS: Array<(...args: never[]) => unknown> = [
  probeGameReady,
  setRuntimeResolution,
  readRuntimeResolution,
  readRuntimeComponentType,
  serializeRuntimeValue,
  readRuntimeHierarchy,
  findRuntimeNodeByPath,
  readRuntimeComponent,
  locateRuntimeComponent,
  isRuntimeArgsSafe,
  listRuntimeMethods,
  invokeLocatedRuntimeMethod,
  invokeRuntimeComponentMethod,
  sampleRuntimeWindow,
  readRuntimeProperty,
  readCanvasRect,
  readRuntimeNodeBounds,
  instantiateRuntimePrefab
];
