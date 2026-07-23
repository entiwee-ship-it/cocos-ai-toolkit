import { describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../src/probe-errors.js';
import {
  InMemoryWriteTransactionStore,
  WriteTransactionManager,
  type WriteExecutionOutcome,
  type WriteRevisionCapture,
  type WriteRollbackEvidence,
  type WriteTransactionRequest
} from '../src/transaction-manager.js';

describe('validateWriteTransactionRequest（经 prepare 触发）', () => {
  it('拒绝缺少幂等键的写事务请求', async () => {
    const manager = createManager();
    await expect(manager.prepare(writeRequest({ idempotencyKey: '' })))
      .rejects.toThrow('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('阶段三作用域缺影响分析时拒绝，携带影响分析时放行；空操作列表拒绝', async () => {
    const manager = createManager();
    await expect(manager.prepare(writeRequest({ scope: 'source-prefab' })))
      .rejects.toThrow('PREFAB_IMPACT_ANALYSIS_REQUIRED');
    await expect(manager.prepare(writeRequest({
      scope: 'source-prefab',
      impactAnalysis: { sourceAssetUuid: 'a1' }
    }))).resolves.toMatchObject({ status: 'validated' });
    await expect(manager.prepare(writeRequest({ operations: [] })))
      .rejects.toThrow('INVALID_WRITE_OPERATIONS');
  });

  it('含应用到源操作但缺 revision.prefabGraph 时拒绝', async () => {
    const manager = createManager();
    await expect(manager.prepare(writeRequest({
      scope: 'apply-to-source',
      impactAnalysis: { sourceAssetUuid: 'a1' },
      operations: [{ type: 'prefab.apply_to_source', instanceRootUuid: 'n1' }]
    }))).rejects.toThrow('PREFAB_GRAPH_REVISION_REQUIRED');
    const managerWithGraph = createManager({
      captureRevision: async () => revisionCapture({ fingerprint: fingerprint({ prefabGraph: 'sha256:p' }) })
    });
    await expect(managerWithGraph.prepare(writeRequest({
      scope: 'apply-to-source',
      impactAnalysis: { sourceAssetUuid: 'a1' },
      revision: fingerprint({ prefabGraph: 'sha256:p' }),
      operations: [{ type: 'prefab.apply_to_source', instanceRootUuid: 'n1' }]
    }))).resolves.toMatchObject({ status: 'validated' });
  });

  it('拒绝未知操作类型和缺少必填字段的操作', async () => {
    const manager = createManager();
    await expect(manager.prepare(writeRequest({
      operations: [{ type: 'prefab.instantiate', nodeUuid: 'n1' }]
    }))).rejects.toThrow('INVALID_WRITE_OPERATION');
    await expect(manager.prepare(writeRequest({
      operations: [{ type: 'node.rename', nodeUuid: 'n1' }]
    }))).rejects.toThrow('INVALID_WRITE_OPERATION');
  });

  it('接受节点与组件原子操作的最小合法请求', async () => {
    const manager = createManager();
    const result = await manager.prepare(writeRequest({
      operations: [
        { type: 'node.create', parentNodeUuid: 'root', name: 'TempNode' },
        { type: 'component.set_property', componentUuid: 'c1', propertyPath: 'items[2]', value: 1 },
        { type: 'component.set_reference', componentUuid: 'c1', propertyPath: 'clickEvents[0].target', reference: { kind: 'node', objectUuid: 'n9' } }
      ]
    }));
    expect(result.status).toBe('validated');
  });
});

describe('WriteTransactionManager 幂等', () => {
  it('相同幂等键重试返回原事务状态，不重复执行', async () => {
    const execute = vi.fn(async () => successOutcome());
    const captureRevision = vi.fn(async () => revisionCapture());
    const manager = createManager({ captureRevision, execute });

    const prepared = await manager.prepare(writeRequest());
    const confirmed = await manager.confirm({ transactionId: prepared.transactionId });
    expect(confirmed.status).toBe('committed');

    const retried = await manager.prepare(writeRequest());
    expect(retried.transactionId).toBe(prepared.transactionId);
    expect(retried.duplicateOf).toBe(prepared.transactionId);
    expect(retried.status).toBe('committed');
    expect(execute).toHaveBeenCalledTimes(1);
    // prepare 与 confirm 各采集一次 Revision；幂等重试短路与采集无关
    expect(captureRevision).toHaveBeenCalledTimes(2);
  });

  it('相同幂等键携带不同负载时拒绝', async () => {
    const manager = createManager();
    await manager.prepare(writeRequest());

    await expect(manager.prepare(writeRequest({ undoGroup: 'other-group' })))
      .rejects.toThrow('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('confirm 重试返回原结果，不重复执行', async () => {
    const execute = vi.fn(async () => successOutcome());
    const manager = createManager({ execute });
    const prepared = await manager.prepare(writeRequest());

    const first = await manager.confirm({ transactionId: prepared.transactionId });
    const retried = await manager.confirm({ transactionId: prepared.transactionId });

    expect(retried).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('WriteTransactionManager Revision 前置', () => {
  it('prepare 与 confirm 都拒绝 Creator 标记为 dirty 的文档', async () => {
    const prepareManager = createManager({
      captureRevision: async () => revisionCapture({ dirty: true })
    });
    await expect(prepareManager.prepare(writeRequest())).rejects.toThrow('DIRTY_DOCUMENT');

    const execute = vi.fn(async () => successOutcome());
    const captureRevision = vi.fn()
      .mockResolvedValueOnce(revisionCapture({ dirty: false }))
      .mockResolvedValueOnce(revisionCapture({ dirty: true }));
    const confirmManager = createManager({ captureRevision, execute });
    const prepared = await confirmManager.prepare(writeRequest());

    await expect(confirmManager.confirm({ transactionId: prepared.transactionId }))
      .rejects.toThrow('DIRTY_DOCUMENT');
    expect(execute).not.toHaveBeenCalled();
  });

  it('Revision 前置不一致时拒绝执行并返回冲突范围、旧值和当前值', async () => {
    const execute = vi.fn(async () => successOutcome());
    // prepare 时指纹一致，confirm 前文档指纹被人工修改
    const captureRevision = vi.fn()
      .mockResolvedValueOnce(revisionCapture())
      .mockResolvedValueOnce(revisionCapture({ fingerprint: fingerprint({ document: 'sha256:new' }) }));
    const manager = createManager({ captureRevision, execute });
    const prepared = await manager.prepare(writeRequest());

    const error = await manager.confirm({ transactionId: prepared.transactionId })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProbeError);
    expect((error as ProbeError).code).toBe('REVISION_CONFLICT');
    expect((error as ProbeError).details.conflicts).toEqual([
      { scope: 'document', expected: 'sha256:doc', actual: 'sha256:new' }
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('Revision 前置为 null 的维度不参与校验', async () => {
    const execute = vi.fn(async () => successOutcome());
    const manager = createManager({ execute });
    const prepared = await manager.prepare(writeRequest({
      revision: { document: null, hierarchy: null, assetDatabase: null, scriptCompilation: null }
    }));

    const result = await manager.confirm({ transactionId: prepared.transactionId });
    expect(result.status).toBe('committed');
  });
});

describe('WriteTransactionManager 文档锁', () => {
  it('同一文档已有活动事务时拒绝新事务', async () => {
    const manager = createManager();
    await manager.prepare(writeRequest());

    await expect(manager.prepare(writeRequest({
      transactionId: 'tx-2',
      idempotencyKey: 'key-2'
    }))).rejects.toThrow('DOCUMENT_LOCKED');
  });

  it('前一事务进入终态后释放文档锁', async () => {
    const manager = createManager();
    const prepared = await manager.prepare(writeRequest());
    await manager.confirm({ transactionId: prepared.transactionId });

    const second = await manager.prepare(writeRequest({
      transactionId: 'tx-2',
      idempotencyKey: 'key-2'
    }));
    expect(second.status).toBe('validated');
  });
});

describe('WriteTransactionManager 执行与回滚', () => {
  it('保存后重读验证通过才允许 committed', async () => {
    const manager = createManager();
    const prepared = await manager.prepare(writeRequest());
    const result = await manager.confirm({ transactionId: prepared.transactionId });

    expect(result.status).toBe('committed');
    expect(result.executedOps).toBe(1);
    expect(result.verification?.passed).toBe(true);
    expect(result.rollbackEvidence).toBeNull();
  });

  it('executor 成功但缺少通过的重读验证时转入失败并回滚', async () => {
    const rollback = vi.fn(async () => cleanEvidence());
    const manager = createManager({
      execute: vi.fn(async (): Promise<WriteExecutionOutcome> => ({
        kind: 'success',
        executedOps: 1,
        verification: null
      })),
      rollback
    });
    const prepared = await manager.prepare(writeRequest());
    const result = await manager.confirm({ transactionId: prepared.transactionId });

    expect(result.status).toBe('rolled-back');
    expect(result.failure?.code).toBe('WRITE_VERIFICATION_FAILED');
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('操作失败时自动回滚并附回滚证据', async () => {
    const manager = createManager({
      execute: vi.fn(async (): Promise<WriteExecutionOutcome> => ({
        kind: 'operation-failed',
        executedOps: 0,
        failure: { code: 'NODE_NOT_FOUND', message: '目标节点不存在', operationIndex: 0 }
      }))
    });
    const prepared = await manager.prepare(writeRequest());
    const result = await manager.confirm({ transactionId: prepared.transactionId });

    expect(result.status).toBe('rolled-back');
    expect(result.failure?.code).toBe('NODE_NOT_FOUND');
    expect(result.rollbackEvidence).toEqual(cleanEvidence());
  });

  it('回滚后重读不干净时转人工恢复', async () => {
    const manager = createManager({
      execute: vi.fn(async (): Promise<WriteExecutionOutcome> => ({
        kind: 'operation-failed',
        executedOps: 1,
        failure: { code: 'NODE_NOT_FOUND', message: '目标节点不存在', operationIndex: 1 }
      })),
      rollback: vi.fn(async (): Promise<WriteRollbackEvidence> => ({
        attempted: true,
        succeeded: true,
        undoGroupId: null,
        verifiedClean: false
      }))
    });
    const prepared = await manager.prepare(writeRequest());
    const result = await manager.confirm({ transactionId: prepared.transactionId });

    expect(result.status).toBe('manual-recovery-required');
  });

  it('手动回滚已提交事务', async () => {
    const rollback = vi.fn(async () => cleanEvidence());
    const manager = createManager({ rollback });
    const prepared = await manager.prepare(writeRequest());
    await manager.confirm({ transactionId: prepared.transactionId });

    const result = await manager.rollback({ transactionId: prepared.transactionId });
    expect(result.status).toBe('rolled-back');
    expect(result.rollbackEvidence?.verifiedClean).toBe(true);
  });

  it('未提交事务禁止手动回滚', async () => {
    const manager = createManager();
    const prepared = await manager.prepare(writeRequest());

    await expect(manager.rollback({ transactionId: prepared.transactionId }))
      .rejects.toThrow('INVALID_STATE_TRANSITION');
  });
});

describe('WriteTransactionManager 超时与未知结局', () => {
  it('执行超时标记 outcome-unknown，禁止盲目重试写入', async () => {
    const execute = vi.fn(() => new Promise<WriteExecutionOutcome>(() => {}));
    const manager = createManager({
      execute,
      delay: async () => {},
      executionTimeoutMs: 1
    });
    const prepared = await manager.prepare(writeRequest());
    const result = await manager.confirm({ transactionId: prepared.transactionId });

    expect(result.status).toBe('outcome-unknown');

    const retried = await manager.prepare(writeRequest());
    expect(retried.status).toBe('outcome-unknown');
    expect(retried.duplicateOf).toBe(prepared.transactionId);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('executor 抛未知异常时标记 outcome-unknown', async () => {
    const manager = createManager({
      execute: vi.fn(async () => {
        throw new Error('CREATOR_WRITE_INTERRUPTED');
      })
    });
    const prepared = await manager.prepare(writeRequest());
    const result = await manager.confirm({ transactionId: prepared.transactionId });

    expect(result.status).toBe('outcome-unknown');
    expect(result.failure?.code).toBe('CREATOR_WRITE_INTERRUPTED');
  });

  it('超时后 executor 晚到的结果只记入状态历史，不改变 outcome-unknown', async () => {
    const store = new InMemoryWriteTransactionStore();
    let settle: ((outcome: WriteExecutionOutcome) => void) | null = null;
    const execute = vi.fn(() => new Promise<WriteExecutionOutcome>((resolve) => {
      settle = resolve;
    }));
    const manager = createManager({
      store,
      execute,
      delay: async () => {},
      executionTimeoutMs: 1
    });
    const prepared = await manager.prepare(writeRequest());
    const result = await manager.confirm({ transactionId: prepared.transactionId });
    expect(result.status).toBe('outcome-unknown');

    settle?.(successOutcome());
    await new Promise((resolve) => setImmediate(resolve));

    const record = store.get(prepared.transactionId);
    expect(record?.state).toBe('outcome-unknown');
    expect(record?.stateHistory.some((entry) => entry.state === 'committed' && entry.reason === 'executor-settled-late')).toBe(true);
  });
});

describe('WriteTransactionManager 过期与列表', () => {
  it('过期事务拒绝 confirm', async () => {
    const manager = createManager({
      now: sequenceNow([
        new Date('2026-07-17T00:00:00.000Z'),
        new Date('2026-07-17T01:00:00.000Z')
      ])
    });
    const prepared = await manager.prepare(writeRequest());

    await expect(manager.confirm({ transactionId: prepared.transactionId }))
      .rejects.toThrow('TRANSACTION_EXPIRED');
  });

  it('提交路径输出事务级日志', async () => {
    const logger = vi.fn();
    const manager = createManager({ logger });
    const prepared = await manager.prepare(writeRequest());
    await manager.confirm({ transactionId: prepared.transactionId });

    const messages = logger.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('事务 tx-1 已登记'))).toBe(true);
    expect(messages.some((message) => message.includes('事务 tx-1 开始执行'))).toBe(true);
    expect(messages.some((message) => message.includes('事务 tx-1 已提交'))).toBe(true);
  });

  it('失败回滚和结果未知路径输出事务级日志', async () => {
    const logger = vi.fn();
    const failedManager = createManager({
      logger,
      execute: vi.fn(async (): Promise<WriteExecutionOutcome> => ({
        kind: 'operation-failed',
        executedOps: 0,
        failure: { code: 'NODE_NOT_FOUND', message: '目标节点不存在', operationIndex: 0 }
      }))
    });
    const prepared = await failedManager.prepare(writeRequest());
    await failedManager.confirm({ transactionId: prepared.transactionId });

    const failedMessages = logger.mock.calls.map((call) => String(call[0]));
    expect(failedMessages.some((message) => message.includes('已回滚并验证干净'))).toBe(true);

    const unknownLogger = vi.fn();
    const unknownManager = createManager({
      logger: unknownLogger,
      execute: vi.fn(async () => {
        throw new Error('CREATOR_WRITE_INTERRUPTED');
      })
    });
    const unknownPrepared = await unknownManager.prepare(writeRequest());
    await unknownManager.confirm({ transactionId: unknownPrepared.transactionId });

    const unknownMessages = unknownLogger.mock.calls.map((call) => String(call[0]));
    expect(unknownMessages.some((message) => message.includes('结果未知'))).toBe(true);
  });

  it('transactionList 只列未完成事务', async () => {
    const manager = createManager();
    const first = await manager.prepare(writeRequest());
    await manager.confirm({ transactionId: first.transactionId });
    await manager.prepare(writeRequest({ transactionId: 'tx-2', idempotencyKey: 'key-2' }));

    const list = manager.list();
    expect(list.map((item) => item.transactionId)).toEqual(['tx-2']);
  });

  it('未知事务拒绝 status 和 confirm', async () => {
    const manager = createManager();
    expect(() => manager.status({ transactionId: 'missing' })).toThrow('TRANSACTION_NOT_FOUND');
    await expect(manager.confirm({ transactionId: 'missing' })).rejects.toThrow('TRANSACTION_NOT_FOUND');
  });
});

function createManager(options: {
  store?: InMemoryWriteTransactionStore;
  now?: () => Date;
  delay?: (ms: number) => Promise<void>;
  executionTimeoutMs?: number;
  logger?: (message: string) => void;
  captureRevision?: (request: WriteTransactionRequest) => Promise<WriteRevisionCapture>;
  execute?: (transaction: never) => Promise<WriteExecutionOutcome>;
  rollback?: (transaction: never) => Promise<WriteRollbackEvidence>;
} = {}): WriteTransactionManager {
  return new WriteTransactionManager({
    store: options.store,
    now: options.now ?? (() => new Date('2026-07-17T00:00:00.000Z')),
    delay: options.delay ?? (() => new Promise<void>(() => {})),
    executionTimeoutMs: options.executionTimeoutMs,
    logger: options.logger,
    captureRevision: options.captureRevision ?? (async () => revisionCapture()),
    execute: options.execute ?? (vi.fn(async () => successOutcome()) as never),
    rollback: options.rollback ?? (vi.fn(async () => cleanEvidence()) as never)
  });
}

function writeRequest(overrides: Record<string, unknown> = {}): WriteTransactionRequest {
  return {
    transactionId: 'tx-1',
    idempotencyKey: 'key-1',
    scope: 'current-document',
    revision: fingerprint(),
    operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
    save: true,
    undoGroup: 'rename-node',
    ...overrides
  } as WriteTransactionRequest;
}

function fingerprint(overrides: Partial<WriteRevisionCapture['fingerprint']> = {}) {
  return {
    document: 'sha256:doc',
    hierarchy: 'sha256:hier',
    assetDatabase: null,
    scriptCompilation: null,
    ...overrides
  };
}

function revisionCapture(overrides: Partial<WriteRevisionCapture> = {}): WriteRevisionCapture {
  return {
    documentId: 'doc-asset-uuid-1',
    fingerprint: fingerprint(),
    ...overrides
  };
}

function successOutcome(): WriteExecutionOutcome {
  return {
    kind: 'success',
    executedOps: 1,
    verification: {
      passed: true,
      verifiedAt: '2026-07-17T00:00:01.000Z',
      items: [{ operationIndex: 0, description: '节点重命名', expected: 'NewName', actual: 'NewName', passed: true }]
    }
  };
}

function cleanEvidence(): WriteRollbackEvidence {
  return {
    attempted: true,
    succeeded: true,
    undoGroupId: 'undo-group-1',
    verifiedClean: true
  };
}

function sequenceNow(dates: Date[]): () => Date {
  const queue = [...dates];
  return () => queue.shift() ?? dates[dates.length - 1];
}
