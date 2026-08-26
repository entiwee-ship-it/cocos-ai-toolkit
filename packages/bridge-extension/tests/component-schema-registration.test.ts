import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CAPABILITIES } from '../src/bridge-state';
import { methods } from '../src/main';

const originalEditorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Editor');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEditorDescriptor) {
    Object.defineProperty(globalThis, 'Editor', originalEditorDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, 'Editor');
});

describe('component schema registration', () => {
  it('主进程先读取脚本索引，再把组件请求和 UUID 路径映射转发到 Scene', () => {
    const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const sceneSource = readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');

    expect(BRIDGE_CAPABILITIES).toContain('probe.component');
    expect(mainSource).toContain("'probe.component': (payload) => probeComponent(payload)");
    expect(mainSource).toContain("'probe-component': (request) => probeComponent(request)");
    expect(mainSource).toContain("forwardToScene('probeComponent', {");
    expect(mainSource).toContain('scriptPathsByUuid');
    expect(mainSource).toContain('readScriptPathsBestEffort');
    expect(sceneSource).toContain("const componentRequest = 'request' in input ? input.request : input;");
    expect(sceneSource).toContain('normalizeComponentDump(raw, scriptPathsByUuid)');
  });

  it.each([
    {
      message: 'probe-component',
      sceneMethod: 'probeComponent',
      request: { uuid: 'component-1' }
    }
  ])('AssetDB 脚本索引失败时仍继续执行 $message 主查询', async ({
    message,
    sceneMethod,
    request
  }) => {
    const requestEditorMessage = vi.fn(async (channel: string, method: string) => {
      if (channel === 'asset-db' && method === 'query-assets') {
        throw new Error('ASSET_DB_UNAVAILABLE');
      }
      if (channel === 'scene' && method === 'execute-scene-script') {
        return { forwarded: true };
      }
      throw new Error(`UNEXPECTED_EDITOR_MESSAGE:${channel}:${method}`);
    });
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request: requestEditorMessage } }
    });

    await expect(methods[message](request)).resolves.toEqual({ forwarded: true });
    expect(requestEditorMessage).toHaveBeenNthCalledWith(
      1,
      'asset-db',
      'query-assets',
      undefined,
      expect.any(Array)
    );
    expect(requestEditorMessage).toHaveBeenNthCalledWith(
      2,
      'scene',
      'execute-scene-script',
      {
        name: 'cocos-ai-bridge',
        method: sceneMethod,
        args: [{ request, scriptPathsByUuid: [] }]
      }
    );
  });

  it('首次资产索引后复用脚本 UUID 映射，不为每个文档重复全目录查询', async () => {
    const requestEditorMessage = vi.fn(async (channel: string, method: string) => {
      if (channel === 'asset-db' && method === 'query-assets') {
        return [{
          uuid: 'script-1',
          url: 'db://assets/script/GameController.ts',
          file: 'E:/project/assets/script/GameController.ts',
          type: 'cc.Script',
          importer: 'typescript',
          isSubAsset: false
        }];
      }
      if (channel === 'scene' && method === 'execute-scene-script') {
        return { forwarded: true };
      }
      throw new Error(`UNEXPECTED_EDITOR_MESSAGE:${channel}:${method}`);
    });
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request: requestEditorMessage } }
    });

    vi.resetModules();
    const { methods: freshMethods } = await import('../src/main');
    await freshMethods['probe-asset-index']({});
    await expect(freshMethods['probe-component']({ uuid: 'component-1' })).resolves.toEqual({ forwarded: true });
    await expect(freshMethods['probe-component']({ uuid: 'component-2' })).resolves.toEqual({ forwarded: true });

    expect(requestEditorMessage.mock.calls.filter((call) =>
      call[0] === 'asset-db' && call[1] === 'query-assets'
    )).toHaveLength(1);
    expect(requestEditorMessage).toHaveBeenLastCalledWith(
      'scene',
      'execute-scene-script',
      {
        name: 'cocos-ai-bridge',
        method: 'probeComponent',
        args: [{
          request: { uuid: 'component-2' },
          scriptPathsByUuid: [['script-1', 'db://assets/script/GameController.ts']]
        }]
      }
    );
    vi.resetModules();
  });

  it('Scene 进程通过真实 query-component 读取组件并应用脚本 UUID 路径', async () => {
    const moduleLoader = Module as unknown as {
      _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function loadModule(request, parent, isMain) {
      if (request === 'cc') {
        return { director: { getScene: () => ({}) } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const raw = {
      value: {
        uuid: { value: 'component-1' },
        __scriptAsset: { type: 'cc.Script', value: { uuid: 'script-1' }, extends: ['cc.Asset'] }
      },
      type: 'GameController',
      cid: 'game-controller-cid',
      extends: ['cc.Component', 'cc.Object']
    };
    const requestEditorMessage = vi.fn(async () => raw);
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request: requestEditorMessage } }
    });

    try {
      vi.resetModules();
      const { methods: sceneMethods } = await import('../src/scene');
      const result = await sceneMethods.probeComponent({
        request: { uuid: 'component-1' },
        scriptPathsByUuid: [['script-1', 'db://assets/script/GameController.ts']]
      }) as {
        data: { class: { scriptPath: string | null } };
        raw: unknown;
        source: string;
      };

      expect(requestEditorMessage).toHaveBeenCalledWith(
        'scene',
        'query-component',
        'component-1'
      );
      expect(result).toMatchObject({
        data: { class: { scriptPath: 'db://assets/script/GameController.ts' } },
        raw,
        source: 'message-api'
      });
    } finally {
      moduleLoader._load = originalLoad;
      vi.resetModules();
    }
  });
});
