import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { validateProbePrepareRequest } from '../src/probe-operation.js';
import {
  InMemoryProbeTransactionStore,
  ProbeTransactionCoordinator,
  type ProbeRevisionSnapshot
} from '../src/probe-transaction.js';
import { captureProbeRevision, restoreProbeAsset } from '../src/probe-runtime.js';
import { assertCreatedProbeNode, executeProbeSceneOperation } from '../src/probe-scene-operation.js';

const ISOLATED_PROJECT = 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe';

describe('validateProbePrepareRequest', () => {
  it('prepare 不需要预知 Creator 创建后的节点 UUID', () => {
    expect(validateProbePrepareRequest({
      projectPath: ISOLATED_PROJECT,
      documentAssetUuid: 'asset-1',
      probeName: 'CocosAiProbe_123'
    })).toEqual({
      projectPath: ISOLATED_PROJECT,
      documentAssetUuid: 'asset-1',
      probeName: 'CocosAiProbe_123'
    });
  });

  it('拒绝真实项目和非探针名称', () => {
    expect(() => validateProbePrepareRequest({
      projectPath: 'E:/xile-workspace/qyProject/xy-client',
      documentAssetUuid: 'asset-1',
      probeName: 'CocosAiProbe_123'
    })).toThrow('PROBE_PROJECT_NOT_ISOLATED');

    expect(() => validateProbePrepareRequest({
      projectPath: ISOLATED_PROJECT,
      documentAssetUuid: 'asset-1',
      probeName: 'DangerousNode'
    })).toThrow('INVALID_PROBE_NAME');
  });
});

