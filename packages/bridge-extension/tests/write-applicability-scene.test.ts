import Module from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WriteOperation } from '../src/write-types.js';

const originalEditorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Editor');
const originalCceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cce');

afterEach(() => {
  vi.restoreAllMocks();
  restoreGlobal('Editor', originalEditorDescriptor);
  restoreGlobal('cce', originalCceDescriptor);
  vi.resetModules();
});

describe('assertWriteOperationsApplicable', () => {
  it('嵌套内容 transform 和 child create 在进入 writer 前被拒绝', async () => {
    const requests = installCreatorMocks({
      nodes: {
        'nested-child': nestedNode('nested-child', false),
        'nested-root': nestedNode('nested-root', true)
      }
    });
    const { assertWriteOperationsApplicable } = await loadSceneModule();

    for (const operation of [
      {
        type: 'node.set_transform',
        nodeUuid: 'nested-child',
        localTransform: { position: { x: 0, y: 0, z: 0 } }
      },
      {
        type: 'node.create',
        parentNodeUuid: 'nested-root',
        name: 'BlockedChild'
      }
    ] as WriteOperation[]) {
      const error = await assertWriteOperationsApplicable([operation]).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT',
        details: {
        ownerPrefabUuid: 'nested-prefab',
        ownerSourceUrl: 'db://assets/Nested.prefab',
        route: { tool: 'cocos_prefab_open', arguments: { uuid: 'nested-prefab' } }
        }
      });
    }
    expect(requests).not.toContainEqual(expect.arrayContaining(['scene', 'create-node']));
  });

  it('实例根 rename 放行，但实例根组件属性仍被拒绝', async () => {
    installCreatorMocks({
      nodes: { 'nested-root': nestedNode('nested-root', true) },
      components: { 'root-component': component('nested-root') }
    });
    const { assertWriteOperationsApplicable } = await loadSceneModule();

    await expect(assertWriteOperationsApplicable([{
      type: 'node.rename',
      nodeUuid: 'nested-root',
      name: 'AllowedName'
    }])).resolves.toBeUndefined();

    const error = await assertWriteOperationsApplicable([{
      type: 'component.set_property',
      componentUuid: 'root-component',
      propertyPath: 'contentSize',
      value: { width: 100, height: 100 }
    }]).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT',
      details: {
        requiredCapability: 'canSetComponentProperty',
        isInstanceRoot: true,
        reasonCode: 'NESTED_PREFAB_INSTANCE_ROOT_LIMITED'
      }
    });
  });

  it('probeNode 返回与前置门禁相同的源 Prefab 路由', async () => {
    installCreatorMocks({ nodes: { 'nested-root': nestedNode('nested-root', true) } });
    const { methods } = await loadSceneModule();

    const response = await methods.probeNode({ uuid: 'nested-root' }) as {
      data: Record<string, unknown>;
      raw?: unknown;
    };
    expect(response).toMatchObject({
      data: {
        prefabInstance: {
          isInstanceRoot: true,
          prefabAssetUuid: 'nested-prefab',
          sourceUrl: 'db://assets/Nested.prefab'
        },
        writeCapabilities: {
          isNestedPrefabContent: true,
          canRename: true,
          canCreateChild: false,
          ownerPrefabUuid: 'nested-prefab',
          ownerSourceUrl: 'db://assets/Nested.prefab'
        }
      }
    });
    expect(response).toHaveProperty('raw');
    expect(response.data).toHaveProperty('raw');
  });
});

