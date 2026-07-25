import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeNodeSnapshotSchema } from '@cocos-ai/protocol';
import { assembleRuntimeNodeSnapshot } from '../src/runtime-read.js';
import { buildRuntimeScript } from '../src/runtime-inject.js';

/** 在 Node 侧执行拼接后的注入脚本（验证自包含性与逻辑）。 */
async function runScript(entry: string, ...args: unknown[]): Promise<unknown> {
  const script = buildRuntimeScript(entry, ...args);
  return eval(script);
}

/** 构造假 cc 节点。 */
function fakeNode(options: {
  name: string;
  uuid?: string;
  fileId?: string;
  active?: boolean;
  components?: Array<{ type: string; props?: Record<string, unknown> }>;
  children?: Array<ReturnType<typeof fakeNode>>;
}) {
  const node: Record<string, unknown> = {
    name: options.name,
    uuid: options.uuid ?? `uuid-${options.name}`,
    _id: options.fileId ?? '',
    active: options.active ?? true,
    children: options.children ?? [],
    components: (options.components ?? []).map((component) => ({
      constructor: { name: component.type },
      __typename__: component.type,
      ...(component.props ?? {})
    })),
    getComponent(type: string) {
      return (node.components as Array<Record<string, unknown>>).find((component) => component.__typename__ === type) ?? null;
    }
  };
  return node;
}