describe('ProbeTransactionCoordinator', () => {
  it('confirm 必须匹配 transactionId 和 expectedRevision', async () => {
    const coordinator = createCoordinator();
    const prepared = await coordinator.prepare(prepareRequest());

    await expect(coordinator.confirm({
      transactionId: prepared.transactionId,
      expectedRevision: 'wrong-revision'
    })).rejects.toThrow('EXPECTED_REVISION_MISMATCH');
  });

  it('confirm 前 Revision 变化时拒绝执行', async () => {
    const execute = vi.fn(async () => executionResult());
    const coordinator = createCoordinator({
      revisions: [revisionSnapshot(), revisionSnapshot({ dirty: true })],
      execute
    });
    const prepared = await coordinator.prepare(prepareRequest());

    await expect(coordinator.confirm({
      transactionId: prepared.transactionId,
      expectedRevision: prepared.revision
    })).rejects.toThrow('REVISION_CONFLICT');
    expect(execute).not.toHaveBeenCalled();
  });

  it('prepare 拒绝保存已有人工 Dirty 状态', async () => {
    const coordinator = createCoordinator({
      revisions: [revisionSnapshot({ dirty: true })]
    });

    await expect(coordinator.prepare(prepareRequest())).rejects.toThrow('DOCUMENT_DIRTY');
  });

  it('confirm 重试返回原事务状态且不重复写入', async () => {
    const execute = vi.fn(async () => executionResult());
    const coordinator = createCoordinator({ execute });
    const prepared = await coordinator.prepare(prepareRequest());

    const first = await coordinator.confirm({
      transactionId: prepared.transactionId,
      expectedRevision: prepared.revision
    });
    const retried = await coordinator.confirm({
      transactionId: prepared.transactionId,
      expectedRevision: prepared.revision
    });

    expect(first.status).toBe('rolled-back');
    expect(retried).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('基线资源内容只在 Bridge 内部传给执行器', async () => {
    const execute = vi.fn(async () => executionResult());
    const coordinator = createCoordinator({
      revisions: [
        revisionSnapshot({ recoveryContent: 'baseline-content' }),
        revisionSnapshot({ recoveryContent: 'baseline-content' })
      ],
      execute
    });
    const prepared = await coordinator.prepare(prepareRequest());

    expect(JSON.stringify(prepared)).not.toContain('baseline-content');
    await coordinator.confirm({
      transactionId: prepared.transactionId,
      expectedRevision: prepared.revision
    });
    expect(execute).toHaveBeenCalledWith(expect.any(Object), 'baseline-content');
  });

  it('未知事务拒绝 confirm 和 status', async () => {
    const coordinator = createCoordinator();

    await expect(coordinator.confirm({
      transactionId: 'missing',
      expectedRevision: 'revision'
    })).rejects.toThrow('TRANSACTION_NOT_FOUND');
    expect(() => coordinator.status({ transactionId: 'missing' })).toThrow('TRANSACTION_NOT_FOUND');
  });

  it('Probe Server 重连后仍可从 Bridge 主进程事务存储查询结果', async () => {
    const store = new InMemoryProbeTransactionStore();
    const beforeReconnect = createCoordinator({ store });
    const prepared = await beforeReconnect.prepare(prepareRequest());
    const confirmed = await beforeReconnect.confirm({
      transactionId: prepared.transactionId,
      expectedRevision: prepared.revision
    });

    const afterReconnect = createCoordinator({ store });

    expect(afterReconnect.status({ transactionId: prepared.transactionId })).toEqual(confirmed);
  });

  it('执行异常后保留 outcome-unknown 供重连查询', async () => {
    const coordinator = createCoordinator({
      execute: vi.fn(async () => {
        throw new Error('CREATOR_WRITE_INTERRUPTED');
      })
    });
    const prepared = await coordinator.prepare(prepareRequest());

    await expect(coordinator.confirm({
      transactionId: prepared.transactionId,
      expectedRevision: prepared.revision
    })).rejects.toThrow('CREATOR_WRITE_INTERRUPTED');
    expect(coordinator.status({ transactionId: prepared.transactionId })).toMatchObject({
      status: 'outcome-unknown',
      error: { code: 'CREATOR_WRITE_INTERRUPTED' }
    });
  });
});

describe('captureProbeRevision', () => {
  it('组合 Prefab 磁盘、编辑器层级、Dirty、根节点和同名探针状态', async () => {
    const revision = await captureProbeRevision(prepareRequest(), {
      queryAssetInfo: async () => ({ file: 'E:/probe/assets/sample.prefab' }),
      readFile: async () => Buffer.from('prefab-content'),
      queryDirty: async () => false,
      queryNodeTree: async () => ({
        uuid: 'scene-root',
        name: 'Scene',
        children: [{
          uuid: 'prefab-root',
          name: 'Sample',
          prefab: { assetUuid: 'asset-1' },
          components: [{ type: 'cc.UITransform', value: 'component-1' }],
          children: []
        }]
      })
    });

    expect(revision).toMatchObject({
      documentAssetUuid: 'asset-1',
      dirty: false,
      parentNodeUuid: 'prefab-root',
      existingProbeNodeUuid: null
    });
    expect(revision.assetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(revision.hierarchySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(revision.recoveryContent).toBe('prefab-content');
  });

  it('识别目标 Prefab 下已经存在的同名探针节点', async () => {
    const revision = await captureProbeRevision(prepareRequest(), {
      queryAssetInfo: async () => ({ file: 'E:/probe/assets/sample.prefab' }),
      readFile: async () => Buffer.from('prefab-content'),
      queryDirty: async () => true,
      queryNodeTree: async () => ({
        uuid: 'prefab-root',
        name: 'Sample',
        prefab: { assetUuid: 'asset-1' },
        children: [{ uuid: 'existing-probe', name: 'CocosAiProbe_123', children: [] }]
      })
    });

    expect(revision.existingProbeNodeUuid).toBe('existing-probe');
  });
});

describe('restoreProbeAsset', () => {
  it('磁盘字节变化时通过 Creator AssetDB 恢复并再次验哈希', async () => {
    const recoveryContent = 'baseline-content';
    const baselineSha256 = createHash('sha256').update(recoveryContent).digest('hex');
    let currentContent = Buffer.from('creator-reserialized-content');
    const saveAsset = vi.fn(async (_uuid: string, content: string) => {
      currentContent = Buffer.from(content);
    });

    const result = await restoreProbeAsset({
      documentAssetUuid: 'asset-1',
      baselineSha256,
      recoveryContent
    }, {
      readCurrentContent: async () => currentContent,
      saveAsset
    });

    expect(saveAsset).toHaveBeenCalledWith('asset-1', recoveryContent);
    expect(result).toEqual({
      recoveryMethod: 'asset-db-save-asset',
      diskHashRestored: true,
      finalAssetSha256: baselineSha256
    });
  });
});

describe('assertCreatedProbeNode', () => {
  it('只允许回滚本事务刚创建且名称匹配的探针节点', () => {
    expect(() => assertCreatedProbeNode(
      { uuid: 'created-node-1', name: 'CocosAiProbe_123' },
      'created-node-1',
      'CocosAiProbe_123'
    )).not.toThrow();

    expect(() => assertCreatedProbeNode(
      { uuid: 'other-node', name: 'CocosAiProbe_123' },
      'created-node-1',
      'CocosAiProbe_123'
    )).toThrow('PROBE_NODE_IDENTITY_MISMATCH');

    expect(() => assertCreatedProbeNode(
      { uuid: 'created-node-1', name: 'BusinessNode' },
      'created-node-1',
      'CocosAiProbe_123'
    )).toThrow('PROBE_NODE_IDENTITY_MISMATCH');
  });

  it('读取 Creator 3.8.8 query-node 的 Dump 包装身份字段', () => {
    expect(() => assertCreatedProbeNode(
      {
        uuid: { value: 'created-node-1' },
        name: { value: 'CocosAiProbe_123' }
      },
      'created-node-1',
      'CocosAiProbe_123'
    )).not.toThrow();
  });
});

describe('executeProbeSceneOperation', () => {
  it('创建固定节点和 UITransform，保存后通过 Undo 回滚并再次保存', async () => {
    let queryCount = 0;
    const calls: string[] = [];
    const result = await executeProbeSceneOperation(transactionForScene(), {
      createNode: async () => {
        calls.push('create-node');
        return 'created-node-1';
      },
      createComponent: async () => {
        calls.push('create-component');
      },
      setProperty: async () => {
        calls.push('set-property');
      },
      queryNode: async () => {
        queryCount += 1;
        if (queryCount === 1) {
          return creatorNodeDump({ x: 0, y: 0, z: 0 });
        }
        if (queryCount === 2 || queryCount === 3) {
          return creatorNodeDump({ x: 17, y: 23, z: 0 });
        }
        return null;
      },
      saveScene: async () => {
        calls.push('save-scene');
      },
      delay: async (milliseconds) => {
        calls.push(`delay-${milliseconds}`);
      },
      undoSource: 'cce.History',
      undo: async () => {
        calls.push('undo');
      },
      removeNode: async () => {
        calls.push('remove-node');
      }
    });

    expect(calls).toEqual([
      'create-node',
      'set-property',
      'save-scene',
      'delay-2000',
      'undo',
      'save-scene'
    ]);
    expect(result).toMatchObject({
      status: 'rolled-back',
      createdNodeUuid: 'created-node-1',
      rollbackMethod: 'undo',
      undoSource: 'cce.History'
    });
  });

  it('Undo 未移除节点时只显式删除当前事务创建的探针节点', async () => {
    let removed = false;
    const removeNode = vi.fn(async () => {
      removed = true;
    });
    const result = await executeProbeSceneOperation(transactionForScene(), {
      createNode: async () => 'created-node-1',
      createComponent: async () => undefined,
      setProperty: async () => undefined,
      queryNode: async () => removed
        ? null
        : creatorNodeDump({ x: 17, y: 23, z: 0 }),
      saveScene: async () => undefined,
      delay: async () => undefined,
      undoSource: 'cce.History',
      undo: async () => undefined,
      removeNode
    });

    expect(removeNode).toHaveBeenCalledWith({ uuid: 'created-node-1' });
    expect(result.rollbackMethod).toBe('explicit-remove');
  });
});

function createCoordinator(options: {
  store?: InMemoryProbeTransactionStore;
  revisions?: ProbeRevisionSnapshot[];
  execute?: ReturnType<typeof vi.fn>;
} = {}): ProbeTransactionCoordinator {
  const revisions = [...(options.revisions ?? [revisionSnapshot(), revisionSnapshot()])];
  return new ProbeTransactionCoordinator({
    store: options.store,
    currentProjectPath: () => ISOLATED_PROJECT,
    createTransactionId: () => 'transaction-1',
    now: () => new Date('2026-07-13T00:00:00.000Z'),
    captureRevision: async () => revisions.shift() ?? revisionSnapshot(),
    execute: options.execute ?? vi.fn(async () => executionResult())
  });
}

function prepareRequest() {
  return {
    projectPath: ISOLATED_PROJECT,
    documentAssetUuid: 'asset-1',
    probeName: 'CocosAiProbe_123'
  };
}

function revisionSnapshot(overrides: Partial<ProbeRevisionSnapshot> = {}): ProbeRevisionSnapshot {
  return {
    documentAssetUuid: 'asset-1',
    assetSha256: 'asset-sha-1',
    hierarchySha256: 'hierarchy-sha-1',
    dirty: false,
    parentNodeUuid: 'parent-node-1',
    existingProbeNodeUuid: null,
    ...overrides
  };
}

function executionResult() {
  return {
    status: 'rolled-back' as const,
    createdNodeUuid: 'created-node-1',
    diskHashRestored: true,
    recoveryMethod: 'none' as const,
    undoSource: 'test.undo',
    before: { probeExists: false },
    created: { probeExists: true },
    saved: { probeExists: true },
    rolledBack: { probeExists: false }
  };
}

function transactionForScene() {
  return {
    transactionId: 'transaction-1',
    parentNodeUuid: 'parent-node-1',
    probeName: 'CocosAiProbe_123',
    operation: {
      type: 'create-save-rollback-probe' as const,
      position: { x: 17 as const, y: 23 as const, z: 0 as const },
      component: 'cc.UITransform' as const,
      verificationPauseMs: 2000 as const
    }
  };
}

function creatorNodeDump(position: { x: number; y: number; z: number }) {
  return {
    uuid: { value: 'created-node-1' },
    name: { value: 'CocosAiProbe_123' },
    position: {
      name: 'position',
      type: 'cc.Vec3',
      value: position
    },
    __comps__: [{
      value: {
        type: 'cc.UITransform',
        uuid: { value: 'ui-transform-1' }
      }
    }]
  };
}
