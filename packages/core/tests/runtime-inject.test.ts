import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeGameReady, readRuntimeResolution, setRuntimeResolution } from '../src/runtime-inject.js';

/** 构造挂载假 cc 引擎的页面全局对象。 */
function installFakeGlobals(options: {
  scene?: { name: string; children: unknown[] } | null;
  windowSize?: { width: number; height: number };
  appliedWindowSize?: { width: number; height: number };
} = {}) {
  const dispatchedEvents: Array<{ type: string }> = [];
  const fakeCc = {
    director: {
      getScene: () => options.scene === undefined
        ? { name: 'main', children: [{}] }
        : options.scene
    },
    screen: {
      get windowSize() {
        return fakeCc._applied ? (options.appliedWindowSize ?? options.windowSize) : options.windowSize;
      },
      set windowSize(value) {
        fakeCc._applied = true;
        options.appliedWindowSize = options.appliedWindowSize ?? value;
      }
    },
    Size: class {
      constructor(public width: number, public height: number) {}
    },
    _applied: false
  };
  vi.stubGlobal('System', {
    import: async (name: string) => {
      if (name !== 'cc') throw new Error(`unexpected import ${name}`);
      return fakeCc;
    }
  });
  vi.stubGlobal('dispatchEvent', (event: { type: string }) => {
    dispatchedEvents.push(event);
    return true;
  });
  vi.stubGlobal('Event', class {
    constructor(public type: string) {}
  });
  return { fakeCc, dispatchedEvents };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeGameReady（页面注入：游戏就绪探测）', () => {
  it('场景存在时返回就绪与场景摘要', async () => {
    installFakeGlobals({ scene: { name: 'phase2-probe', children: [{}, {}] } });
    const result = await probeGameReady();
    expect(result).toMatchObject({ ready: true, sceneName: 'phase2-probe', childCount: 2 });
  });

  it('场景为空时返回未就绪', async () => {
    installFakeGlobals({ scene: null });
    const result = await probeGameReady();
    expect(result.ready).toBe(false);
  });

  it('System 缺失时返回未就绪而非抛错', async () => {
    vi.stubGlobal('System', undefined);
    const result = await probeGameReady();
    expect(result.ready).toBe(false);
  });
});

describe('setRuntimeResolution / readRuntimeResolution（页面注入：分辨率）', () => {
  it('设置分辨率并派发 resize，返回实际生效值', async () => {
    const { dispatchedEvents } = installFakeGlobals({
      windowSize: { width: 960, height: 640 },
      appliedWindowSize: { width: 720, height: 826 }
    });
    const actual = await setRuntimeResolution({ width: 720, height: 1280 });
    expect(actual).toEqual({ width: 720, height: 826 });
    expect(dispatchedEvents.map((event) => event.type)).toEqual(['resize']);
  });

  it('读取当前实际分辨率', async () => {
    installFakeGlobals({ windowSize: { width: 852, height: 393 } });
    const actual = await readRuntimeResolution();
    expect(actual).toEqual({ width: 852, height: 393 });
  });
});

describe('注入函数自包含性（toString 序列化后无模块作用域依赖）', () => {
  it('probeGameReady 序列化重建后仍可执行', async () => {
    installFakeGlobals();
    const revived = eval(`(${probeGameReady.toString()})`) as typeof probeGameReady;
    const result = await revived();
    expect(result.ready).toBe(true);
  });

  it('setRuntimeResolution 序列化重建后仍可执行', async () => {
    installFakeGlobals({ appliedWindowSize: { width: 720, height: 826 } });
    const revived = eval(`(${setRuntimeResolution.toString()})`) as typeof setRuntimeResolution;
    const actual = await revived({ width: 720, height: 1280 });
    expect(actual).toEqual({ width: 720, height: 826 });
  });

  it('readRuntimeResolution 序列化重建后仍可执行', async () => {
    installFakeGlobals({ windowSize: { width: 960, height: 640 } });
    const revived = eval(`(${readRuntimeResolution.toString()})`) as typeof readRuntimeResolution;
    const actual = await revived();
    expect(actual).toEqual({ width: 960, height: 640 });
  });
});
