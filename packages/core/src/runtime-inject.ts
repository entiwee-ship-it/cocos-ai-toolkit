/**
 * 页面注入函数集。
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
 * 通过 Creator 自己的原生输入源派发事件，避免 Win32 消息缺失有效窗口上下文。
 * 坐标为游戏画面像素，原点在左上角；Creator Simulator 3.8.x 的主窗口 ID 为 1。
 *
 * @param options 高层点击/按键，或 Workbench 的完整指针、滚轮和键盘事件。
 * @returns 仅确认事件已进入 Creator 输入缓存，游戏响应仍需后续断言。
 */
export async function dispatchRuntimeInput(options: {
  inputType: 'tap' | 'click' | 'key' | 'pointerdown' | 'pointermove' | 'pointerup' | 'wheel' | 'keydown' | 'keyup' | 'text';
  x?: number; y?: number; key?: string; code?: string; keyCode?: number;
  button?: number; buttons?: number; delta?: number; text?: string;
}): Promise<Record<string, unknown>> {
  if (options.inputType === 'text') throw new Error('CREATOR_SIMULATOR_TEXT_INPUT_UNAVAILABLE');
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, any>> };
    jsb?: { ISystemWindowManager?: { getInstance?: () => { getWindow?: (id: number) => { getViewSize?: () => { width: number; height: number } } | null } } };
    __cocosAiRuntimeInputState?: { x: number; y: number; buttons: number };
  };
  const cc = await globalObject.System?.import?.('cc');
  const windowId = 1;
  const window = globalObject.jsb?.ISystemWindowManager?.getInstance?.().getWindow?.(windowId);
  const size = window?.getViewSize?.();
  if (!cc?.input || !size || !(size.width > 0) || !(size.height > 0)) {
    throw new Error('CREATOR_SIMULATOR_INPUT_WINDOW_UNAVAILABLE');
  }

  const normalizeCode = (key: string): string => {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^\d$/.test(key)) return `Digit${key}`;
    if (key === ' ') return 'Space';
    if (key === 'Esc') return 'Escape';
    return key;
  };
  const keyCodes: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ControlLeft: 17, AltLeft: 18,
    Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46
  };
  if (options.inputType === 'key' || options.inputType === 'keydown' || options.inputType === 'keyup') {
    const code = options.code || normalizeCode(options.key || '');
    const keyCode = Number.isInteger(options.keyCode) ? options.keyCode!
      : /^[a-z]$/i.test(options.key || '') ? (options.key || '').toUpperCase().charCodeAt(0)
        : /^\d$/.test(options.key || '') ? (options.key || '').charCodeAt(0)
          : keyCodes[code];
    if (!code || !Number.isInteger(keyCode) || keyCode! < 0 || keyCode! > 65535) throw new Error('INPUT_KEY_REQUIRED');
    const keyboard = cc.input._keyboardInput;
    if (!keyboard?.dispatchKeyboardDownEvent || !keyboard?.dispatchKeyboardUpEvent) {
      throw new Error('CREATOR_SIMULATOR_KEYBOARD_INPUT_UNAVAILABLE');
    }
    const event = { code, keyCode, windowId };
    if (options.inputType !== 'keyup') keyboard.dispatchKeyboardDownEvent(event);
    if (options.inputType !== 'keydown') keyboard.dispatchKeyboardUpEvent(event);
    return { dispatched: true, inputType: options.inputType, key: options.key, code, keyCode, windowId };
  }

  if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) throw new Error('INPUT_COORDINATES_REQUIRED');
  const mouse = cc.input._mouseInput;
  if (!mouse?.dispatchMouseDownEvent || !mouse?.dispatchMouseMoveEvent || !mouse?.dispatchMouseUpEvent || !mouse?.dispatchScrollEvent) {
    throw new Error('CREATOR_SIMULATOR_MOUSE_INPUT_UNAVAILABLE');
  }
  const state = globalObject.__cocosAiRuntimeInputState ?? { x: options.x!, y: options.y!, buttons: 0 };
  const x = Math.max(0, Math.min(size.width - 1, options.x!));
  const y = Math.max(0, Math.min(size.height - 1, options.y!));
  const buttons = Number.isInteger(options.buttons) && options.buttons! >= 0 && options.buttons! <= 7 ? options.buttons! : state.buttons;
  const button = Number.isInteger(options.button) && options.button! >= 0 && options.button! <= 2
    ? options.button! : (buttons & 1) ? 0 : (buttons & 4) ? 1 : (buttons & 2) ? 2 : 0;
  const event = {
    x, y, xDelta: x - state.x, yDelta: y - state.y, button, windowId,
    wheelDeltaX: 0, wheelDeltaY: 0
  };
  if (options.inputType === 'tap' || options.inputType === 'click') {
    mouse.dispatchMouseDownEvent(event);
    mouse.dispatchMouseUpEvent(event);
    state.buttons = 0;
  } else if (options.inputType === 'pointerdown') {
    mouse.dispatchMouseDownEvent(event);
    state.buttons = buttons || (button === 0 ? 1 : button === 1 ? 4 : 2);
  } else if (options.inputType === 'pointermove') {
    mouse.dispatchMouseMoveEvent(event);
    state.buttons = buttons;
  } else if (options.inputType === 'pointerup') {
    mouse.dispatchMouseUpEvent(event);
    state.buttons = buttons;
  } else if (options.inputType === 'wheel') {
    if (!Number.isFinite(options.delta) || Math.abs(options.delta!) > 10000) throw new Error('INPUT_WHEEL_DELTA_INVALID');
    event.wheelDeltaY = options.delta! / 120;
    mouse.dispatchScrollEvent(event);
  } else throw new Error(`INPUT_TYPE_UNAVAILABLE:${options.inputType}`);
  state.x = x;
  state.y = y;
  globalObject.__cocosAiRuntimeInputState = state;
  return { dispatched: true, inputType: options.inputType, x, y, button, buttons: state.buttons, windowId };
}

/**
 * 通过 Creator 当前渲染相机投影节点自身四角，返回左上角为原点的画布坐标。
 * 不使用包含后代的世界 AABB；旋转和实际相机视口都由引擎处理。
 *
 * @param options paths 节点路径列表。
 * @returns 逐项命中状态、四角 points、矩形 rect、锚点 anchor 和坐标基准 viewport；无法投影时附原因。
 */
