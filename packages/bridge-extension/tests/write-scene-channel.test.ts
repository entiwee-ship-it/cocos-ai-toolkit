import { describe, expect, it, vi } from 'vitest';
import type { ComponentWriteOpResult } from '../src/component-writer.js';
import type { NodeWriteOpResult } from '../src/node-writer.js';
import {
  executeWriteSceneOperations,
  readDumpValueAtPath,
  rollbackWriteSceneOperations,
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
      undoGroup: 'mixed-write'
    }, dependencies);

    expect(outcome.kind).toBe('success');
    expect(outcome.executedOps).toBe(2);
    expect(outcome.verification?.passed).toBe(true);
    expect(dependencies.calls).toEqual([
      'node:node.rename',
      'component:component.set_property',
      'saveDocument',
      'reloadDocument'
    ]);
    // 证据保留每个操作的逆操作，供回滚编排
    const evidence = outcome.evidence as Array<{ inverse: unknown[] }>;
    expect(evidence).toHaveLength(2);
    expect(evidence[0].inverse).toHaveLength(1);
  });

  it('为新建节点和组件回填结果 UUID 供重读验证', async () => {
    const dependencies = createDependencies();
    const outcome = await executeWriteSceneOperations({
      operations: [
        { type: 'node.create', parentNodeUuid: 'p', name: 'New' },
        { type: 'component.add', nodeUuid: 'n1', componentType: 'cc.Sprite', scriptUuid: null }
      ],
      save: false,
      undoGroup: 'backfill'
    }, dependencies);

    const evidence = outcome.evidence as Array<{ operation: Record<string, unknown> }>;
    expect(evidence[0].operation.resultNodeUuid).toBe('n1');
    expect(evidence[1].operation.resultComponentUuid).toBe('c1');
    // 已有目标 UUID 的操作不重复回填
    const outcomeExisting = await executeWriteSceneOperations({
      operations: [{ type: 'node.rename', nodeUuid: 'keep-me', name: 'X' }],
      save: false,
      undoGroup: 'no-backfill'
    }, dependencies);
    const evidenceExisting = outcomeExisting.evidence as Array<{ operation: Record<string, unknown> }>;
    expect(evidenceExisting[0].operation.resultNodeUuid).toBeUndefined();
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
      undoGroup: 'partial-write'
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
});

describe('rollbackWriteSceneOperations', () => {
  it('按逆序应用逆操作并全部成功', async () => {
    const dependencies = createDependencies();
    const executed = [
      executedOp('node.rename', { nodeUuid: 'n1', inverse: [{ type: 'node.rename', nodeUuid: 'n1', name: 'Old' }] }),
      executedOp('node.set_active', { nodeUuid: 'n1', inverse: [{ type: 'node.set_active', nodeUuid: 'n1', active: true }] })
    ];

    const result = await rollbackWriteSceneOperations(executed, dependencies);

    expect(result).toEqual({ succeeded: true, failedAt: null });
    expect(dependencies.calls).toEqual(['node:node.set_active', 'node:node.rename']);
  });

  it('逆操作失败时停止并报告失败位置', async () => {
    const dependencies = createDependencies({ failAtType: 'node.set_active' });
    const executed = [
      executedOp('node.rename', { nodeUuid: 'n1', inverse: [{ type: 'node.rename', nodeUuid: 'n1', name: 'Old' }] }),
      executedOp('node.set_active', { nodeUuid: 'n1', inverse: [{ type: 'node.set_active', nodeUuid: 'n1', active: true }] })
    ];

    const result = await rollbackWriteSceneOperations(executed, dependencies);

    expect(result.succeeded).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(dependencies.calls).toEqual(['node:node.set_active']);
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
    inverse: [{ type: 'node.rename', nodeUuid: 'n1', name: 'Old' }]
  };
  const componentResult: ComponentWriteOpResult = {
    componentUuid: 'c1',
    before: null,
    after: null,
    inverse: [{ type: 'component.set_property', componentUuid: 'c1', propertyPath: 'title', value: '' }]
  };
  return {
    calls,
    executeNodeOperation: async (operation) => {
      calls.push(`node:${operation.type}`);
      if (operation.type === options.failAtType) {
        const { ProbeError } = await import('../src/probe-errors.js');
        throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: operation.nodeUuid });
      }
      return { ...nodeResult, inverse: (operation.inverse as never) ?? nodeResult.inverse };
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
        inverse: []
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

function executedOp(
  type: string,
  overrides: Record<string, unknown>
): { operation: { type: string } & Record<string, unknown>; inverse: never[] } & Record<string, unknown> {
  return {
    operation: { type, ...overrides },
    inverse: [],
    ...overrides
  } as never;
}
