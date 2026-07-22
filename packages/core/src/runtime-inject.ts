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
 * @param options maxDepth 默认 8；maxNodes 默认 2000。
 * @returns 协议 RuntimeNode 形态的树（含 nodeCount/truncated 汇总）。
 */
async function readRuntimeHierarchy(options: { maxDepth?: number; maxNodes?: number }): Promise<Record<string, unknown>> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
  };
  if (!globalObject.System?.import) return { found: false, reason: 'system-missing' };
  const cc = await globalObject.System.import('cc') as {
    director?: { getScene?: () => Record<string, unknown> | null };
  };
  const scene = cc?.director?.getScene?.();
  if (!scene) return { found: false, reason: 'scene-missing' };

  const maxDepth = typeof options.maxDepth === 'number' && options.maxDepth > 0 ? Math.floor(options.maxDepth) : 8;
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
    const children = Array.isArray(node.children) ? node.children as Array<Record<string, unknown>> : [];
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

  const tree = serializeNode(scene, 1);
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
 * 按节点路径与组件类型读取运行时组件属性包。
 *
 * @param options path 节点路径（如 Canvas/panel/btn）；componentType 组件类型（如 cc.Label）。
 * @returns found 命中标记、节点 uuid、序列化属性与被跳过的字段清单。
 */
async function readRuntimeComponent(options: { path: string; componentType: string }): Promise<Record<string, unknown>> {
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
    nodeUuid: typeof node.uuid === 'string' ? node.uuid : '',
    componentType: actualComponentType,
    properties,
    skipped
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
  readRuntimeComponent
];