export async function readRuntimeNodeBounds(options: { paths: string[] }): Promise<Record<string, unknown>> {
  const globalObject = globalThis as {
    System?: { import?: (name: string) => Promise<Record<string, unknown>> };
    document?: { getElementById?: (id: string) => { getBoundingClientRect?: () => { width: number; height: number } } | null };
  };
  if (!globalObject.System?.import) return { entries: [] };
  const cc = await globalObject.System.import('cc') as Record<string, any>;
  const scene = cc?.director?.getScene?.();
  if (!scene) return { entries: [] };
  const canvasRect = globalObject.document?.getElementById?.('GameCanvas')?.getBoundingClientRect?.();
  const winSize = cc.screen.windowSize;
  const scaleX = canvasRect && winSize.width > 0 ? canvasRect.width / winSize.width : 1;
  const scaleY = canvasRect && winSize.height > 0 ? canvasRect.height / winSize.height : 1;

  const entries: Array<Record<string, unknown>> = [];
  for (const path of options.paths ?? []) {
    const located = findRuntimeNodeByPath(scene, path);
    if (!located.node) {
      entries.push({ path, found: false });
      continue;
    }
    const node = located.node as Record<string, any>;
    const ui = typeof node.getComponent === 'function' ? node.getComponent(cc.UITransform) : null;
    if (!ui || typeof ui.convertToWorldSpaceAR !== 'function') {
      entries.push({ path, found: true, hasBounds: false, reason: 'ui-transform-unavailable' });
      continue;
    }
    // 与 UITransform.cameraPriority 使用相同的相机选择入口，避免手猜 Canvas 或屏幕中心。
    const camera = cc.director.root?.batcher2D?.getFirstRenderCamera(node);
    if (!camera || typeof camera.worldToScreen !== 'function' || (camera.window && !camera.window.swapchain)) {
      entries.push({ path, found: true, hasBounds: false, reason: 'render-camera-unavailable' });
      continue;
    }
    const project = (world: unknown): { x: number; y: number } => {
      const point = camera.worldToScreen(new cc.Vec3(), world);
      return { x: point.x * scaleX, y: (winSize.height - point.y) * scaleY };
    };
    const left = -ui.anchorX * ui.width;
    const bottom = -ui.anchorY * ui.height;
    const points = [[left, bottom], [left + ui.width, bottom], [left + ui.width, bottom + ui.height], [left, bottom + ui.height]]
      .map(([x, y]) => project(ui.convertToWorldSpaceAR(new cc.Vec3(x, y, 0))));
    if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      entries.push({ path, found: true, hasBounds: false, reason: 'projection-invalid' });
      continue;
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    entries.push({
      path, found: true, hasBounds: true, points,
      rect: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      anchor: project(node.worldPosition),
      viewport: { width: winSize.width * scaleX, height: winSize.height * scaleY },
      size: { width: ui.width, height: ui.height },
      camera: { name: camera.node?.name || '', priority: camera.priority || 0 }
    });
  }
  return { entries };
}

/**
 * 读取当前节点的绝对稳定路径；同名索引以真实兄弟列表为准。
 * @param node 当前运行节点。
 * @returns 含场景根的编码路径。
 */
function readRuntimeNodePath(node: Record<string, any>): string {
  const segments: string[] = [];
  let current: Record<string, any> | null = node;
  while (current) {
    const siblings = Array.isArray(current.parent?.children) ? current.parent.children : [current];
    const index = siblings.filter((sibling: Record<string, any>) => sibling.name === current!.name).indexOf(current);
    segments.unshift(encodeURIComponent(String(current.name || '')) + '~' + Math.max(0, index));
    current = current.parent || null;
  }
  return '/' + segments.join('/');
}

/**
 * 按引擎 PrefabInfo 和 IDGenerator 读取来源；没有实例证据时不沿父节点猜预制体。
 * @param node 当前运行节点。
 * @param scene 当前场景，提供场景资产身份。
 * @returns 来源类别，以及存在时的源资产、文件 ID 和实例根身份。
 */
function readRuntimeNodeOrigin(node: Record<string, any>, scene: Record<string, any>): Record<string, unknown> {
  const prefab = node.prefab || node._prefab;
  const asset = prefab?.asset || prefab?.root?._prefab?.asset;
  const assetUuid = asset?._uuid || asset?.uuid;
  if (typeof assetUuid === 'string' && assetUuid) {
    const root = prefab.root || node;
    return { kind: 'prefab', assetUuid, fileId: String(prefab.fileId || ''), rootUuid: String(root.uuid || ''), rootPath: readRuntimeNodePath(root), instanceRoot: root === node };
  }
  // Creator 3.8.x Node 构造器始终分配 Node.<计数>，因此“存在 _id”不能证明来自场景。
  const id = String(node._id || node.uuid || '');
  if (!id || /^Node\.\d+$/.test(id)) return { kind: 'runtime' };
  return { kind: 'scene', ...(typeof scene.uuid === 'string' ? { assetUuid: scene.uuid } : {}), fileId: id };
}

/**
 * 读取单个运行节点的结构、来源和可视范围，供工作台与 AI 共用。
 * @param options path 为当前会话内的绝对节点路径。
 * @returns 命中状态、节点身份、层级、组件摘要、来源与投影；未命中时返回稳定原因。
 */