describe('compact probe responses', () => {
  it('probeNode 紧凑模式不返回信封和节点 raw', async () => {
    installCreatorMocks({ nodes: { 'nested-root': nestedNode('nested-root', true) } });
    const { methods } = await loadSceneModule();

    const response = await methods.probeNode({ uuid: 'nested-root', compact: true }) as {
      data: Record<string, unknown>;
      raw?: unknown;
    };

    expect(response).not.toHaveProperty('raw');
    expect(response.data).not.toHaveProperty('raw');
  });

  it('probeHierarchy 紧凑模式不返回信封和递归节点 raw', async () => {
    installCreatorMocks({
      nodes: {},
      hierarchy: {
        uuid: 'root',
        name: 'Root',
        children: [{ uuid: 'child', name: 'Child', children: [] }]
      }
    });
    const { methods } = await loadSceneModule();

    const response = await methods.probeHierarchy({ depth: 1, compact: true }) as {
      data: { raw?: unknown; children: Array<{ raw?: unknown }> };
      raw?: unknown;
    };

    expect(response).not.toHaveProperty('raw');
    expect(response.data).not.toHaveProperty('raw');
    expect(response.data.children[0]).not.toHaveProperty('raw');

    const fullResponse = await methods.probeHierarchy({ depth: 1 }) as {
      data: { raw?: unknown; children: Array<{ raw?: unknown }> };
      raw?: unknown;
    };
    expect(fullResponse).toHaveProperty('raw');
    expect(fullResponse.data).toHaveProperty('raw');
    expect(fullResponse.data.children[0]).toHaveProperty('raw');
  });

  it('完整 hierarchy/node 超出预算时在 Bridge 发送前拒绝，紧凑模式仍可读取', async () => {
    installCreatorMocks({
      nodes: {
        'nested-root': {
          ...nestedNode('nested-root', true),
          largeDiagnostic: { value: 'x'.repeat(20_000) }
        }
      },
      hierarchy: {
        uuid: 'root',
        name: 'Root',
        largeDiagnostic: 'x'.repeat(20_000),
        children: []
      }
    });
    const { methods } = await loadSceneModule();

    for (const operation of [
      methods.probeHierarchy({ depth: 1, maxOutputBytes: 16 * 1024 }),
      methods.probeNode({ uuid: 'nested-root', maxOutputBytes: 16 * 1024 })
    ]) {
      const error = await operation.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'PROBE_OUTPUT_TOO_LARGE',
        details: { tooLarge: true, maxOutputBytes: 16 * 1024 }
      });
      expect(error.details.estimatedBytes).toBeGreaterThan(16 * 1024);
    }

    await expect(methods.probeHierarchy({ depth: 1, compact: true, maxOutputBytes: 16 * 1024 })).resolves.toBeDefined();
    await expect(methods.probeNode({ uuid: 'nested-root', compact: true, maxOutputBytes: 16 * 1024 })).resolves.toBeDefined();
  });
});

function installCreatorMocks(options: {
  nodes: Record<string, unknown>;
  components?: Record<string, unknown>;
  hierarchy?: unknown;
}) {
  const requests: unknown[][] = [];
  Object.defineProperty(globalThis, 'cce', {
    configurable: true,
    value: {
      SceneFacadeManager: {
        queryCurrentSceneUuid: async () => 'owner-prefab',
        queryMode: async () => 'prefab'
      }
    }
  });
  Object.defineProperty(globalThis, 'Editor', {
    configurable: true,
    value: {
      Message: {
        request: vi.fn(async (...args: unknown[]) => {
          requests.push(args);
          const [channel, method, value] = args;
          if (channel === 'scene' && method === 'query-node') return options.nodes[String(value)];
          if (channel === 'scene' && method === 'query-node-tree') return options.hierarchy;
          if (channel === 'scene' && method === 'query-component') return options.components?.[String(value)];
          if (channel === 'asset-db' && method === 'query-asset-info') {
            return { uuid: value, url: 'db://assets/Nested.prefab', type: 'cc.Prefab' };
          }
          throw new Error(`UNEXPECTED_EDITOR_MESSAGE:${String(channel)}:${String(method)}`);
        })
      }
    }
  });
  return requests;
}

async function loadSceneModule() {
  const moduleLoader = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function loadModule(request, parent, isMain) {
    if (request === 'cc') {
      return {
        director: { getScene: () => ({}) },
        Vec3: class Vec3 {
          constructor(public x = 0, public y = 0, public z = 0) {}
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    vi.resetModules();
    return await import('../src/scene.js');
  } finally {
    moduleLoader._load = originalLoad;
  }
}

function nestedNode(uuid: string, isInstanceRoot: boolean) {
  return {
    uuid: { value: uuid },
    name: { value: uuid },
    active: { value: true },
    layer: { value: 1 },
    parent: { value: { uuid: 'owner-root' } },
    children: [],
    __type__: 'cc.Node',
    __comps__: [],
    __prefab__: {
      uuid: 'nested-prefab',
      fileId: `${uuid}-file`,
      rootUuid: 'nested-root',
      prefabStateInfo: { state: isInstanceRoot ? 2 : 1, isNested: true },
      ...(isInstanceRoot ? { instance: { value: { fileId: { value: 'nested-instance-file' } } } } : {})
    }
  };
}

function component(nodeUuid: string) {
  return {
    value: {
      uuid: { value: 'root-component' },
      node: { value: { uuid: nodeUuid }, type: 'cc.Node' }
    },
    type: 'cc.UITransform',
    cid: 'cc.UITransform',
    extends: ['cc.Component', 'cc.Object']
  };
}

function restoreGlobal(name: string, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}
