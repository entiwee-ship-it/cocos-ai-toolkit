import { describe, expect, it, vi } from 'vitest';
import type { ComponentWriteOpResult } from '../src/component-writer.js';
import type { NodeWriteOpResult } from '../src/node-writer.js';
import {
  executeWriteSceneOperations,
  readDumpValueAtPath,
  writeDumpValueAtPath,
  type WriteSceneChannelDependencies
} from '../src/write-scene-channel.js';

describe('executeWriteSceneOperations', () => {
  it('混合节点与组件操作按序执行，保存后重读验证通过', async () => {
    const dependencies = createDependencies();
    const outcome = await executeWriteSceneOperations({
      operations: [
        { type: 'node.rename', nodeUuid: 'n1', name: 'NewName' },
        { type: 'component.set_property', componentUuid: 'c1', propertyPath: 'title', value: 'hello' }
      ],
      save: true,
    }, dependencies);

    expect(outcome.kind).toBe('success');
    expect(outcome.executedOps).toBe(2);
    expect(outcome.verification?.passed).toBe(true);
    expect(dependencies.calls).toEqual([
      'node:node.rename',
      'component:component.set_property'
    ]);
    // 证据保留每个已执行操作
    const evidence = outcome.evidence as unknown[];
    expect(evidence).toHaveLength(2);
  });

  it('为新建节点和组件回填结果 UUID 供重读验证', async () => {
    const dependencies = createDependencies();
    dependencies.executeNodeOperation = async (operation) => ({
      nodeUuid: 'n1',
      before: null,
      after: {
        uuid: 'n1',
        name: String(operation.name ?? 'New'),
        stablePath: '/FriendsRoomView/CocosAiValidationView/Title'
      },
    });
    dependencies.executeComponentOperation = async () => ({
      componentUuid: 'c1',
      before: null,
      after: {
        uuid: 'c1',
        type: 'cc.Sprite',
        enabled: true,
        nodeStablePath: '/FriendsRoomView~0/CocosAiValidationView~0/Title~0',
        sameTypeIndex: 0
      },
    });
    const outcome = await executeWriteSceneOperations({
      operations: [
        { type: 'node.create', parentNodeUuid: 'p', name: 'New' },
        { type: 'component.add', nodeUuid: 'n1', componentType: 'cc.Sprite', scriptUuid: null }
      ],
      save: false,
    }, dependencies);

    const evidence = outcome.evidence as Array<{ operation: Record<string, unknown> }>;
    expect(evidence[0].operation.resultNodeUuid).toBe('n1');
    expect(evidence[0].operation.resultNodeStablePath).toBe('/FriendsRoomView/CocosAiValidationView/Title');
    expect(evidence[1].operation.resultComponentUuid).toBe('c1');
    expect(evidence[1].operation).toMatchObject({
      resultComponentNodeStablePath: '/FriendsRoomView~0/CocosAiValidationView~0/Title~0',
      resultComponentType: 'cc.Sprite',
      resultComponentSameTypeIndex: 0
    });
    // 结果 UUID 一律回填并覆盖原操作值（create_from_node 重建节点后 UUID 变更的场景依赖覆盖语义）
    const outcomeExisting = await executeWriteSceneOperations({
      operations: [{ type: 'node.rename', nodeUuid: 'keep-me', name: 'X' }],
      save: false,
    }, dependencies);
    const evidenceExisting = outcomeExisting.evidence as Array<{ operation: Record<string, unknown> }>;
    expect(evidenceExisting[0].operation.resultNodeUuid).toBe('n1');
  });

  it('第三个操作失败时返回 operation-failed 并保留前两个证据', async () => {    const dependencies = createDependencies({ failAtType: 'component.enable' });
    const outcome = await executeWriteSceneOperations({
      operations: [
        { type: 'node.rename', nodeUuid: 'n1', name: 'NewName' },
        { type: 'node.set_active', nodeUuid: 'n1', active: false },
        { type: 'component.enable', componentUuid: 'c1', enabled: false },
        { type: 'node.delete', nodeUuid: 'n2' }
      ],
      save: true,
    }, dependencies);

    expect(outcome.kind).toBe('operation-failed');
    expect(outcome.executedOps).toBe(2);
    expect(outcome).toMatchObject({
      failure: { code: 'COMPONENT_NOT_FOUND', operationIndex: 2 }
    });
    const evidence = outcome.evidence as Array<unknown>;
    expect(evidence).toHaveLength(2);
    // 失败即停：不保存、不重读验证
    expect(dependencies.calls).not.toContain('saveDocument');
  });

  it('保存或验证异常时返回 unknown 并保留全部已执行证据', async () => {
    const dependencies = createDependencies();
    dependencies.verify = async () => {
      throw new Error('reload failed');
    };

    const outcome = await executeWriteSceneOperations({
      operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
      save: true,
    }, dependencies);

    expect(outcome).toMatchObject({
      kind: 'unknown',
      executedOps: 1,
      failure: {
        code: 'DIRECT_WRITE_VERIFICATION_UNKNOWN',
        operationIndex: null,
        stage: 'unknown'
      }
    });
    expect(outcome.evidence).toHaveLength(1);
  });

  it('把 Prefab 实例稳定身份与目标 FileID 回填给重载后验证', async () => {
    const dependencies = createDependencies();
    dependencies.executePrefabOperation = async () => ({
      nodeUuid: 'instance-old',
      assetUuid: null,
      before: null,
      after: {
        nodeUuid: 'instance-old',
        stablePath: '/Scene~0/Panel~0',
        prefabAssetUuid: 'asset-panel',
        instanceFileId: 'instance-file-id'
      },
      targetLocalIds: ['nested-instance', 'label-component'],
      previousOverride: { value: 'Override Applied' },
    });

    const outcome = await executeWriteSceneOperations({
      operations: [{
        type: 'prefab.revert_override',
        instanceRootUuid: 'instance-old',
        targetObjectUuid: 'label-old',
        propertyPath: 'string'
      }],
      save: false,
    }, dependencies);

    const evidence = outcome.evidence as Array<{ operation: Record<string, unknown> }>;
    expect(evidence[0].operation).toMatchObject({
      resultNodeStablePath: '/Scene~0/Panel~0',
      resultPrefabAssetUuid: 'asset-panel',
      resultPrefabInstanceFileId: 'instance-file-id',
      resultTargetLocalIds: ['nested-instance', 'label-component'],
      resultHadPreviousOverride: true,
      resultPreviousOverrideValue: 'Override Applied'
    });
  });

  it('Prefab 解包子树快照只供内部验证，不进入公开 evidence', async () => {
    const dependencies = createDependencies();
    const subtree = {
      rootStablePath: '/Scene~0/Panel~0',
      nodes: [{
        nodeUuid: 'instance-old', relativePath: '', name: 'Panel', componentTypes: [],
        prefabAssetUuid: 'asset-panel', instanceFileId: 'instance-file-id', isNested: true, state: 2
      }]
    };
    dependencies.executePrefabOperation = async () => ({
      nodeUuid: 'instance-old',
      assetUuid: null,
      before: { stablePath: '/Scene~0/Panel~0', prefabAssetUuid: 'asset-panel' },
      after: { stablePath: '/Scene~0/Panel~0', prefabAssetUuid: null },
      beforeSubtree: subtree,
      afterSubtree: subtree
    });
    dependencies.verify = async (executed) => {
      expect(executed[0].operation).toMatchObject({ resultPrefabBeforeSubtree: subtree });
      return {
        passed: true,
        verifiedAt: '2026-08-26T00:00:00.000Z',
        items: [{ operationIndex: 0, description: 'unpack', expected: true, actual: true, passed: true }]
      };
    };

    const outcome = await executeWriteSceneOperations({
      operations: [{
        type: 'prefab.unlink_instance', instanceRootUuid: 'instance-old',
        removeNested: false, expectedPrefabAssetUuid: 'asset-panel'
      }],
      save: true
    }, dependencies);

    const evidence = outcome.evidence as Array<Record<string, unknown>>;
    expect(evidence[0]).not.toHaveProperty('beforeSubtree');
    expect(evidence[0]).not.toHaveProperty('afterSubtree');
    expect(evidence[0].operation).not.toHaveProperty('resultPrefabBeforeSubtree');
  });

  it('全部操作均未改变文档时不保存也不重开', async () => {
    const dependencies = createDependencies();
    dependencies.executeComponentOperation = async (operation) => {
      dependencies.calls.push(`component:${operation.type}`);
      return {
        componentUuid: 'c1',
        before: null,
        after: null,
        changed: false
      };
    };

    const outcome = await executeWriteSceneOperations({
      operations: [
        { type: 'component.add', nodeUuid: 'n1', componentType: 'cc.UITransform', scriptUuid: null },
        { type: 'component.add', nodeUuid: 'n1', componentType: 'cc.UITransform', scriptUuid: null }
      ],
      save: true,
    }, dependencies);

    expect(outcome.kind).toBe('success');
    expect(outcome.verification?.passed).toBe(true);
    expect(dependencies.calls).toEqual([
      'component:component.add',
      'component:component.add'
    ]);
  });
});