export async function readRuntimeNodeDetails(options: { path: string }): Promise<Record<string, unknown>> {
  const globalObject = globalThis as { System?: { import?: (name: string) => Promise<Record<string, any>> } };
  const cc = await globalObject.System?.import?.('cc');
  const scene = cc?.director?.getScene?.();
  if (!scene) return { found: false, reason: 'scene-missing' };
  const located = findRuntimeNodeByPath(scene, options.path);
  if (!located.node) return { found: false, reason: 'node-not-found' };
  const node = located.node as Record<string, any>;
  const path = readRuntimeNodePath(node);
  const layer = Number(node.layer || 0) >>> 0;
  const layerNames = Object.entries(cc!.Layers?.Enum || {}).filter(([, value]) => typeof value === 'number' && value !== 0 && ((value >>> 0) === layer));
  const bounds = await readRuntimeNodeBounds({ paths: [path] }) as { entries: Record<string, unknown>[] };
  const sceneState = readRuntimeSceneState(scene);
  return {
    found: true, nodeUuid: String(node.uuid || ''), name: String(node.name || ''), path,
    parentUuid: node.parent?.uuid || null, active: node.active !== false, activeInHierarchy: node.activeInHierarchy !== false,
    dynamic: !node._id || /^Node\.\d+$/.test(String(node._id)),
    layer, layerName: layerNames[0]?.[0] || '0x' + layer.toString(16),
    depth: path.split('/').filter(Boolean).length - 1,
    siblingIndex: Array.isArray(node.parent?.children) ? Math.max(0, node.parent.children.indexOf(node)) : 0,
    components: (node.components || []).map((component: unknown) => ({ type: readRuntimeComponentType(component) })),
    origin: readRuntimeNodeOrigin(node, scene), bounds: bounds.entries[0], ...sceneState
  };
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
    const constructorName = typeof (record.constructor as { name?: unknown } | undefined)?.name === 'string'
      ? (record.constructor as { name: string }).name
      : '';
    const valueTypeKeys = constructorName === 'Color'
      ? ['r', 'g', 'b', 'a']
      : constructorName === 'Vec2'
        ? ['x', 'y']
        : constructorName === 'Vec3'
          ? ['x', 'y', 'z']
          : constructorName === 'Vec4' || constructorName === 'Quat'
            ? ['x', 'y', 'z', 'w']
            : constructorName === 'Size'
              ? ['width', 'height']
              : constructorName === 'Rect'
                ? ['x', 'y', 'width', 'height']
                : [];
    const keys = [...new Set([
      ...Object.keys(record),
      ...valueTypeKeys
    ])].filter((key) => key !== 'constructor' && !key.startsWith('__') && !key.startsWith('_'));
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
 * 采集原生 Inspector 所需的值和类身份；引用只传身份，声明对象不执行构造器。
 *
 * @param value 运行时字段值。
 * @param runtimeModule 当前运行进程的 cc 模块，用于识别资源、组件、节点和注册类。
 * @param depth 当前递归深度，最多六层。
 * @param seen 当前对象链，用于拒绝循环展开。
 * @returns 可送回 Creator 原生 Dump 的有界、带类型数据。
 */
function serializeRuntimeInspectorValue(value: any, runtimeModule: Record<string, any>, depth: number, seen: Set<unknown>): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return serializeRuntimeValue(value, depth, seen);
  const className = runtimeModule.js?.getClassName(value) || value.constructor?.name || '';
  const isNode = runtimeModule.Node ? value instanceof runtimeModule.Node : typeof value.uuid === 'string' && Array.isArray(value.children);
  const isComponent = runtimeModule.Component && value instanceof runtimeModule.Component;
  const isAsset = runtimeModule.Asset && value instanceof runtimeModule.Asset;
  if (isNode || isComponent || isAsset) return {
    __type: isNode ? 'node-reference' : isComponent ? 'component-reference' : 'asset-reference',
    className, uuid: value.uuid || value._uuid || '', name: value.name || '',
    ...(isComponent && value.node ? { node: serializeRuntimeInspectorValue(value.node, runtimeModule, depth + 1, seen) } : {})
  };
  if (seen.has(value)) return { __type: 'circular-reference' };
  if (depth > 6) return { __type: 'max-depth-exceeded' };
  seen.add(value);
  if (Array.isArray(value)) {
    // ponytail: 单数组最多展开 50 项并保留总数；需要浏览大数组时再增加分页。
    const result = value.slice(0, 50).map((item) => serializeRuntimeInspectorValue(item, runtimeModule, depth + 1, seen));
    if (value.length > 50) result.push({ __type: 'truncated', total: value.length });
    seen.delete(value);
    return result;
  }
  const declared = value.constructor?.__props__;
  const keys = Array.isArray(declared) && declared.length ? declared : Object.keys(value);
  const properties: Record<string, unknown> = {};
  for (const key of keys) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    try {
      if (typeof value[key] !== 'function' && value[key] !== undefined) properties[key] = serializeRuntimeInspectorValue(value[key], runtimeModule, depth + 1, seen);
    } catch {
      properties[key] = { __type: 'unavailable' };
    }
  }
  // 原生事件编辑器通过组件 ID 显示类名；component 是旧格式字段，运行时通常为空。
  if (className === 'cc.ClickEvent' && !properties.component && value._componentId) {
    const targetClass = runtimeModule.js?.getClassById?.(value._componentId);
    if (targetClass) properties.component = runtimeModule.js.getClassName(targetClass);
  }
  seen.delete(value);
  return className && !['Object', 'object'].includes(className)
    ? { __type: 'inspector-object', className, properties }
    : properties;
}

/** 收集公开 own/prototype 属性，覆盖 Cocos 组件的 getter/setter。 */
function listRuntimeProperties(value: unknown): string[] {
  const properties = new Set<string>();
  const root = value;
  let cursor = value as Record<string, unknown> | null;
  while (cursor && cursor !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(cursor)) {
      if (key === 'constructor' || key.startsWith('_') || key.startsWith('__')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (!descriptor) continue;
      if (typeof descriptor.value === 'function' && !descriptor.get && !descriptor.set && cursor !== root) continue;
      properties.add(key);
    }
    cursor = Object.getPrototypeOf(cursor) as Record<string, unknown> | null;
  }
  return [...properties];
}

/**
 * 读取运行时组件类的公开属性元数据。
 *
 * @param component 当前运行时组件实例。
 * @param runtimeModule 当前页面导入的 cc 模块。
 * @returns Cocos 类属性数组、属性表和构造器；取不到时返回空结构。
 */
function readRuntimeInspectorClassInfo(
  component: unknown,
  runtimeModule?: Record<string, unknown>
): { constructor: Record<string, unknown> | null; props: string[]; attrs: Record<string, unknown> | null } {
  const constructor = (component as { constructor?: unknown } | null)?.constructor;
  if (typeof constructor !== 'function') return { constructor: null, props: [], attrs: null };

  const ctor = constructor as unknown as Record<string, unknown>;
  let attrs = ctor.__attrs__;
  if (!attrs) {
    try {
      const cclegacy = runtimeModule?.cclegacy as Record<string, unknown> | undefined;
      const classApi = cclegacy?.Class as Record<string, unknown> | undefined;
      const attrApi = classApi?.Attr as Record<string, unknown> | undefined;
      const getClassAttrs = attrApi?.getClassAttrs;
      if (typeof getClassAttrs === 'function') attrs = getClassAttrs(constructor);
    } catch {
      attrs = undefined;
    }
  }

  const props = Array.isArray(ctor.__props__)
    ? ctor.__props__.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    constructor: ctor,
    props,
    attrs: attrs && typeof attrs === 'object' && !Array.isArray(attrs)
      ? attrs as Record<string, unknown>
      : null
  };
}

