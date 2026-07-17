import { appendFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 写事务审计条目。记录调用来源、参数（计划）、影响资源、验证结果和状态历史，
 * 供重连恢复、人工核查和阶段验收留证。
 */
export interface WriteJournalEntry {
  transactionId: string;
  idempotencyKey: string;
  at: string;
  event: string;
  source: string;
  request?: unknown;
  affectedResources?: string[];
  verification?: unknown;
  stateHistory?: unknown;
  details?: unknown;
}

const JOURNAL_DIRECTORY = 'write-journal';
const JOURNAL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 向授权报告根追加一条事务审计（JSONL，每行一个完整条目）。
 *
 * @param reportRoot 调用方授权的报告根目录。
 * @param entry 审计条目。
 * @returns 落盘的 journal 文件路径。
 */
export async function appendWriteJournalEntry(
  reportRoot: string,
  entry: WriteJournalEntry
): Promise<string> {
  const journalPath = await resolveJournalPath(reportRoot, entry.transactionId);
  await appendFile(journalPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return journalPath;
}

/**
 * 按事务 id 读回全部审计条目，顺序与写入一致。
 *
 * @param reportRoot 调用方授权的报告根目录。
 * @param transactionId 事务 id。
 * @returns 审计条目序列；无记录时返回空数组。
 */
export async function readWriteJournalEntries(
  reportRoot: string,
  transactionId: string
): Promise<WriteJournalEntry[]> {
  const journalPath = await resolveJournalPath(reportRoot, transactionId);
  let raw = '';
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WriteJournalEntry);
}

/**
 * 列出授权报告根内有审计记录的全部事务 id。
 *
 * @param reportRoot 调用方授权的报告根目录。
 * @returns 事务 id 列表；journal 目录不存在时返回空数组。
 */
export async function listWriteJournalTransactionIds(reportRoot: string): Promise<string[]> {
  const journalDirectory = join(await realpath(reportRoot), JOURNAL_DIRECTORY);
  let files: string[] = [];
  try {
    files = await readdir(journalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => file.slice(0, -'.jsonl'.length));
}

/**
 * 把事务 id 解析为授权报告根内的 journal 路径。
 * id 只允许字母数字和 ._-，杜绝路径穿越；目录在写入前创建。
 */
async function resolveJournalPath(reportRoot: string, transactionId: string): Promise<string> {
  if (!JOURNAL_ID_PATTERN.test(transactionId)) {
    throw new Error('WRITE_JOURNAL_INVALID_ID');
  }
  const journalDirectory = join(await realpath(reportRoot), JOURNAL_DIRECTORY);
  await mkdir(journalDirectory, { recursive: true });
  return join(journalDirectory, `${transactionId}.jsonl`);
}
