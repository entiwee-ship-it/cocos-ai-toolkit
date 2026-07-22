import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntimeScript } from '../src/runtime-inject.js';
import { watchRuntimeProperty } from '../src/runtime-interact.js';

/** 在 Node 侧执行拼接后的注入脚本。 */
async function runScript(entry: string, ...args: unknown[]): Promise<unknown> {
  const script = buildRuntimeScript(entry, ...args);
  return eval(script);
}

/** 构造带方法的假组件节点树。 */
function installSceneWithComponent(component: Record<string, unknown>) {
  const node = {
    name: 'panel',
    uuid: 'uuid-panel',
    _id: 'f2',
    active: true,
    children: [],
    components: [component],
    getComponent: () => component
  };
  const scene = {
    name: 'Canvas',
    uuid: 'uuid-canvas',
    _id: 'f1',
    active: true,
    children: [node],
    components: []
  };
  vi.stubGlobal('System', {
    import: async () => ({ director: { getScene: () => scene } })
  });
  return { scene, node, component };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('invokeRuntimeComponentMethod（页面注入：方法调用）', () => {
  it('调用组件方法并回传序列化返回值', async () => {
    installSceneWithComponent({
      __typename__: 'GameLogic',
      count: 1,
      add(a: number, b: number) {
        this.count = (this.count as number) + a + b;
        return this.count;
      }
    });
    const result = await runScript('invokeRuntimeComponentMethod', {
      path: 'Canvas/panel',
      componentType: 'GameLogic',
      method: 'add',
      args: [2, 3]
    }) as { found: boolean; invoked?: boolean; returnValue?: unknown };
    expect(result).toMatchObject({ found: true, invoked: true, returnValue: 6 });
  });

  it('拒绝生命周期与危险方法', async () => {
    installSceneWithComponent({
      __typename__: 'GameLogic',
      update() {},
      eval() {}
    });
    for (const method of ['onLoad', 'start', 'update', 'lateUpdate', 'onEnable', 'onDisable', 'onDestroy', 'eval', 'Function', 'constructor']) {
      const result = await runScript('invokeRuntimeComponentMethod', {
        path: 'Canvas/panel',
        componentType: 'GameLogic',
        method,
        args: []
      }) as { invoked?: boolean; reason?: string };
      expect(result.invoked, `方法 ${method} 应被拒绝`).not.toBe(true);
      expect(result.reason).toBe('method-not-allowed');
    }
  });

  it('方法不存在时返回可用方法清单', async () => {
    installSceneWithComponent({
      __typename__: 'GameLogic',
      play() {},
      stop() {}
    });
    const result = await runScript('invokeRuntimeComponentMethod', {
      path: 'Canvas/panel',
      componentType: 'GameLogic',
      method: 'missing',
      args: []
    }) as { found: boolean; reason?: string; availableMethods?: string[] };
    expect(result.found).toBe(false);
    expect(result.reason).toBe('method-not-found');
    expect(result.availableMethods).toEqual(expect.arrayContaining(['play', 'stop']));
  });

  it('拒绝非 JSON 安全的参数', async () => {
    installSceneWithComponent({
      __typename__: 'GameLogic',
      run() { return 1; }
    });
    const result = await runScript('invokeRuntimeComponentMethod', {
      path: 'Canvas/panel',
      componentType: 'GameLogic',
      method: 'run',
      args: [{ __type: 'function' }]
    }) as { invoked?: boolean; reason?: string };
    expect(result.invoked).not.toBe(true);
    expect(result.reason).toBe('invalid-args');
  });
});

describe('readRuntimeProperty（页面注入：属性读取）', () => {
  it('读取组件属性并序列化', async () => {
    installSceneWithComponent({
      __typename__: 'GameLogic',
      state: { hp: 100, pos: { x: 1, y: 2 } }
    });
    const result = await runScript('readRuntimeProperty', {
      path: 'Canvas/panel',
      componentType: 'GameLogic',
      property: 'state'
    }) as { found: boolean; value?: unknown };
    expect(result.found).toBe(true);
    expect(result.value).toEqual({ hp: 100, pos: { x: 1, y: 2 } });
  });

  it('支持点路径读取嵌套属性', async () => {
    installSceneWithComponent({
      __typename__: 'GameLogic',
      state: { hp: 100 }
    });
    const result = await runScript('readRuntimeProperty', {
      path: 'Canvas/panel',
      componentType: 'GameLogic',
      property: 'state.hp'
    }) as { found: boolean; value?: unknown };
    expect(result.value).toBe(100);
  });
});

describe('watchRuntimeProperty（core：属性监听轮询）', () => {
  it('值变化时立即返回变化记录', async () => {
    const values = [1, 1, 2, 3];
    let index = 0;
    const read = async () => values[Math.min(index++, values.length - 1)];
    const result = await watchRuntimeProperty(read, { intervalMs: 1, timeoutMs: 1_000 });
    expect(result.timedOut).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ from: 1, to: 2 });
  });

  it('值恒定时返回超时与初始值', async () => {
    const read = async () => 'stable';
    const result = await watchRuntimeProperty(read, { intervalMs: 1, timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.initialValue).toBe('stable');
  });

  it('maxChanges 大于一时收集多个变化直至超时', async () => {
    const values = [0, 1, 2, 3, 4];
    let index = 0;
    const read = async () => values[Math.min(index++, values.length - 1)];
    const result = await watchRuntimeProperty(read, { intervalMs: 1, timeoutMs: 50, maxChanges: 3 });
    expect(result.changes.length).toBeGreaterThanOrEqual(3);
    expect(result.changes[0]).toMatchObject({ from: 0, to: 1 });
    expect(result.changes[1]).toMatchObject({ from: 1, to: 2 });
  });

  it('深比较判定变化（对象内容相同不算变化）', async () => {
    const values = [{ a: 1 }, { a: 1 }, { a: 2 }];
    let index = 0;
    const read = async () => values[Math.min(index++, values.length - 1)];
    const result = await watchRuntimeProperty(read, { intervalMs: 1, timeoutMs: 1_000 });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ from: { a: 1 }, to: { a: 2 } });
  });
});