/**
 * 读取并解析 Cocos 类属性上的 Inspector 元数据。
 *
 * @param classInfo 当前组件构造器的属性信息。
 * @param property 当前属性名。
 * @param attribute 要读取的元数据字段。
 * @param component 当前组件实例，用于执行动态 visible/min/max 函数。
 * @returns 解析后的元数据值；读取失败时返回 undefined。
 */
function readRuntimeInspectorAttribute(
  classInfo: { attrs: Record<string, unknown> | null },
  property: string,
  attribute: string,
  component: unknown
): unknown {
  const attrs = classInfo.attrs;
  if (!attrs) return undefined;
  const value = attrs[`${property}$_$${attribute}`];
  if (typeof value !== 'function' || attribute === 'type') return value;
  try {
    return value.call(component);
  } catch {
    return undefined;
  }
}

/** 读取可能是构造器或字符串的 Cocos 属性类型名称。 */
function readRuntimeInspectorTypeName(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'function' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  return undefined;
}

/** 把 Cocos Enum.getList 结果压缩成可直接供前端 select 使用的选项。 */
function readRuntimeInspectorEnumOptions(value: unknown): Array<{ name: string; value: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: Array<{ name: string; value: number }> = [];
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === 'number' && typeof item[1] === 'string') {
      options.push({ value: item[0], name: item[1] });
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as { name?: unknown; value?: unknown };
      if (typeof record.name === 'string' && typeof record.value === 'number' && Number.isFinite(record.value)) {
        options.push({ value: record.value, name: record.name });
      }
    }
  }
  return options.length > 0 ? options : undefined;
}

/** 运行时资源字段名称；即使当前为空也应保留为只读引用槽位。 */
function isRuntimeInspectorReferenceName(property: string): boolean {
  return [
    'target', 'spriteFrame', 'spriteAtlas', 'font', 'labelAtlas',
    'normalSprite', 'pressedSprite', 'hoverSprite', 'disabledSprite', 'hoverSpriteFrame',
    'customMaterial', 'material', 'sharedMaterial', 'texture', 'clip', 'prefab'
  ].includes(property);
}

/** 判断组件类型是否明显属于 Creator 内建组件，避免误隐藏其运行时 getter。 */
function isRuntimeInspectorBuiltInComponent(componentType: string): boolean {
  if (/^(cc\.|sp\.|dragonBones\.)/.test(componentType)) return true;
  return [
    'Node', 'UITransform', 'UIOpacity', 'Widget', 'Canvas', 'Sprite', 'Label', 'RichText',
    'Button', 'Toggle', 'ToggleContainer', 'Layout', 'Mask', 'ScrollView', 'PageView',
    'EditBox', 'Slider', 'ProgressBar', 'Camera', 'Graphics', 'MeshRenderer', 'ParticleSystem'
  ].includes(componentType);
}

/** 判断属性表中是否存在某个属性的任意 Inspector 元数据。 */
function hasRuntimeInspectorAttribute(classInfo: { attrs: Record<string, unknown> | null }, property: string): boolean {
  if (!classInfo.attrs) return false;
  const prefix = `${property}$_$`;
  return Object.keys(classInfo.attrs).some((key) => key.startsWith(prefix));
}

/** 内建组件缺少 attrs 时，仍优先展示 Creator 专门提供的 Inspector 代理属性。 */
function hasRuntimeInspectorProxy(component: unknown, property: string): boolean {
  return !property.endsWith('ForInspector')
    && Boolean(findRuntimePropertyDescriptor(component, `${property}ForInspector`));
}

/**
 * 生成单个运行时属性的 Inspector 描述，统一处理可见性、类型和可写状态。
 *
 * @param component 当前运行时组件实例。
 * @param componentType 当前组件类型名。
 * @param property 属性名。
 * @param value 属性原始值。
 * @param serialized 已序列化的属性值。
 * @param runtimeModule 当前页面导入的 cc 模块。
 * @returns 前端可直接消费的属性元数据。
 */