describe('Dump 路径读写', () => {
  it('读取 Dump 包装的嵌套属性值', () => {
    const dump = {
      type: 'cc.TestComponent',
      value: {
        items: {
          type: 'Array',
          value: [
            { type: 'String', value: 'a' },
            { type: 'String', value: 'b' }
          ]
        },
        settings: {
          type: 'Object',
          value: {
            colors: { type: 'Array', value: [{ type: 'String', value: '#000' }] }
          }
        }
      }
    };

    expect(readDumpValueAtPath(dump, ['items', 1])).toBe('b');
    expect(readDumpValueAtPath(dump, ['settings', 'colors', 0])).toBe('#000');
  });

  it('读取整个 ccclass 数组时递归解包每个字段', () => {
    const dump = {
      type: 'CocosAiValidationComponent',
      value: {
        items: {
          type: 'Array',
          value: [{
            type: 'CocosAiValidationItem',
            value: {
              label: { name: 'label', type: 'String', value: 'First' },
              mode: { name: 'mode', type: 'Enum', value: 1 },
              weight: { name: 'weight', type: 'Number', value: 10 }
            }
          }]
        }
      }
    };

    expect(readDumpValueAtPath(dump, ['items'])).toEqual([
      { label: 'First', mode: 1, weight: 10 }
    ]);
  });

  it('写入 Dump 嵌套值并返回新 Dump，不改动原对象', () => {
    const dump = {
      type: 'cc.TestComponent',
      value: {
        items: {
          type: 'Array',
          value: [{ type: 'String', value: 'a' }, { type: 'String', value: 'b' }]
        }
      }
    };

    const updated = writeDumpValueAtPath(dump, ['items', 0], 'z');

    expect(readDumpValueAtPath(updated, ['items', 0])).toBe('z');
    expect(readDumpValueAtPath(dump, ['items', 0])).toBe('a');
  });
});

