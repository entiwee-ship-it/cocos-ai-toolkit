import Module from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeEditorState } from '../src/editor-state';
import { methods } from '../src/main';

const originalEditorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Editor');
const originalCceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cce');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEditorDescriptor) {
    Object.defineProperty(globalThis, 'Editor', originalEditorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'Editor');
  }
  if (originalCceDescriptor) {
    Object.defineProperty(globalThis, 'cce', originalCceDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'cce');
  }
});

/** 装配主进程编辑器状态探针所需的最小 Editor 全局 mock。 */
function installEditorMock(requestEditorMessage: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(globalThis, 'Editor', {
    configurable: true,
    value: {
      Message: { request: requestEditorMessage },
      Selection: { getSelected: () => [] },
      App: { version: '3.8.8' },
      Project: { path: 'E:/project-a', uuid: 'project-a' }
    }
  });
}

/** 主进程公开消息探针的标准应答；Scene 转发与 preview 查询由调用方补充。 */
function routeEditorStateMessages(
  overrides: (channel: string, method: string) => unknown
): (channel: string, method: string) => Promise<unknown> {
  return async (channel: string, method: string) => {
    if (channel === 'asset-db' && method === 'query-ready') return true;
    if (channel === 'scene' && method === 'query-is-ready') return true;
    if (channel === 'scene' && method === 'query-dirty') return false;
    if (channel === 'preview') return null;
    return overrides(channel, method);
  };
}

describe('editor state document identity', () => {
  it('Scene 进程经 cce.SceneFacadeManager 返回当前文档身份', async () => {
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
    Object.defineProperty(globalThis, 'cce', {
      configurable: true,
      value: {
        SceneFacadeManager: {
          queryCurrentSceneUuid: () => 'scene-uuid-1',
          queryMode: () => 'scene'
        }
      }
    });

    try {
      vi.resetModules();
      const { methods: sceneMethods } = await import('../src/scene');
      const identity = await sceneMethods.editorStateDocumentIdentity() as Record<string, unknown>;

      expect(identity).toMatchObject({
        assetUuid: 'scene-uuid-1',
        mode: 'scene',
        source: 'cce.SceneFacadeManager',
        failures: []
      });
    } finally {
      moduleLoader._load = originalLoad;
      vi.resetModules();
    }
  });

  it('probeEditorState 拿到身份时填充 document.assetUuid 并附 mode/source', async () => {
    const requestEditorMessage = vi.fn(routeEditorStateMessages(() => {
      throw new Error('UNEXPECTED_SCENE_FORWARD');
    }));
    installEditorMock(requestEditorMessage);

    const state = await probeEditorState({
      assetUuid: 'scene-uuid-1',
      mode: 'scene',
      source: 'cce.SceneFacadeManager',
      failures: []
    }) as {
      document: Record<string, unknown>;
      unresolved: Array<{ path: string; reason: string }>;
    };

    expect(state.document).toMatchObject({
      assetUuid: 'scene-uuid-1',
      dirty: false,
      mode: 'scene',
      source: 'cce.SceneFacadeManager'
    });
    expect(state.unresolved).not.toContainEqual({
      path: 'document.assetUuid',
      reason: 'CURRENT_DOCUMENT_UUID_EMPTY'
    });
  });

  it('身份读取失败时保留具体失败原因，而不是只返回通用 UUID 错误', async () => {
    const requestEditorMessage = vi.fn(routeEditorStateMessages(() => {
      throw new Error('UNEXPECTED_SCENE_FORWARD');
    }));
    installEditorMock(requestEditorMessage);

    const state = await probeEditorState({
      assetUuid: 'scene-uuid-1',
      mode: null,
      source: 'cce.SceneFacadeManager',
      failures: [{ source: 'cce.SceneFacadeManager.queryMode', reason: 'MODE_QUERY_FAILED' }]
    }) as {
      document: Record<string, unknown>;
      unresolved: Array<{ path: string; reason: string }>;
    };

    expect(state.document.assetUuid).toBe('scene-uuid-1');
    expect(state.unresolved).toContainEqual({
      path: 'document.mode',
      reason: 'MODE_QUERY_FAILED'
    });
    expect(state.unresolved).not.toContainEqual({
      path: 'document.assetUuid',
      reason: 'CURRENT_DOCUMENT_UUID_EMPTY'
    });
  });

  it('probeEditorState 拿不到身份时不伪造 assetUuid，只保留 unresolved 证据', async () => {
    const requestEditorMessage = vi.fn(routeEditorStateMessages(() => {
      throw new Error('UNEXPECTED_SCENE_FORWARD');
    }));
    installEditorMock(requestEditorMessage);

    const state = await probeEditorState() as {
      document: Record<string, unknown>;
      unresolved: Array<{ path: string; reason: string }>;
    };

    expect(state.document.assetUuid).toBeNull();
    expect(state.document).not.toHaveProperty('mode');
    expect(state.unresolved).toContainEqual({
      path: 'document.assetUuid',
      reason: 'CURRENT_DOCUMENT_UUID_EMPTY'
    });
  });

  it('主进程 probe-editor-state 组合公开探针与 Scene 文档身份', async () => {
    const requestEditorMessage = vi.fn(routeEditorStateMessages((channel, method) => {
      if (channel === 'scene' && method === 'execute-scene-script') {
        return {
          assetUuid: 'scene-uuid-1',
          mode: 'scene',
          source: 'cce.SceneFacadeManager',
          failures: []
        };
      }
      throw new Error(`UNEXPECTED_EDITOR_MESSAGE:${channel}:${method}`);
    }));
    installEditorMock(requestEditorMessage);

    const state = await methods['probe-editor-state']({}) as {
      creatorVersion: string;
      projectPath: string;
      projectId: string;
      document: Record<string, unknown>;
      unresolved: Array<{ path: string; reason: string }>;
    };

    expect(state).toMatchObject({
      creatorVersion: '3.8.8',
      projectPath: 'E:/project-a',
      projectId: 'project-a'
    });
    expect(state.document).toMatchObject({
      assetUuid: 'scene-uuid-1',
      dirty: false,
      mode: 'scene',
      source: 'cce.SceneFacadeManager'
    });
    expect(state.unresolved).not.toContainEqual({
      path: 'document.assetUuid',
      reason: 'CURRENT_DOCUMENT_UUID_EMPTY'
    });
    expect(requestEditorMessage).toHaveBeenCalledWith('scene', 'execute-scene-script', {
      name: 'cocos-ai-bridge',
      method: 'editorStateDocumentIdentity',
      args: [{}]
    });
  });

  it('Scene 身份转发失败时保留 unresolved 证据而不拖死整个状态探针', async () => {
    const requestEditorMessage = vi.fn(routeEditorStateMessages((channel, method) => {
      if (channel === 'scene' && method === 'execute-scene-script') {
        throw new Error('SCENE_SCRIPT_UNAVAILABLE');
      }
      throw new Error(`UNEXPECTED_EDITOR_MESSAGE:${channel}:${method}`);
    }));
    installEditorMock(requestEditorMessage);

    const state = await methods['probe-editor-state']({}) as {
      document: Record<string, unknown>;
      ready: { scene: boolean; assetDatabase: boolean };
      unresolved: Array<{ path: string; reason: string }>;
    };

    expect(state.ready).toEqual({ scene: true, assetDatabase: true });
    expect(state.document.assetUuid).toBeNull();
    expect(state.document).not.toHaveProperty('mode');
    expect(state.unresolved).toContainEqual({
      path: 'document.assetUuid',
      reason: 'SCENE_SCRIPT_UNAVAILABLE'
    });
  });
});