function readRuntimeInspectorPropertyMeta(
  component: unknown,
  componentType: string,
  property: string,
  value: unknown,
  serialized: unknown,
  runtimeModule?: Record<string, unknown>
): Record<string, unknown> {
  const classInfo = readRuntimeInspectorClassInfo(component, runtimeModule);
  const attrs = classInfo.attrs;
  const descriptor = findRuntimePropertyDescriptor(component, property);
  const descriptorWritable = Boolean(
    descriptor && (typeof descriptor.set === 'function' || descriptor.writable === true)
  );
  const declaredTypeValue = readRuntimeInspectorAttribute(classInfo, property, 'type', component);
  const declaredType = readRuntimeInspectorTypeName(declaredTypeValue);
  const ctorValue = attrs?.[`${property}$_$ctor`];
  const ctorName = readRuntimeInspectorTypeName(ctorValue);
  const inspectorType = declaredType && declaredType !== 'Object'
    ? declaredType
    : ctorName || declaredType;
  const visibleValue = readRuntimeInspectorAttribute(classInfo, property, 'visible', component);
  const readonlyValue = readRuntimeInspectorAttribute(classInfo, property, 'readonly', component) === true;
  const hasSetter = readRuntimeInspectorAttribute(classInfo, property, 'hasSetter', component) === true;
  const enumOptions = readRuntimeInspectorEnumOptions(
    readRuntimeInspectorAttribute(classInfo, property, 'enumList', component)
  );
  const marker = serialized && typeof serialized === 'object' && !Array.isArray(serialized)
    ? (serialized as { __type?: unknown }).__type
    : undefined;
  const reference = marker === 'node-reference'
    || marker === 'component-reference'
    || marker === 'asset-reference'
    || isRuntimeInspectorReferenceName(property)
    || ['Node', 'Component', 'Asset', 'SpriteFrame', 'Prefab'].some((name) => (inspectorType || '').includes(name));

  let kind = 'unknown';
  if (enumOptions || declaredType === 'Enum') kind = 'enum';
  else if (marker === 'circular-reference' || marker === 'max-depth-exceeded' || marker === 'complex-object'
    || marker === 'truncated' || marker === 'function' || marker === 'promise') kind = String(marker);
  else if (reference) kind = 'reference';
  else if (value === undefined) kind = 'undefined';
  else if (value === null) kind = 'null';
  else if (Array.isArray(value)) kind = 'array';
  else if (typeof value === 'boolean') kind = 'boolean';
  else if (typeof value === 'number') kind = Number.isFinite(value) ? 'number' : 'non-finite-number';
  else if (typeof value === 'string') kind = 'string';
  else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const numeric = (keys: string[]): boolean => keys.every((key) => typeof object[key] === 'number' && Number.isFinite(object[key] as number));
    if (numeric(['r', 'g', 'b', 'a'])) kind = 'color';
    else if (numeric(['width', 'height']) && (Object.prototype.hasOwnProperty.call(object, 'x') || Object.prototype.hasOwnProperty.call(object, 'y'))) kind = 'rect';
    else if (numeric(['width', 'height'])) kind = 'size';
    else if (numeric(['x', 'y', 'z', 'w'])) kind = 'vector';
    else if (numeric(['x', 'y', 'z'])) kind = 'vector';
    else if (numeric(['x', 'y'])) kind = 'vector';
    else kind = 'object';
  }

  const hiddenNames = [
    'constructor', 'node', 'name', 'uuid', 'enabledInHierarchy', 'isValid', 'hideFlags',
    'renderData', 'materials', 'sharedMaterials', 'renderEntity', 'batchingHint', 'visibility',
    'cameraPriority', 'alignFlags', 'hash', 'localMat', 'batcher', 'sharedMaterial', 'material',
    'stencilStage', 'srcBlendFactor', 'useVertexOpacity', 'isStretchWidth', 'isStretchHeight'
  ];
  const readonlyEventHandlerArray = kind === 'array'
    && /(?:Component)?EventHandler/.test(inspectorType || '');
  const isCustom = !isRuntimeInspectorBuiltInComponent(componentType);
  const propertyDeclared = classInfo.props.includes(property)
    || hasRuntimeInspectorAttribute(classInfo, property);
  const declared = !isCustom
    || property === 'enabled'
    || property === 'node'
    || propertyDeclared;
  let visible = !hiddenNames.includes(property)
    && !hasRuntimeInspectorProxy(component, property)
    && declared
    && (visibleValue !== false || readonlyEventHandlerArray);
  if (componentType.replace(/^cc\./, '') === 'Sprite' && property === 'priority') visible = false;
  if (componentType.replace(/^cc\./, '') === 'Sprite') {
    const spriteType = (component as { type?: unknown } | null)?.type;
    if (property === 'trim' && spriteType !== 0) visible = false;
    if (['fillType', 'fillCenter', 'fillStart', 'fillRange'].includes(property) && spriteType !== 3) visible = false;
  }
  let readOnlyReason: string | undefined;
  if (kind === 'undefined' || kind === 'non-finite-number' || kind === 'function' || kind === 'object'
    || kind === 'circular-reference' || kind === 'max-depth-exceeded' || kind === 'complex-object'
    || kind === 'promise') {
    visible = false;
  }
  if (kind === 'null' && !reference) visible = false;
  if (kind === 'truncated') visible = false;

  const editableKind = ['boolean', 'number', 'string', 'enum', 'color', 'vector', 'size', 'rect'].includes(kind);
  let editable = visible && editableKind && !readonlyValue && (descriptorWritable || hasSetter);
  if (!visible) readOnlyReason = 'hidden';
  else if (readonlyValue || (!descriptorWritable && !hasSetter)) readOnlyReason = 'property-read-only';
  else if (kind === 'reference' || kind === 'null') readOnlyReason = 'runtime-reference';
  else if (kind === 'array') readOnlyReason = 'array-not-editable';
  else if (!editableKind) readOnlyReason = 'unsupported-value';
  if (kind === 'non-finite-number') readOnlyReason = 'invalid-number';
  if (!editable) editable = false;

  const metadata: Record<string, unknown> = {
    kind,
    editable,
    visible,
    declared
  };
  if (readOnlyReason) metadata.readOnlyReason = readOnlyReason;
  if (inspectorType) metadata.declaredType = inspectorType;
  const displayName = readRuntimeInspectorAttribute(classInfo, property, 'displayName', component);
  if (typeof displayName === 'string' && displayName) metadata.displayName = displayName;
  const tooltip = readRuntimeInspectorAttribute(classInfo, property, 'tooltip', component);
  if (typeof tooltip === 'string' && tooltip) metadata.tooltip = tooltip;
  const group = readRuntimeInspectorAttribute(classInfo, property, 'group', component);
  if (typeof group === 'string' && group) metadata.group = group;
  else if (group && typeof group === 'object' && typeof (group as { name?: unknown }).name === 'string') {
    metadata.group = (group as { name: string }).name;
  }
  const displayOrder = readRuntimeInspectorAttribute(classInfo, property, 'displayOrder', component);
  if (typeof displayOrder === 'number' && Number.isFinite(displayOrder)) metadata.displayOrder = displayOrder;
  for (const attribute of ['min', 'max', 'step']) {
    const number = readRuntimeInspectorAttribute(classInfo, property, attribute, component);
    if (typeof number === 'number' && Number.isFinite(number)) metadata[attribute] = number;
  }
  if (enumOptions) metadata.enumOptions = enumOptions;
  return metadata;
}