function createDependencies(options: { failAtType?: string } = {}): WriteSceneChannelDependencies & { calls: string[] } {
  const calls: string[] = [];
  const nodeResult: NodeWriteOpResult = {
    nodeUuid: 'n1',
    before: null,
    after: null,
  };
  const componentResult: ComponentWriteOpResult = {
    componentUuid: 'c1',
    before: null,
    after: null,
  };
  return {
    calls,
    executeNodeOperation: async (operation) => {
      calls.push(`node:${operation.type}`);
      if (operation.type === options.failAtType) {
        const { ProbeError } = await import('../src/probe-errors.js');
        throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: operation.nodeUuid });
      }
      return nodeResult;
    },
    executeComponentOperation: async (operation) => {
      calls.push(`component:${operation.type}`);
      if (operation.type === options.failAtType) {
        const { ProbeError } = await import('../src/probe-errors.js');
        throw new ProbeError('COMPONENT_NOT_FOUND', { componentUuid: operation.componentUuid });
      }
      return componentResult;
    },
    executePrefabOperation: async (operation) => {
      calls.push(`prefab:${operation.type}`);
      return {
        nodeUuid: 'n1',
        assetUuid: null,
        before: null,
        after: null,
      };
    },
    saveDocument: async () => {
      calls.push('saveDocument');
    },
    reloadDocument: async () => {
      calls.push('reloadDocument');
    },
    verify: async () => ({
      passed: true,
      verifiedAt: '2026-07-17T00:00:01.000Z',
      items: []
    })
  };
}
