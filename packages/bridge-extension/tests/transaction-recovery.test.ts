import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryWriteTransactionStore,
  WriteTransactionManager,
  type RevisionFingerprint,
  type WriteTransactionRecord
} from '../src/transaction-manager.js';

describe('WriteTransactionManager 重连恢复', () => {
  it('Bridge 重连后按内容指纹分类未完成事务：基线未变判定 not-executed，不盲目续写', async () => {
    const manager = createHangingManager();
    const prepared = await manager.prepare(writeRequest());
    const interrupted = await manager.confirm({ transactionId: prepared.transactionId });
    expect(interrupted.status).toBe('outcome-unknown');

    const summary = await manager.recover(recoveryContext(), async () => baselineFingerprint());

    expect(summary.project).toEqual({ path: 'E:/probe-project', creatorVersion: '3.8.8' });
    expect(summary.document).toEqual({ documentId: 'doc-1' });
    expect(summary.unfinishedTransactions).toHaveLength(1);
    expect(summary.unfinishedTransactions[0]).toMatchObject({
      transactionId: prepared.transactionId,
      classification: 'not-executed',
      lastSuccessfulStep: 'executing',
      recommendedAction: 'none'
    });
    expect(summary.lastSuccessfulStep).toBe('executing');
    // 恢复摘要不提供从中断点继续的入口
    expect(summary.recommendedNextStep).not.toContain('续写');
  });

  it('指纹与基线不同且未经重读验证时判定 rollbackable，可经 transactionRollback 收口', async () => {
    const manager = createHangingManager();
    const prepared = await manager.prepare(writeRequest());
    await manager.confirm({ transactionId: prepared.transactionId });

    const summary = await manager.recover(recoveryContext(), async () => changedFingerprint());

    expect(summary.unfinishedTransactions[0]).toMatchObject({
      classification: 'rollbackable',
      recommendedAction: 'rollback'
    });
    expect(summary.recommendedNextStep).toContain('transactionRollback');

    const rolledBack = await manager.rollback({ transactionId: prepared.transactionId });
    expect(rolledBack.status).toBe('rolled-back');
    expect(rolledBack.rollbackEvidence?.verifiedClean).toBe(true);
  });

  it('重读验证已通过但断连丢失结果时判定 committed', async () => {
    const store = new InMemoryWriteTransactionStore();
    seedRecord(store, {
      transactionId: 'tx-verified',
      state: 'outcome-unknown',
      verification: {
        passed: true,
        verifiedAt: '2026-07-17T00:00:01.000Z',
        items: []
      }
    });
    const manager = createHangingManager({ store });

    const summary = await manager.recover(recoveryContext(), async () => changedFingerprint());

    expect(summary.unfinishedTransactions[0]).toMatchObject({
      transactionId: 'tx-verified',
      classification: 'committed',
      recommendedAction: 'none'
    });
    expect(store.get('tx-verified')?.state).toBe('committed');
  });

  it('指纹采集失败时判定 manual-recovery-required，推荐人工处理', async () => {
    const manager = createHangingManager();
    const prepared = await manager.prepare(writeRequest());
    await manager.confirm({ transactionId: prepared.transactionId });

    const summary = await manager.recover(recoveryContext(), async () => {
      throw new Error('DOCUMENT_RELOAD_FAILED');
    });

    expect(summary.unfinishedTransactions[0]).toMatchObject({
      classification: 'manual-recovery-required',
      recommendedAction: 'manual'
    });
    expect(summary.recommendedNextStep).toContain('人工');
  });

  it('已完成事务不进入恢复摘要', async () => {
    const store = new InMemoryWriteTransactionStore();
    seedRecord(store, { transactionId: 'tx-done', state: 'committed' });
    const manager = createHangingManager({ store });

    const summary = await manager.recover(recoveryContext(), async () => baselineFingerprint());

    expect(summary.unfinishedTransactions).toHaveLength(0);
    expect(summary.recommendedNextStep).toContain('无待处理');
  });
});

function createHangingManager(options: { store?: InMemoryWriteTransactionStore } = {}): WriteTransactionManager {
  return new WriteTransactionManager({
    store: options.store,
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    delay: async () => {},
    executionTimeoutMs: 1,
    captureRevision: async () => ({ documentId: 'doc-1', fingerprint: baselineFingerprint() }),
    execute: () => new Promise(() => {}),
    rollback: vi.fn(async () => ({
      attempted: true,
      succeeded: true,
      undoGroupId: 'undo-group-1',
      verifiedClean: true
    }))
  });
}

function writeRequest() {
  return {
    transactionId: 'tx-1',
    idempotencyKey: 'key-1',
    scope: 'current-document' as const,
    revision: baselineFingerprint(),
    operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'NewName' }],
    save: true,
    undoGroup: 'rename-node'
  };
}

function recoveryContext() {
  return {
    projectPath: 'E:/probe-project',
    documentId: 'doc-1',
    creatorVersion: '3.8.8' as string | null
  };
}

function baselineFingerprint(): RevisionFingerprint {
  return { document: 'sha256:doc', hierarchy: 'sha256:hier', assetDatabase: null, scriptCompilation: null };
}

function changedFingerprint(): RevisionFingerprint {
  return { document: 'sha256:changed', hierarchy: 'sha256:hier', assetDatabase: null, scriptCompilation: null };
}

function seedRecord(store: InMemoryWriteTransactionStore, overrides: Partial<WriteTransactionRecord>): void {
  const record: WriteTransactionRecord = {
    transactionId: 'tx-seed',
    idempotencyKey: 'key-seed',
    requestHash: 'hash',
    scope: 'current-document',
    documentId: 'doc-1',
    state: 'outcome-unknown',
    request: writeRequest(),
    executedOps: 1,
    verification: null,
    failure: null,
    rollbackEvidence: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-17T00:30:00.000Z',
    stateHistory: [
      { state: 'validated', at: '2026-07-17T00:00:00.000Z' },
      { state: 'executing', at: '2026-07-17T00:00:01.000Z' },
      { state: 'outcome-unknown', at: '2026-07-17T00:00:02.000Z' }
    ],
    ...overrides
  };
  store.set(record);
}
