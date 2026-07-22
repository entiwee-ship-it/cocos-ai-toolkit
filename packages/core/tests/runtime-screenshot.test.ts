import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { buildRuntimeScript } from '../src/runtime-inject.js';
import { RuntimeDriver, type RuntimeBrowserPage } from '../src/runtime-driver.js';
import { decodePng } from '../src/runtime-capture.js';

/** 在 Node 侧执行拼接后的注入脚本。 */
async function runScript(entry: string, ...args: unknown[]): Promise<unknown> {
  const script = buildRuntimeScript(entry, ...args);
  return eval(script);
}

/** 构造纯色 PNG。 */
function createSolidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    png.data[index * 4] = rgba[0];
    png.data[index * 4 + 1] = rgba[1];
    png.data[index * 4 + 2] = rgba[2];
    png.data[index * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

function readPixel(buffer: Buffer, x: number, y: number): [number, number, number, number] {
  const decoded = decodePng(buffer);
  const offset = (y * decoded.width + x) * 4;
  return [decoded.data[offset], decoded.data[offset + 1], decoded.data[offset + 2], decoded.data[offset + 3]];
}

/** 安装带 UITransform/相机的假引擎环境。 */
function installFake2DScene() {
  const uitransform = {
    __typename__: 'UITransform',
    getBoundingBoxToWorld: () => ({ x: 100, y: 50, width: 200, height: 100 })
  };
  const button = {
    name: 'btn',
    uuid: 'uuid-btn',
    _id: 'f2',
    active: true,
    worldPosition: { x: 100, y: 50, z: 0 },
    children: [],
    components: [uitransform],
    getComponent: (type: unknown) => type === fakeCc.UITransform ? uitransform : null
  };
  const scene = {
    name: 'Canvas',
    uuid: 'uuid-canvas',
    _id: 'f1',
    active: true,
    children: [button],
    components: []
  };
  const fakeCc = {
    UITransform: class {},
    director: { getScene: () => scene },
    screen: { windowSize: { width: 960, height: 640 } }
  };
  vi.stubGlobal('System', { import: async () => fakeCc });
  vi.stubGlobal('document', {
    getElementById: () => ({
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 640 })
    })
  });
  return { scene, button, uitransform };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readRuntimeNodeBounds（页面注入：节点边界与锚点）', () => {
  it('世界坐标换算为画布 CSS 像素边界与锚点', async () => {
    installFake2DScene();
    const result = await runScript('readRuntimeNodeBounds', { paths: ['Canvas/btn'] }) as {
      entries: Array<{ path: string; found: boolean; rect?: { x: number; y: number; width: number; height: number }; anchor?: { x: number; y: number } }>;
    };
    expect(result.entries).toHaveLength(1);
    // winW/2=480, winH/2=320；rect(100,50,200,100) 世界左下 → css: x=580, y=640-(50+100+320)=170
    expect(result.entries[0]).toMatchObject({
      path: 'Canvas/btn',
      found: true,
      rect: { x: 580, y: 170, width: 200, height: 100 },
      anchor: { x: 580, y: 270 }
    });
  });

  it('路径未命中时返回 found:false', async () => {
    installFake2DScene();
    const result = await runScript('readRuntimeNodeBounds', { paths: ['Canvas/missing'] }) as {
      entries: Array<{ path: string; found: boolean }>;
    };
    expect(result.entries[0].found).toBe(false);
  });
});

