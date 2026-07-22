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
