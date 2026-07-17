import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendWriteJournalEntry,
  listWriteJournalTransactionIds,
  readWriteJournalEntries,
  type WriteJournalEntry
} from '../src/write-journal.js';

describe('write-journal 事务审计落盘', () => {
  let reportRoot = '';

  beforeEach(async () => {
    reportRoot = await mkdtemp(join(tmpdir(), 'write-journal-'));
  });

  afterEach(async () => {
    await rm(reportRoot, { recursive: true, force: true });
  });

  it('按事务追加审计条目并可完整读回', async () => {
    const first = journalEntry({ event: 'prepare' });
    const second = journalEntry({
      event: 'committed',
      verification: { passed: true, items: 1 },
      stateHistory: [{ state: 'validated' }, { state: 'committed' }]
    });

    await appendWriteJournalEntry(reportRoot, first);
    await appendWriteJournalEntry(reportRoot, second);

    const entries = await readWriteJournalEntries(reportRoot, 'tx-1');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ transactionId: 'tx-1', event: 'prepare', source: 'cli' });
    expect(entries[1]).toMatchObject({
      event: 'committed',
      verification: { passed: true, items: 1 },
      stateHistory: [{ state: 'validated' }, { state: 'committed' }]
    });
  });

  it('审计条目包含调用来源、参数、影响资源和状态历史', async () => {
    await appendWriteJournalEntry(reportRoot, journalEntry({
      request: { operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'New' }] },
      affectedResources: ['db://assets/ui/Main.prefab'],
      details: { undoGroup: 'rename-node' }
    }));

    const [entry] = await readWriteJournalEntries(reportRoot, 'tx-1');
    expect(entry.source).toBe('cli');
    expect(entry.request).toEqual({ operations: [{ type: 'node.rename', nodeUuid: 'n1', name: 'New' }] });
    expect(entry.affectedResources).toEqual(['db://assets/ui/Main.prefab']);
    expect(entry.details).toEqual({ undoGroup: 'rename-node' });
  });

  it('列出全部有审计记录的事务 id', async () => {
    await appendWriteJournalEntry(reportRoot, journalEntry({ transactionId: 'tx-1' }));
    await appendWriteJournalEntry(reportRoot, journalEntry({ transactionId: 'tx-2', idempotencyKey: 'key-2' }));

    const ids = await listWriteJournalTransactionIds(reportRoot);
    expect(ids.sort()).toEqual(['tx-1', 'tx-2']);
  });

  it('事务 id 拒绝路径穿越，落盘文件限制在授权报告根内', async () => {
    await expect(appendWriteJournalEntry(reportRoot, journalEntry({ transactionId: '../escape' })))
      .rejects.toThrow('WRITE_JOURNAL_INVALID_ID');
    await expect(appendWriteJournalEntry(reportRoot, journalEntry({ transactionId: 'a/b' })))
      .rejects.toThrow('WRITE_JOURNAL_INVALID_ID');
  });

  it('journal 文件为 JSONL，每行一个完整条目', async () => {
    await appendWriteJournalEntry(reportRoot, journalEntry({ event: 'prepare' }));
    await appendWriteJournalEntry(reportRoot, journalEntry({ event: 'committed' }));

    const raw = await readFile(join(reportRoot, 'write-journal', 'tx-1.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'prepare' });
    expect(JSON.parse(lines[1])).toMatchObject({ event: 'committed' });
  });
});

function journalEntry(overrides: Partial<WriteJournalEntry> = {}): WriteJournalEntry {
  return {
    transactionId: 'tx-1',
    idempotencyKey: 'key-1',
    at: '2026-07-17T00:00:00.000Z',
    event: 'prepare',
    source: 'cli',
    ...overrides
  };
}
