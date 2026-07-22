import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntimeScript, readCanvasRect } from '../src/runtime-inject.js';

/** 在 Node 侧执行拼接后的注入脚本。 */
async function runScript(entry: string, ...args: unknown[]): Promise<unknown> {
  const script = buildRuntimeScript(entry, ...args);
  return eval(script);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readCanvasRect（页面注入：画布区域读取）', () => {
  it('返回 GameCanvas 的包围盒', async () => {
    vi.stubGlobal('document', {
      getElementById: (id: string) => id === 'GameCanvas'
        ? { getBoundingClientRect: () => ({ left: 10, top: 20, width: 960, height: 640 }) }
        : null
    });
    const rect = await readCanvasRect();
    expect(rect).toEqual({ x: 10, y: 20, width: 960, height: 640 });
  });

  it('画布缺失时返回 null', async () => {
    vi.stubGlobal('document', { getElementById: () => null });
    expect(await readCanvasRect()).toBeNull();
  });

  it('经打包脚本执行保持自包含', async () => {
    vi.stubGlobal('document', {
      getElementById: () => ({ getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }) })
    });
    const rect = await runScript('readCanvasRect');
    expect(rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('dispatchRuntimeInput（driver 输入换算与派发）', () => {
  it('tap 按画布偏移换算页面坐标并点击', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const { RuntimeDriver } = await import('../src/runtime-driver.js');
    const page = {
      gotoUrls: [] as string[],
      closed: false,
      async goto(url: string) { this.gotoUrls.push(url); },
      async evaluate(fn: unknown) {
        const script = typeof fn === 'string' ? fn : '';
        if (script.includes('return readCanvasRect')) {
          return { x: 100, y: 50, width: 960, height: 640 } as never;
        }
        return { ready: true, sceneName: 'main', childCount: 1, width: 960, height: 640 } as never;
      },
      onConsole() {},
      onPageError() {},
      async close() { this.closed = true; },
      isClosed() { return this.closed; },
      async mouseClick(x: number, y: number) { clicks.push({ x, y }); },
      async keyPress() {}
    };
    const driver = new RuntimeDriver({
      launcher: async () => ({ newPage: async () => page, close: async () => {} }),
      createSessionId: () => 's-input'
    });
    await driver.launch({ projectId: 'p1', url: 'http://192.168.1.23:7457/' });
    const receipt = await driver.dispatchInput('s-input', { inputType: 'tap', x: 480, y: 320 });
    expect(clicks).toEqual([{ x: 580, y: 370 }]);
    expect(receipt).toMatchObject({ dispatched: true, x: 480, y: 320, pageX: 580, pageY: 370 });
    await driver.dispose();
  });

  it('key 直接派发按键', async () => {
    const keys: string[] = [];
    const { RuntimeDriver } = await import('../src/runtime-driver.js');
    const page = {
      closed: false,
      async goto() {},
      async evaluate() { return { ready: true, sceneName: 'main', childCount: 1, width: 960, height: 640 } as never; },
      onConsole() {},
      onPageError() {},
      async close() { this.closed = true; },
      isClosed() { return this.closed; },
      async mouseClick() {},
      async keyPress(key: string) { keys.push(key); }
    };
    const driver = new RuntimeDriver({
      launcher: async () => ({ newPage: async () => page, close: async () => {} }),
      createSessionId: () => 's-key'
    });
    await driver.launch({ projectId: 'p1', url: 'http://192.168.1.23:7457/' });
    const receipt = await driver.dispatchInput('s-key', { inputType: 'key', key: 'Enter' });
    expect(keys).toEqual(['Enter']);
    expect(receipt).toMatchObject({ dispatched: true, key: 'Enter' });
    await driver.dispose();
  });

  it('tap 缺坐标与画布缺失时拒绝', async () => {
    const { RuntimeDriver } = await import('../src/runtime-driver.js');
    const page = {
      closed: false,
      async goto() {},
      async evaluate(fn: unknown) {
        const script = typeof fn === 'string' ? fn : '';
        if (script.includes('return readCanvasRect')) return null as never;
        return { ready: true, sceneName: 'main', childCount: 1, width: 960, height: 640 } as never;
      },
      onConsole() {},
      onPageError() {},
      async close() { this.closed = true; },
      isClosed() { return this.closed; },
      async mouseClick() {},
      async keyPress() {}
    };
    const driver = new RuntimeDriver({
      launcher: async () => ({ newPage: async () => page, close: async () => {} }),
      createSessionId: () => 's-bad'
    });
    await driver.launch({ projectId: 'p1', url: 'http://192.168.1.23:7457/' });
    await expect(driver.dispatchInput('s-bad', { inputType: 'tap' })).rejects.toThrow('INPUT_COORDINATES_REQUIRED');
    await expect(driver.dispatchInput('s-bad', { inputType: 'tap', x: 1, y: 1 })).rejects.toThrow('GAME_CANVAS_NOT_FOUND');
    await driver.dispose();
  });
});