function installScene(root: ReturnType<typeof fakeNode> | null) {
  vi.stubGlobal('System', {
    import: async () => ({
      director: { getScene: () => root }
    })
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildRuntimeScript', () => {
  it('拼接后的脚本自包含且函数间可调用', async () => {
    installScene(fakeNode({ name: 'Scene', fileId: 'scene-file', children: [] }));
    const result = await runScript('readRuntimeHierarchy', { maxDepth: 4 });
    expect(result).toMatchObject({ name: 'Scene', dynamic: false });
  });
});

describe('readRuntimeHierarchy（页面注入：层级序列化）', () => {
  it('序列化节点树并标注动态创建节点', async () => {
    installScene(fakeNode({
      name: 'Scene',
      fileId: 'scene-file',
      components: [{ type: 'cc.Scene' }],
      children: [
        fakeNode({
          name: 'Canvas',
          fileId: 'canvas-file',
          components: [{ type: 'cc.Canvas' }, { type: 'cc.UITransform' }],
          children: [
            fakeNode({ name: 'toast', active: false, components: [{ type: 'cc.Label' }] })
          ]
        })
      ]
    }));
    const tree = await runScript('readRuntimeHierarchy', {}) as Record<string, unknown>;
    expect(tree).toMatchObject({
      name: 'Scene',
      dynamic: false,
      components: [{ type: 'cc.Scene' }],
      children: [{
        name: 'Canvas',
        dynamic: false,
        components: [{ type: 'cc.Canvas' }, { type: 'cc.UITransform' }],
        children: [{ name: 'toast', active: false, dynamic: true }]
      }]
    });
  });

  it('按 maxDepth 截断并标注', async () => {
    installScene(fakeNode({
      name: 'a',
      fileId: 'f1',
      children: [fakeNode({ name: 'b', fileId: 'f2', children: [fakeNode({ name: 'c', fileId: 'f3' })] })]
    }));
    const tree = await runScript('readRuntimeHierarchy', { maxDepth: 2 }) as {
      children: Array<{ children?: unknown[]; truncated?: boolean }>;
    };
    expect(tree.children[0].children).toBeUndefined();
    expect(tree.children[0].truncated).toBe(true);
  });

  it('按 maxNodes 限制节点总数并标注截断', async () => {
    installScene(fakeNode({
      name: 'root',
      fileId: 'f0',
      children: Array.from({ length: 10 }, (_, index) => fakeNode({ name: `n${index}`, fileId: `f${index}` }))
    }));
    const result = await runScript('readRuntimeHierarchy', { maxNodes: 4 }) as {
      children: Array<unknown>;
      truncated?: boolean;
      nodeCount: number;
    };
    expect(result.nodeCount).toBeLessThanOrEqual(4);
    expect(result.truncated).toBe(true);
  });

  it('按 path 只序列化目标子树', async () => {
    installScene(fakeNode({
      name: 'Scene',
      fileId: 'scene-file',
      children: [fakeNode({
        name: 'Canvas',
        fileId: 'canvas-file',
        children: [fakeNode({ name: 'panel', fileId: 'panel-file' })]
      })]
    }));

    const result = await runScript('readRuntimeHierarchy', { path: 'Scene/Canvas' }) as {
      name: string;
      nodeCount: number;
      children: Array<{ name: string }>;
    };

    expect(result.name).toBe('Canvas');
    expect(result.nodeCount).toBe(2);
    expect(result.children).toEqual([expect.objectContaining({ name: 'panel' })]);
  });

  it('path 未命中时返回 node-not-found 与父节点可用子项', async () => {
    installScene(fakeNode({
      name: 'Scene',
      fileId: 'scene-file',
      children: [fakeNode({ name: 'Canvas', fileId: 'canvas-file' })]
    }));

    const result = await runScript('readRuntimeHierarchy', { path: 'Scene/missing/panel' }) as {
      found: boolean;
      reason?: string;
      availableChildren?: string[];
    };

    expect(result).toEqual({
      found: false,
      reason: 'node-not-found',
      availableChildren: ['Canvas']
    });
  });

  it('includeInactive=false 跳过未激活子树且不消耗节点额度', async () => {
    installScene(fakeNode({
      name: 'Scene',
      fileId: 'scene-file',
      children: [
        fakeNode({
          name: 'hidden',
          fileId: 'hidden-file',
          active: false,
          children: [fakeNode({ name: 'hidden-child', fileId: 'hidden-child-file' })]
        }),
        fakeNode({ name: 'visible', fileId: 'visible-file' })
      ]
    }));

    const result = await runScript('readRuntimeHierarchy', {
      includeInactive: false,
      maxNodes: 2
    }) as {
      nodeCount: number;
      truncated?: boolean;
      children: Array<{ name: string }>;
    };

    expect(result.nodeCount).toBe(2);
    expect(result.truncated).toBeUndefined();
    expect(result.children).toEqual([expect.objectContaining({ name: 'visible' })]);
  });
});

describe('readRuntimeComponent（页面注入：组件属性读取）', () => {
  it('按节点路径与组件类型读取属性包', async () => {
    installScene(fakeNode({
      name: 'Canvas',
      fileId: 'f1',
      children: [fakeNode({
        name: 'label',
        fileId: 'f2',
        components: [{ type: 'cc.Label', props: { string: '确定退出？', fontSize: 28 } }]
      })]
    }));
    const result = await runScript('readRuntimeComponent', { path: 'Canvas/label', componentType: 'cc.Label' }) as {
      found: boolean;
      nodeUuid?: string;
      properties?: Record<string, unknown>;
    };
    expect(result.found).toBe(true);
    expect(result.nodeUuid).toBe('uuid-label');
    expect(result.properties).toMatchObject({ string: '确定退出？', fontSize: 28 });
  });

  it('路径未命中时返回未找到与可用子节点名', async () => {
    installScene(fakeNode({
      name: 'Canvas',
      fileId: 'f1',
      children: [fakeNode({ name: 'panel', fileId: 'f2' })]
    }));
    const result = await runScript('readRuntimeComponent', { path: 'Canvas/missing/btn', componentType: 'cc.Button' }) as {
      found: boolean;
      reason?: string;
      availableChildren?: string[];
    };
    expect(result.found).toBe(false);
    expect(result.availableChildren).toEqual(['panel']);
  });

  it('运行时内置组件不带 cc. 前缀：兼容匹配并回传实际类型名', async () => {
    installScene(fakeNode({
      name: 'Canvas',
      fileId: 'f1',
      components: [{ type: 'UITransform', props: { contentSize: { width: 1280, height: 720 } } }]
    }));
    const result = await runScript('readRuntimeComponent', { path: 'Canvas', componentType: 'cc.UITransform' }) as {
      found: boolean;
      componentType?: string;
      properties?: Record<string, unknown>;
    };
    expect(result.found).toBe(true);
    expect(result.componentType).toBe('UITransform');
    expect(result.properties).toMatchObject({ contentSize: { width: 1280, height: 720 } });
  });

  it('属性序列化覆盖原始类型、值类型、节点/组件引用与循环防护', async () => {
    const target = fakeNode({ name: 'target', fileId: 'f9' });
    const label = {
      __typename__: 'cc.Label',
      constructor: { name: 'cc.Label' },
      string: '文本',
      fontSize: 28,
      enabled: true,
      customMaterial: null,
      node: target,
      position: { x: 1, y: 2, z: 3, constructor: { name: 'Vec3' } },
      color: { r: 255, g: 128, b: 0, a: 255, constructor: { name: 'Color' } },
      onClick: () => undefined
    };
    // 循环引用：label.self -> label
    (label as Record<string, unknown>).self = label;
    installScene(fakeNode({
      name: 'Canvas',
      fileId: 'f1',
      children: [{
        ...fakeNode({ name: 'label', fileId: 'f2' }),
        components: [label as never],
        getComponent: () => label
      } as never]
    }));
    const result = await runScript('readRuntimeComponent', { path: 'Canvas/label', componentType: 'cc.Label' }) as {
      found: boolean;
      properties: Record<string, unknown>;
      skipped: string[];
    };
    expect(result.found).toBe(true);
    expect(result.properties.string).toBe('文本');
    expect(result.properties.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(result.properties.color).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(result.properties.node).toEqual({ __type: 'node-reference', uuid: 'uuid-target', name: 'target' });
    expect(result.properties.customMaterial).toBeNull();
    expect(result.skipped).toContain('onClick');
    expect(result.properties.self).toMatchObject({ __type: 'circular-reference' });
  });
});

describe('sampleRuntimeWindow（页面注入：时间窗口采样）', () => {
  it('触发方法后逐帧采样属性，并把节点销毁记录为 nodeValid=false', async () => {
    const loginNode = fakeNode({
      name: 'login',
      fileId: 'login-file',
      components: [{ type: 'LoginView' }]
    }) as Record<string, unknown>;
    const component = (loginNode.components as Array<Record<string, unknown>>)[0];
    loginNode.isValid = true;
    component.isValid = true;
    component.opacity = 1;
    component.state = { progress: 0 };
    component.startTransition = () => 'started';
    installScene(fakeNode({
      name: 'Scene',
      fileId: 'scene-file',
      children: [fakeNode({
        name: 'Canvas',
        fileId: 'canvas-file',
        children: [loginNode as ReturnType<typeof fakeNode>]
      })]
    }));

    let now = 100;
    let frame = 0;
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
      frame += 1;
      now += 16;
      if (frame === 2) {
        component.opacity = 0.5;
        component.state = { progress: 0.5 };
      }
      if (frame === 3) {
        loginNode.isValid = false;
        component.isValid = false;
      }
      queueMicrotask(() => callback(now));
      return frame;
    });

    const result = await runScript('sampleRuntimeWindow', {
      path: 'Scene/Canvas/login',
      componentType: 'LoginView',
      properties: ['opacity', 'state.progress'],
      mode: 'perFrame',
      durationMs: 48,
      trigger: { method: 'startTransition', args: [] }
    }) as {
      found: boolean;
      trigger?: { invoked?: boolean; returnValue?: unknown };
      samples: Array<{ frame: number; t: number; values: Record<string, unknown>; nodeValid: boolean }>;
    };

    expect(result.found).toBe(true);
    expect(result.trigger).toMatchObject({ invoked: true, returnValue: 'started' });
    expect(result.samples.map((sample) => sample.nodeValid)).toContain(false);
    expect(result.samples.some((sample) => sample.values.opacity === 0.5)).toBe(true);
    expect(result.samples.at(-1)).toMatchObject({ values: {}, nodeValid: false });
  });

  it('页面没有 requestAnimationFrame 时按 intervalMs 定时采样', async () => {
    const targetNode = fakeNode({
      name: 'target',
      fileId: 'target-file',
      components: [{ type: 'CounterView', props: { count: 1 } }]
    }) as Record<string, unknown>;
    const component = (targetNode.components as Array<Record<string, unknown>>)[0];
    targetNode.isValid = true;
    component.isValid = true;
    installScene(fakeNode({ name: 'Scene', fileId: 'scene-file', children: [targetNode as ReturnType<typeof fakeNode>] }));

    let now = 100;
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('setTimeout', (callback: () => void, delay: number) => {
      now += delay;
      component.count = Number(component.count) + 1;
      queueMicrotask(callback);
      return 1;
    });

    const result = await runScript('sampleRuntimeWindow', {
      path: 'Scene/target',
      componentType: 'CounterView',
      properties: ['count'],
      mode: { intervalMs: 20 },
      durationMs: 40
    }) as { samples: Array<{ values: Record<string, unknown> }> };

    expect(result.samples.map((sample) => sample.values.count)).toEqual([1, 2, 3]);
  });

  it('异步 trigger 不等待 Promise 完成，触发后立即开始采样', async () => {
    const targetNode = fakeNode({
      name: 'target',
      fileId: 'target-file',
      components: [{ type: 'TransitionView', props: { opacity: 1 } }]
    }) as Record<string, unknown>;
    const component = (targetNode.components as Array<Record<string, unknown>>)[0];
    targetNode.isValid = true;
    component.isValid = true;
    installScene(fakeNode({ name: 'Scene', fileId: 'scene-file', children: [targetNode as ReturnType<typeof fakeNode>] }));

    let now = 100;
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
      now += 16;
      queueMicrotask(() => callback(now));
      return now;
    });
    component.startTransition = () => {
      component.opacity = 0.75;
      return new Promise<string>((resolve) => {
        (globalThis.requestAnimationFrame as (callback: () => void) => unknown)(() => {
          component.opacity = 0.5;
          resolve('finished');
        });
      });
    };

    const result = await runScript('sampleRuntimeWindow', {
      path: 'Scene/target',
      componentType: 'TransitionView',
      properties: ['opacity'],
      mode: 'perFrame',
      durationMs: 32,
      trigger: { method: 'startTransition', args: [] }
    }) as {
      trigger: { invoked: boolean; pending?: boolean; returnValue?: unknown };
      samples: Array<{ values: Record<string, unknown> }>;
    };

    expect(result.samples[0].values.opacity).toBe(0.75);
    expect(result.samples.some((sample) => sample.values.opacity === 0.5)).toBe(true);
    expect(result.trigger).toMatchObject({ invoked: true, pending: false, returnValue: 'finished' });
  });
});

describe('assembleRuntimeNodeSnapshot（core 装配）', () => {
  it('原始树装配为协议快照并通过 Schema 校验', () => {
    const snapshot = assembleRuntimeNodeSnapshot(
      {
        uuid: 'u1',
        name: 'Scene',
        active: true,
        dynamic: false,
        components: [{ type: 'cc.Scene' }],
        children: [{ uuid: 'u2', name: 'toast', active: true, dynamic: true, components: [], children: [] }]
      },
      'session-1',
      () => new Date('2026-07-22T05:20:00.000Z')
    );
    expect(() => RuntimeNodeSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({
      source: 'preview-runtime',
      previewSessionId: 'session-1',
      capturedAt: '2026-07-22T05:20:00.000Z'
    });
  });
});