/** 运行时树的轻量稳定哈希；用于 UI/AI 判断 revision 是否变化。 */
function hashRuntimeText(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function readRuntimeSceneState(scene: Record<string, unknown>): { sceneEpoch: number; revision: number; sceneUuid?: string } {
  const globalObject = globalThis as Record<string, unknown>;
  const sceneUuid = typeof scene.uuid === 'string' && scene.uuid ? scene.uuid : undefined;
  const identity = `${sceneUuid ?? ''}:${typeof scene.name === 'string' ? scene.name : ''}`;
  const key = '__cocosAiRuntimeSceneState__';
  const previous = globalObject[key] as { identity?: string; epoch?: number } | undefined;
  const sceneEpoch = previous?.identity === identity ? (previous.epoch ?? 1) : (previous?.epoch ?? 0) + 1;
  globalObject[key] = { identity, epoch: sceneEpoch };

  const signature = (node: Record<string, unknown>): string => {
    const components = Array.isArray(node.components)
      ? node.components.map((component) => readRuntimeComponentType(component)).join(',')
      : '';
    const children = Array.isArray(node.children)
      ? node.children.map((child) => signature(child as Record<string, unknown>)).join('|')
      : '';
    return `${typeof node.uuid === 'string' ? node.uuid : ''}:${typeof node.name === 'string' ? node.name : ''}:${node.active !== false}:${components}[${children}]`;
  };
  return {
    sceneEpoch,
    revision: hashRuntimeText(signature(scene)),
    ...(sceneUuid ? { sceneUuid } : {})
  };
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
  const sceneState = readRuntimeSceneState(scene);

  // 指定路径时从目标节点开始序列化；未命中沿用组件定位的候选子节点证据。
  let root = scene;
  if (typeof options.path === 'string' && options.path) {
    const located = findRuntimeNodeByPath(scene, options.path, options.includeInactive !== false);
    if (!located.node) {
      const parent = located.failedAtParent;
      const siblings = parent && Array.isArray(parent.children)
        ? (parent.children as Array<Record<string, unknown>>)
          .map((child) => (typeof child.name === 'string' ? child.name : ''))
        : [];
      return { found: false, reason: 'node-not-found', ...(located.inactive ? { inactive: true } : {}), availableChildren: siblings };
    }
    root = located.node;
  }
  if (options.includeInactive === false && root.active === false) {
    return { found: false, reason: 'node-not-found', inactive: true, availableChildren: [] };
  }

  const maxDepth = typeof options.maxDepth === 'number' && options.maxDepth > 0 ? Math.floor(options.maxDepth) : 8;
  const includeInactive = options.includeInactive !== false;
  const state = {
    nodeCount: 0,
    truncated: false,
    maxNodes: typeof options.maxNodes === 'number' && options.maxNodes > 0 ? Math.floor(options.maxNodes) : 2_000
  };

  const serializeNode = (
    node: Record<string, unknown>,
    depth: number,
    path: string,
    parentUuid?: string
  ): Record<string, unknown> => {
    state.nodeCount += 1;
    const result: Record<string, unknown> = {
      uuid: typeof node.uuid === 'string' ? node.uuid : '',
      name: typeof node.name === 'string' ? node.name : '',
      path,
      ...(parentUuid ? { parentUuid } : {}),
      active: node.active !== false,
      activeInHierarchy: node.activeInHierarchy !== false,
      dynamic: !node._id || /^Node\.\d+$/.test(String(node._id)),
      origin: readRuntimeNodeOrigin(node, scene),
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
      const childName = typeof child.name === 'string' ? child.name : '';
      const sameNameIndex = children
        .slice(0, children.indexOf(child))
        .filter((sibling) => sibling.name === childName).length;
      const childPath = `${path}/${encodeURIComponent(childName)}~${sameNameIndex}`;
      serializedChildren.push(serializeNode(
        child,
        depth + 1,
        childPath,
        typeof node.uuid === 'string' ? node.uuid : undefined
      ));
    }
    if (serializedChildren.length > 0) result.children = serializedChildren;
    return result;
  };

  const rootName = typeof root.name === 'string' ? root.name : '';
  const tree = serializeNode(root, 1, `/${encodeURIComponent(rootName)}~0`);
  tree.sceneUuid = sceneState.sceneUuid;
  tree.sceneEpoch = sceneState.sceneEpoch;
  tree.revision = sceneState.revision;
  tree.nodeCount = state.nodeCount;
  if (state.truncated) tree.truncated = true;
  return tree;
}

/** 读取兼容旧名称路径与 `/url-encoded-name~same-name-index` 稳定路径的段。 */
function parseRuntimePathSegment(segment: string): { name: string; sameNameIndex: number } {
  const matched = /^(.*)~(\d+)$/.exec(segment);
  const encodedName = matched?.[1] ?? segment;
  const sameNameIndex = matched ? Number(matched[2]) : 0;
  try {
    return { name: decodeURIComponent(encodedName), sameNameIndex };
  } catch {
    return { name: encodedName, sameNameIndex };
  }
}

/** 按 `/` 分隔的名称/稳定路径查找节点；首段与场景名相同则跳过。 */
function findRuntimeNodeByPath(
  scene: Record<string, unknown>,
  path: string,
  includeInactive = true
): { node?: Record<string, unknown>; failedAtParent?: Record<string, unknown>; inactive?: boolean } {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  let current = scene;
  const first = segments[0] ? parseRuntimePathSegment(segments[0]) : undefined;
  let index = first && first.name === (scene.name as string) && first.sameNameIndex === 0 ? 1 : 0;
  for (; index < segments.length; index += 1) {
    const segment = parseRuntimePathSegment(segments[index]);
    const children = Array.isArray(current.children) ? current.children as Array<Record<string, unknown>> : [];
    const matches = children.filter((child) => child.name === segment.name);
    const next = matches[segment.sameNameIndex] ?? (segment.sameNameIndex === 0 ? matches[0] : undefined);
    if (!next) return { failedAtParent: current };
    if (!includeInactive && (current.active === false || next.active === false)) {
      return { failedAtParent: current, inactive: true };
    }
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
  let component = options.componentType === 'cc.Node'
    ? node
    : components.find((item) => readRuntimeComponentType(item) === options.componentType) as Record<string, unknown> | undefined;
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
    runtimeModule: cc,
    actualComponentType,
    nodeUuid: typeof node.uuid === 'string' ? node.uuid : ''
  };
}

/**
 * 按节点路径与组件类型读取运行时组件属性包。
 *
 * @param options path 为节点路径；componentType 为组件类型或 cc.Node；inspectorProperties 为 Creator 原生指定的采集字段。
 * @returns found、节点身份、属性值；原生采集同时返回 writable，普通读取保留 propertyMeta。
 */
async function readRuntimeComponent(options: { path: string; componentType: string; inspectorProperties?: string[] }): Promise<Record<string, unknown>> {
  const located = await locateRuntimeComponent(options);
  if (located.found !== true) return located;
  const component = located.component as Record<string, unknown>;

  const skipped: string[] = [];
  const seen = new Set<unknown>([component]);
  const properties: Record<string, unknown> = {};
  const propertyMeta: Record<string, Record<string, unknown>> = {};
  const writable: Record<string, boolean> = {};
  let inspectorClassName = located.actualComponentType;
  if (options.inspectorProperties) {
    const js = (located.runtimeModule as Record<string, any>).js;
    // 未加 @ccclass 的运行时子类不在 Creator 注册表中；使用实际已注册的祖先声明。
    for (let ctor = component.constructor; typeof ctor === 'function' && ctor !== Function.prototype; ctor = Object.getPrototypeOf(ctor)) {
      const name = js?.getClassName(ctor);
      if (name && (!js.getClassByName || js.getClassByName(name) === ctor)) { inspectorClassName = name; break; }
    }
  }
  for (const key of options.inspectorProperties ?? listRuntimeProperties(component)) {
    if (['constructor', 'prototype', '__proto__'].includes(key)) continue;
    if (!options.inspectorProperties && key.startsWith('__')) continue;
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
    if (options.inspectorProperties) {
      if (value === undefined) { skipped.push(key); continue; }
      properties[key] = serializeRuntimeInspectorValue(value, located.runtimeModule as Record<string, any>, 1, seen);
      const descriptor = findRuntimePropertyDescriptor(component, key);
      writable[key] = Boolean(descriptor?.set || descriptor?.writable);
      continue;
    }
    const serialized = serializeRuntimeValue(value, 1, seen);
    properties[key] = serialized;
    propertyMeta[key] = readRuntimeInspectorPropertyMeta(
      component,
      located.actualComponentType as string,
      key,
      value,
      serialized,
      located.runtimeModule as Record<string, unknown> | undefined
    );
  }
  return {
    found: true,
    nodeUuid: located.nodeUuid,
    componentType: located.actualComponentType,
    properties,
    propertyMeta,
    ...(options.inspectorProperties ? {
      writable,
      inspectorClassName: options.componentType === 'cc.Node' ? 'cc.Node' : inspectorClassName,
      showEnabled: ['start', 'update', 'lateUpdate', 'onEnable', 'onDisable'].some((name) => typeof component[name] === 'function')
    } : {}),
    skipped
  };
}

/** 校验 invoke 参数 JSON 安全：拒绝函数/undefined/Symbol/bigint 与携带 __type 标记的对象。 */
function isRuntimeArgsSafe(value: unknown, depth: number): boolean {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === 'number') return Number.isFinite(value);
  if (valueType === 'string' || valueType === 'boolean') return true;
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
 * @param options.awaitResult 是否等待 Promise 返回值；采样触发器传 false 以免错过过渡窗口。
 * @returns invoked 调用标记、序列化返回值或失败原因。
 */
function invokeLocatedRuntimeMethod(
  located: Record<string, unknown>,
  options: { method: string; args?: unknown[]; awaitResult?: boolean }
): Record<string, unknown> | Promise<Record<string, unknown>> {
  // 生命周期与危险方法黑名单（内联字面量：模块级常量在打包脚本作用域中不存在）。
  const blocklist = [
    'onLoad', 'start', 'update', 'lateUpdate', 'onEnable', 'onDisable', 'onDestroy',
    'onFocusInEditor', 'onLostFocusInEditor', 'resetInEditor',
    'eval', 'Function', 'constructor'
  ];
  if (blocklist.includes(options.method)
    || options.method === '__proto__'
    || Object.prototype.hasOwnProperty.call(Object.prototype, options.method)) {
    return { invoked: false, method: options.method, reason: 'method-not-allowed' };
  }
  const args = Array.isArray(options.args) ? options.args : [];
  if (!args.every((arg) => isRuntimeArgsSafe(arg, 1))) {
    return { invoked: false, method: options.method, reason: 'invalid-args' };
  }
  const component = located.component as Record<string, unknown>;
  let method: unknown;
  let cursor = component as Record<string, unknown> | null;
  while (cursor && cursor !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, options.method);
    if (descriptor) {
      method = descriptor.value;
      break;
    }
    cursor = Object.getPrototypeOf(cursor) as Record<string, unknown> | null;
  }
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
    const returnValue = (method as (...rest: unknown[]) => unknown).apply(component, args);
    const buildSuccess = (value: unknown): Record<string, unknown> => ({
      found: true,
      invoked: true,
      method: options.method,
      nodeUuid: located.nodeUuid,
      componentType: located.actualComponentType,
      returnValue: serializeRuntimeValue(value, 1, new Set())
    });
    const buildFailure = (error: unknown): Record<string, unknown> => ({
      found: true,
      invoked: false,
      method: options.method,
      reason: 'method-threw',
      nodeUuid: located.nodeUuid,
      error: error instanceof Error ? error.message : String(error)
    });
    const then = returnValue && typeof returnValue === 'object'
      ? (returnValue as { then?: unknown }).then
      : undefined;
    if (typeof then === 'function') {
      if (options.awaitResult !== false) {
        return Promise.resolve(returnValue).then(buildSuccess, buildFailure);
      }

      // 采样不能等待异步 trigger，否则短过渡会在第一帧采样前结束。
      const pendingResult: Record<string, unknown> = {
        ...buildSuccess({ __type: 'promise' }),
        pending: true
      };
      Promise.resolve(returnValue).then(
        (value) => {
          pendingResult.pending = false;
          pendingResult.returnValue = serializeRuntimeValue(value, 1, new Set());
        },
        (error) => {
          Object.assign(pendingResult, buildFailure(error), { pending: false });
          delete pendingResult.returnValue;
        }
      );
      return pendingResult;
    }
    return buildSuccess(returnValue);
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
  return await invokeLocatedRuntimeMethod(located, { method: options.method, args: options.args ?? [] });
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
    const invocationResult = invokeLocatedRuntimeMethod(located, {
      method: options.trigger.method,
      args: options.trigger.args ?? [],
      awaitResult: false
    });
    triggerResult = invocationResult instanceof Promise ? await invocationResult : invocationResult;
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
    clearTimeout?: (handle: unknown) => void;
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
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let watchdogHandle: unknown;
    const finish = (watchdog: boolean): void => {
      if (settled) return;
      settled = true;
      timedOut = watchdog;
      if (watchdogHandle !== undefined && typeof globalObject.clearTimeout === 'function') {
        globalObject.clearTimeout(watchdogHandle);
      }
      resolve();
    };
    const tick = (): void => {
      if (settled) return;
      if (capture()) {
        finish(false);
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
    // rAF may be paused in a background tab; keep the outer request from hanging forever.
    if (options.mode === 'perFrame'
      && typeof globalObject.requestAnimationFrame === 'function'
      && typeof globalObject.setTimeout === 'function') {
      watchdogHandle = globalObject.setTimeout(() => {
        if (!settled) {
          capture();
          finish(true);
        }
      }, options.durationMs);
    }
    schedule();
  });

  return {
    found: true,
    nodeUuid: located.nodeUuid,
    componentType: located.actualComponentType,
    mode: options.mode,
    durationMs: options.durationMs,
    samples,
    ...(timedOut ? { timedOut: true } : {}),
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

function isWritableRuntimePropertyPath(property: string): boolean {
  const segments = property.split('.').filter((segment) => segment.length > 0);
  return segments.length > 0 && segments.every((segment) => (
    !segment.startsWith('_')
    && segment !== '__proto__'
    && segment !== 'prototype'
    && segment !== 'constructor'
  ));
}

function findRuntimePropertyDescriptor(target: unknown, key: string): PropertyDescriptor | undefined {
  let cursor = target as object | null;
  while (cursor && cursor !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) return descriptor;
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return undefined;
}

/**
 * 写入公开标量或 Cocos 值类型并立即回读；引用、数组及内部路径保持只读。
 *
 * @param options path 为节点路径；componentType 为组件或 cc.Node；property 为公开属性路径；value 为待写入的 JSON 值。
 * @returns 写入标记、实际回读值与 revision；拒绝或失败时返回明确原因。
 */
async function writeRuntimeProperty(options: {
  path: string;
  componentType: string;
  property: string;
  value: unknown;
}): Promise<Record<string, unknown>> {
  const located = await locateRuntimeComponent({ path: options.path, componentType: options.componentType });
  if (located.found !== true) return located;
  if (!isWritableRuntimePropertyPath(options.property) || !isRuntimeArgsSafe(options.value, 1)) {
    return { found: false, reason: 'property-write-not-allowed', nodeUuid: located.nodeUuid, property: options.property };
  }
  const segments = options.property.split('.').filter((segment) => segment.length > 0);
  const component = located.component as Record<string, unknown>;
  const runtimeModule = located.runtimeModule as Record<string, any>;
  const referenceValue = (value: unknown): boolean => Array.isArray(value)
    || [runtimeModule.Node, runtimeModule.Component, runtimeModule.Asset].some((ctor) => typeof ctor === 'function' && value instanceof ctor);
  let owner: Record<string, unknown> = component;
  for (const segment of segments.slice(0, -1)) {
    const next = owner[segment];
    if (next === null || typeof next !== 'object') {
      return { found: false, reason: 'property-parent-not-found', nodeUuid: located.nodeUuid, property: options.property };
    }
    if (referenceValue(next)) return { found: false, reason: 'reference-read-only', nodeUuid: located.nodeUuid, property: options.property };
    owner = next as Record<string, unknown>;
  }
  const key = segments[segments.length - 1];
  if (referenceValue(owner[key])) return { found: false, reason: 'reference-read-only', nodeUuid: located.nodeUuid, property: options.property };
  const attrs = readRuntimeInspectorClassInfo(owner, runtimeModule).attrs;
  const declaredCtor = attrs?.[`${key}$_$ctor`] as any;
  const declaredReference = typeof declaredCtor === 'function'
    && [runtimeModule.Node, runtimeModule.Component, runtimeModule.Asset].some((base) => typeof base === 'function' && (declaredCtor === base || declaredCtor.prototype instanceof base));
  if (declaredReference || Array.isArray(attrs?.[`${key}$_$default`])) {
    return { found: false, reason: 'reference-read-only', nodeUuid: located.nodeUuid, property: options.property };
  }
  const descriptor = findRuntimePropertyDescriptor(owner, key);
  if (descriptor && descriptor.set === undefined && descriptor.writable === false) {
    return { found: false, reason: 'property-read-only', nodeUuid: located.nodeUuid, property: options.property };
  }
  try {
    let nextValue = options.value;
    const previous = owner[key] as any;
    if (runtimeModule.ValueType && previous instanceof runtimeModule.ValueType) {
      const type = String(runtimeModule.js?.getClassName(previous) || previous.constructor.name).replace(/^cc\./, '');
      const fields: Record<string, string[]> = { Vec2: ['x', 'y'], Vec3: ['x', 'y', 'z'], Vec4: ['x', 'y', 'z', 'w'], Color: ['r', 'g', 'b', 'a'], Size: ['width', 'height'], Rect: ['x', 'y', 'width', 'height'] };
      const keys = fields[type];
      const value = options.value as Record<string, unknown>;
      if (!keys || !value || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
        return { found: false, reason: 'value-type-invalid', nodeUuid: located.nodeUuid, property: options.property };
      }
      // 原生 ValueType 保留类身份；普通 JSON 覆盖会破坏自定义组件后续的 clone/set 等调用。
      nextValue = Object.assign(previous.clone(), value);
    }
    owner[key] = nextValue;
    const readback = owner[key];
    const globalObject = globalThis as {
      System?: { import?: (name: string) => Promise<Record<string, unknown>> };
    };
    const scene = (await globalObject.System!.import!('cc') as {
      director?: { getScene?: () => Record<string, unknown> | null };
    }).director?.getScene?.();
    const sceneState = scene ? readRuntimeSceneState(scene) : undefined;
    return {
      found: true,
      written: true,
      nodeUuid: located.nodeUuid,
      componentType: located.actualComponentType,
      property: options.property,
      value: serializeRuntimeValue(options.value, 1, new Set()),
      readback: serializeRuntimeValue(readback, 1, new Set([component])),
      ...(sceneState ? { revision: sceneState.revision } : {})
    };
  } catch (error) {
    return {
      found: true,
      written: false,
      nodeUuid: located.nodeUuid,
      componentType: located.actualComponentType,
      property: options.property,
      reason: 'property-write-failed',
      error: error instanceof Error ? error.message : String(error)
    };
  }
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
  serializeRuntimeInspectorValue,
  listRuntimeProperties,
  readRuntimeInspectorClassInfo,
  readRuntimeInspectorAttribute,
  readRuntimeInspectorTypeName,
  readRuntimeInspectorEnumOptions,
  isRuntimeInspectorReferenceName,
  isRuntimeInspectorBuiltInComponent,
  hasRuntimeInspectorAttribute,
  hasRuntimeInspectorProxy,
  readRuntimeInspectorPropertyMeta,
  hashRuntimeText,
  readRuntimeSceneState,
  readRuntimeHierarchy,
  parseRuntimePathSegment,
  findRuntimeNodeByPath,
  readRuntimeComponent,
  locateRuntimeComponent,
  isRuntimeArgsSafe,
  listRuntimeMethods,
  invokeLocatedRuntimeMethod,
  invokeRuntimeComponentMethod,
  sampleRuntimeWindow,
  readRuntimeProperty,
  isWritableRuntimePropertyPath,
  findRuntimePropertyDescriptor,
  writeRuntimeProperty,
  readCanvasRect,
  dispatchRuntimeInput,
  readRuntimeNodeBounds,
  readRuntimeNodePath,
  readRuntimeNodeOrigin,
  readRuntimeNodeDetails,
  instantiateRuntimePrefab
];