/** 构造带截图能力的 fake page。 */
function createCapturablePage(options: { screenshot?: Buffer } = {}) {
  const shot = options.screenshot ?? createSolidPng(960, 640, [10, 10, 10, 255]);
  const state = {
    closed: false,
    viewport: null as null | { width: number; height: number },
    screenshots: 0,
    evaluateCalls: [] as string[]
  };
  const page: RuntimeBrowserPage = {
    async goto() {},
    async evaluate(fn: unknown) {
      const script = typeof fn === 'string' ? fn : '';
      state.evaluateCalls.push(script.slice(-120));
      if (script.includes('return readRuntimeNodeBounds')) {
        return {
          entries: [{ path: 'Canvas/btn', found: true, hasBounds: true, rect: { x: 580, y: 170, width: 200, height: 100 }, anchor: { x: 580, y: 270 } }]
        } as never;
      }
      if (script.includes('return setRuntimeResolution')) {
        return { width: 720, height: 826 } as never;
      }
      return { ready: true, sceneName: 'main', childCount: 1, width: 960, height: 640 } as never;
    },
    onConsole() {},
    onPageError() {},
    async close() { state.closed = true; },
    isClosed() { return state.closed; },
    async mouseClick() {},
    async keyPress() {},
    async setViewportSize(size: { width: number; height: number }) {
      state.viewport = size;
    },
    async screenshotElement(selector: string) {
      state.screenshots += 1;
      if (selector !== '#GameCanvas') throw new Error('unexpected selector');
      return shot;
    }
  };
  return { page, state };
}

describe('RuntimeDriver.capture（截图管线）', () => {
  it('默认截取 GameCanvas 并返回图像与生效分辨率', async () => {
    const { page, state } = createCapturablePage();
    const driver = new RuntimeDriver({
      launcher: async () => ({ newPage: async () => page, close: async () => {} }),
      createSessionId: () => 'cap-1'
    });
    await driver.launch({ projectId: 'p1', url: 'http://192.168.1.23:7457/' });
    const result = await driver.capture('cap-1', {});
    expect(state.screenshots).toBe(1);
    expect(decodePng(result.buffer)).toMatchObject({ width: 960, height: 640 });
    expect(result.actualResolution).toEqual({ width: 960, height: 640 });
    await driver.dispose();
  });

  it('指定分辨率时先放大视口再设置并回传实际生效值', async () => {
    const { page, state } = createCapturablePage();
    const driver = new RuntimeDriver({
      launcher: async () => ({ newPage: async () => page, close: async () => {} }),
      createSessionId: () => 'cap-2'
    });
    await driver.launch({ projectId: 'p1', url: 'http://192.168.1.23:7457/' });
    const result = await driver.capture('cap-2', { resolution: { width: 720, height: 1280 } });
    expect(state.viewport).toEqual({ width: 920, height: 1480 });
    expect(result.actualResolution).toEqual({ width: 720, height: 826 });
    await driver.dispose();
  });

  it('裁剪在叠加之前生效', async () => {
    const { page } = createCapturablePage();
    const driver = new RuntimeDriver({
      launcher: async () => ({ newPage: async () => page, close: async () => {} }),
      createSessionId: () => 'cap-3'
    });
    await driver.launch({ projectId: 'p1', url: 'http://192.168.1.23:7457/' });
    const result = await driver.capture('cap-3', {
      crop: { x: 500, y: 100, width: 300, height: 300 },
      overlay: { nodeBounds: ['Canvas/btn'] }
    });
    const decoded = decodePng(result.buffer);
    expect(decoded).toMatchObject({ width: 300, height: 300 });
    // 边界 rect(580,170,200,100) 经裁剪偏移 (-500,-100) → (80,70)；左上角应为红色
    expect(readPixel(result.buffer, 80, 70)).toEqual([255, 0, 0, 255]);
    await driver.dispose();
  });

  it('锚点叠加绘制绿色十字', async () => {
    const { page } = createCapturablePage();
    const driver = new RuntimeDriver({
      launcher: async () => ({ newPage: async () => page, close: async () => {} }),
      createSessionId: () => 'cap-4'
    });
    await driver.launch({ projectId: 'p1', url: 'http://192.168.1.23:7457/' });
    const result = await driver.capture('cap-4', { overlay: { anchors: ['Canvas/btn'] } });
    expect(readPixel(result.buffer, 580, 270)).toEqual([0, 255, 0, 255]);
    await driver.dispose();
  });
});
