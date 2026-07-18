import { describe, expect, it, vi } from 'vitest';
import type { ComponentWriteOpResult } from '../src/component-writer.js';
import type { NodeWriteOpResult } from '../src/node-writer.js';
import type { WriteTransactionRequest } from '../src/transaction-manager.js';
import {
  saveAndVerifyWriteTransaction,
  type WriteVerifierDependencies
} from '../src/write-verifier.js';

describe('saveAndVerifyWriteTransaction', () => {
  it('保存后重读验证每个写操作的最终生效值，全部一致才 passed', async () => {
    const dependencies = createDependencies();
    const report = await saveAndVerifyWriteTransaction(
      writeRequest(),
      [
        nodeResult({ nodeUuid: 'node-1', after: { uuid: 'node-1', name: 'Renamed' } }, { type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' }),
        componentResult({ componentUuid: 'comp-1', after: { uuid: 'comp-1', propertyPath: 'items[2]', value: 'c' } }, { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'items[2]', value: 'c' })
      ],
      dependencies
    );

    expect(dependencies.calls).toEqual(['saveDocument', 'reloadDocument']);
    expect(report.passed).toBe(true);
    expect(report.items).toHaveLength(2);
    expect(report.items.every((item) => item.passed)).toBe(true);
  });

  it('任一项重读不符时 passed 为 false 并保留 expected/actual 明细', async () => {
    const dependencies = createDependencies({ actualNodeName: 'UnexpectedName' });
    const report = await saveAndVerifyWriteTransaction(
      writeRequest(),
      [nodeResult({ nodeUuid: 'node-1', after: { uuid: 'node-1', name: 'Renamed' } }, { type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' })],
      dependencies
    );

    expect(report.passed).toBe(false);
    expect(report.items[0]).toMatchObject({
      operationIndex: 0,
      expected: 'Renamed',
      actual: 'UnexpectedName',
      passed: false
    });
  });

  it('node.create 按回填的 resultNodeUuid 重读验证', async () => {
    const dependencies = createDependencies();
    dependencies.getNodeInfo = async (nodeUuid) => nodeUuid === 'created-1'
      ? { uuid: 'created-1', name: 'New' }
      : null;
    const report = await saveAndVerifyWriteTransaction(
      writeRequest(),
      [{
        operation: { type: 'node.create', parentNodeUuid: 'p', name: 'New', resultNodeUuid: 'created-1' },
        nodeUuid: 'created-1',
        before: null,
        after: { uuid: 'created-1', name: 'New' },
        inverse: [{ type: 'node.delete', nodeUuid: 'created-1' }]
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: '节点存在', actual: '节点存在', passed: true });
  });

  it('node.delete 后节点仍可读到时验证失败', async () => {
    const dependencies = createDependencies({ nodeStillExists: true });
    const report = await saveAndVerifyWriteTransaction(
      writeRequest(),
      [nodeResult({ nodeUuid: 'node-1', after: null }, { type: 'node.delete', nodeUuid: 'node-1' })],
      dependencies
    );

    expect(report.passed).toBe(false);
    expect(report.items[0].passed).toBe(false);
  });

  it('component.resize_array 重读数组长度', async () => {
    const dependencies = createDependencies();
    const report = await saveAndVerifyWriteTransaction(
      writeRequest(),
      [componentResult(
        { componentUuid: 'comp-1', after: { uuid: 'comp-1', propertyPath: 'items', length: 3 } },
        { type: 'component.resize_array', componentUuid: 'comp-1', propertyPath: 'items', length: 3 }
      )],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: 3, actual: 3, passed: true });
  });

  it('clear_reference 按 Dump 空 UUID 判定已清空', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentProperty = async () => ({ uuid: '' });
    const report = await saveAndVerifyWriteTransaction(
      writeRequest(),
      [{
        operation: { type: 'component.clear_reference', componentUuid: 'comp-1', propertyPath: 'target' },
        componentUuid: 'comp-1',
        before: { reference: { uuid: 'node-9' } },
        after: { reference: { uuid: '' } },
        inverse: []
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0].passed).toBe(true);
  });

  it('set_reference 按归一化 UUID 比对 Dump 形态', async () => {
    const dependencies = createDependencies();
    dependencies.getComponentProperty = async () => ({ uuid: 'node-9' });
    const report = await saveAndVerifyWriteTransaction(
      writeRequest(),
      [{
        operation: {
          type: 'component.set_reference',
          componentUuid: 'comp-1',
          propertyPath: 'clickEvents[0].target',
          reference: { kind: 'node', objectUuid: 'node-9', fileId: null, nodePath: null, available: true }
        },
        componentUuid: 'comp-1',
        before: null,
        after: { reference: { uuid: 'node-9' } },
        inverse: []
      }],
      dependencies
    );

    expect(report.passed).toBe(true);
    expect(report.items[0]).toMatchObject({ expected: 'node-9', actual: 'node-9', passed: true });
  });

  it('save 为 false 时不保存不重开，直接对编辑器现状重读验证', async () => {
    const dependencies = createDependencies();
    const report = await saveAndVerifyWriteTransaction(
      writeRequest({ save: false }),
      [nodeResult({ nodeUuid: 'node-1', after: { uuid: 'node-1', name: 'Renamed' } }, { type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' })],
      dependencies
    );

    expect(dependencies.calls).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

function writeRequest(overrides: Partial<WriteTransactionRequest> = {}): WriteTransactionRequest {
  return {
    transactionId: 'tx-1',
    idempotencyKey: 'key-1',
    scope: 'current-document',
    revision: { document: null, hierarchy: null, assetDatabase: null, scriptCompilation: null },
    operations: [{ type: 'node.rename', nodeUuid: 'node-1', name: 'Renamed' }],
    save: true,
    undoGroup: 'verify-test',
    ...overrides
  };
}

function nodeResult(
  overrides: Partial<NodeWriteOpResult>,
  operation: { type: string; [field: string]: unknown }
): NodeWriteOpResult & { operation: { type: string; [field: string]: unknown } } {
  return {
    nodeUuid: 'node-1',
    before: null,
    after: null,
    inverse: [],
    ...overrides,
    operation
  };
}

function componentResult(
  overrides: Partial<ComponentWriteOpResult>,
  operation: { type: string; [field: string]: unknown }
): ComponentWriteOpResult & { operation: { type: string; [field: string]: unknown } } {
  return {
    componentUuid: 'comp-1',
    before: null,
    after: null,
    inverse: [],
    ...overrides,
    operation
  };
}

function createDependencies(options: {
  actualNodeName?: string;
  nodeStillExists?: boolean;
} = {}): WriteVerifierDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    saveDocument: async () => {
      calls.push('saveDocument');
    },
    reloadDocument: async () => {
      calls.push('reloadDocument');
    },
    getNodeInfo: async (nodeUuid) => {
      if (options.nodeStillExists === false) return null;
      if (options.nodeStillExists) return { uuid: nodeUuid, name: 'Renamed' };
      return { uuid: nodeUuid, name: options.actualNodeName ?? 'Renamed' };
    },
    getComponentInfo: async (componentUuid) => ({ uuid: componentUuid, type: 'cc.Label', enabled: true }),
    getComponentProperty: async (_componentUuid, propertyPath) => {
      if (propertyPath === 'items[2]') return 'c';
      if (propertyPath === 'items') return ['a', 'b', 'c'];
      return undefined;
    }
  };
}
