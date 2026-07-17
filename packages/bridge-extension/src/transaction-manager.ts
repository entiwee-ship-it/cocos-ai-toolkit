import { createHash } from 'node:crypto';
import { ProbeError } from './probe-errors';

/**
 * 阶段二通用写事务状态机，与协议包 TransactionStateSchema 保持一致。
 * draft/planned 属于调用方侧状态，Bridge 内事务从 validated 开始记录。
 * connection-lost/recovering 为 Task 7 断连恢复链路预留。
 */
export type WriteTransactionState =
  | 'draft' | 'planned' | 'validated' | 'locked' | 'executing' | 'saving' | 'verifying' | 'committed'
  | 'failed' | 'rolling-back' | 'rolled-back'
  | 'connection-lost' | 'outcome-unknown' | 'recovering' | 'manual-recovery-required';

/**
 * 写事务执行前的修订前置。四个维度分别对应文档内容、层级结构、资产数据库和脚本编译状态的指纹；
 * 为 null 表示该维度不参与前置校验。
 */
export interface RevisionFingerprint {
  document: string | null;
  hierarchy: string | null;
  assetDatabase: string | null;
  scriptCompilation: string | null;
}

/**
 * 桥内写操作的最小结构。逐类型字段校验见 validateWriteTransactionRequest，
 * 字段语义与协议包 WriteOperationSchema 保持一致。
 */
export interface WriteOperation {
  type: string;
  [field: string]: unknown;
}

export interface WriteTransactionRequest {
  transactionId: string;
  idempotencyKey: string;
  scope: 'current-document';
  revision: RevisionFingerprint;
  operations: WriteOperation[];
  save: boolean;
  undoGroup: string;
}

export interface WriteVerificationItem {
  operationIndex: number;
  description: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export interface WriteVerificationReport {
  passed: boolean;
  verifiedAt: string;
  items: WriteVerificationItem[];
}

export interface WriteConflict {
  scope: string;
  expected: unknown;
  actual: unknown;
}

export interface WriteFailure {
  code: string;
  message: string;
  operationIndex?: number | null;
  conflicts?: WriteConflict[];
  details?: unknown;
}

export interface WriteRollbackEvidence {
  attempted: boolean;
  succeeded: boolean | null;
  undoGroupId?: string | null;
  verifiedClean: boolean | null;
}

export interface WriteTransactionResult {
  transactionId: string;
  status: WriteTransactionState;
  /** 幂等重试命中时标记原始事务 id，调用方据此识别本次为重复请求。 */
  duplicateOf?: string;
  executedOps: number;
  verification: WriteVerificationReport | null;
  failure: WriteFailure | null;
  rollbackEvidence: WriteRollbackEvidence | null;
}

export interface WriteTransactionStateEntry {
  state: WriteTransactionState;
  at: string;
  reason?: string;
}

export interface WriteTransactionRecord {
  transactionId: string;
  idempotencyKey: string;
  /** 归一化请求的 sha256，用于识别同幂等键不同负载的误用。 */
  requestHash: string;
  scope: 'current-document';
  /** captureRevision 返回的当前文档标识，是文档级锁的键。 */
  documentId: string;
  state: WriteTransactionState;
  request: WriteTransactionRequest;
  executedOps: number;
  /** 逐操作执行证据（含逆操作），execute 返回时写入，供回滚编排和审计。 */
  executionEvidence?: unknown;
  verification: WriteVerificationReport | null;
  failure: WriteFailure | null;
  rollbackEvidence: WriteRollbackEvidence | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  stateHistory: WriteTransactionStateEntry[];
}

export interface WriteRevisionCapture {
  documentId: string;
  fingerprint: RevisionFingerprint;
}

/**
 * 写执行器的确定性结果。操作级失败以数据形式返回（触发回滚流程）；
 * 抛出异常一律视为结局未知（outcome-unknown），不做任何乐观假设。
 * evidence 为逐操作执行证据（含逆操作），随事务记录留存，供回滚编排和审计。
 */
export type WriteExecutionOutcome =
  | { kind: 'success'; executedOps: number; verification: WriteVerificationReport | null; undoGroupId?: string | null; evidence?: unknown }
  | { kind: 'operation-failed'; executedOps: number; failure: WriteFailure; undoGroupId?: string | null; evidence?: unknown };

/**
 * 3.8.8 实测确认 `cce.SceneFacadeManager.undo()` 可用（Phase 0 证据），但编辑器 Undo 分组能力
 * 尚未实测（见 docs/creator-3.8.8-capability-matrix.md）。实测通过前默认走
 * step-undo-with-inverse（显式逆操作 + 逐条 Undo 兜底 + 重读验证还原）。
 */
export type WriteUndoCapability = 'editor-undo-group' | 'step-undo-with-inverse';

export interface WriteExecutionContext {
  undoCapability: WriteUndoCapability;
}

export interface WriteTransactionStore {
  get(transactionId: string): WriteTransactionRecord | undefined;
  getByIdempotencyKey(idempotencyKey: string): WriteTransactionRecord | undefined;
  set(record: WriteTransactionRecord): void;
  list(): WriteTransactionRecord[];
}

export class InMemoryWriteTransactionStore implements WriteTransactionStore {
  private readonly byId = new Map<string, WriteTransactionRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();

  get(transactionId: string): WriteTransactionRecord | undefined {
    const record = this.byId.get(transactionId);
    return record ? cloneRecord(record) : undefined;
  }

  getByIdempotencyKey(idempotencyKey: string): WriteTransactionRecord | undefined {
    const transactionId = this.byIdempotencyKey.get(idempotencyKey);
    return transactionId ? this.get(transactionId) : undefined;
  }

  set(record: WriteTransactionRecord): void {
    this.byId.set(record.transactionId, cloneRecord(record));
    this.byIdempotencyKey.set(record.idempotencyKey, record.transactionId);
  }

  list(): WriteTransactionRecord[] {
    return [...this.byId.values()].map((record) => cloneRecord(record));
  }
}

export interface WriteTransactionManagerOptions {
  store?: WriteTransactionStore;
  now?: () => Date;
  delay?: (ms: number) => Promise<void>;
  /** 事务从 prepare 到 confirm 的有效期，默认 30 分钟。 */
  ttlMs?: number;
  /** 单次 confirm 执行窗口，超时标记 outcome-unknown，默认 120 秒。 */
  executionTimeoutMs?: number;
  undoCapability?: WriteUndoCapability;
  captureRevision: (request: WriteTransactionRequest) => Promise<WriteRevisionCapture>;
  execute: (transaction: WriteTransactionRecord, context: WriteExecutionContext) => Promise<WriteExecutionOutcome>;
  rollback: (transaction: WriteTransactionRecord, context: WriteExecutionContext) => Promise<WriteRollbackEvidence>;
}

/** 重连恢复时的项目/文档上下文（由 main.ts 按当前编辑器状态提供）。 */
export interface WriteRecoveryContext {
  projectPath: string;
  documentId: string;
  creatorVersion: string | null;
}

/** 未完成事务的恢复分类，与设计规格 13.4 对齐。 */
export type WriteRecoveryClassification =
  | 'committed'
  | 'not-executed'
  | 'rollbackable'
  | 'manual-recovery-required';

export interface WriteRecoveredTransaction {
  transactionId: string;
  classification: WriteRecoveryClassification;
  state: WriteTransactionState;
  lastSuccessfulStep: WriteTransactionState | null;
  recommendedAction: 'none' | 'rollback' | 'manual';
}

/** 恢复摘要：当前项目、文档、未完成事务、最近成功步骤和推荐安全下一步。不提供从中断点续写入口。 */
export interface WriteRecoverySummary {
  project: { path: string; creatorVersion: string | null };
  document: { documentId: string };
  unfinishedTransactions: WriteRecoveredTransaction[];
  lastSuccessfulStep: WriteTransactionState | null;
  recommendedNextStep: string;
}

/** 状态机合法转移表；恢复链路（connection-lost/recovering）在 Task 7 接线。 */
const STATE_TRANSITIONS: Record<WriteTransactionState, WriteTransactionState[]> = {
  draft: ['planned'],
  planned: ['validated'],
  validated: ['locked', 'failed'],
  locked: ['executing', 'failed'],
  executing: ['saving', 'verifying', 'failed', 'outcome-unknown', 'connection-lost', 'recovering'],
  saving: ['verifying', 'failed', 'outcome-unknown', 'connection-lost', 'recovering'],
  verifying: ['committed', 'failed', 'outcome-unknown', 'recovering'],
  committed: ['rolling-back'],
  failed: ['rolling-back'],
  'rolling-back': ['rolled-back', 'manual-recovery-required'],
  'rolled-back': [],
  'connection-lost': ['recovering'],
  'outcome-unknown': ['recovering'],
  recovering: ['committed', 'failed', 'rolled-back', 'manual-recovery-required'],
  'manual-recovery-required': []
};

/** transactionList 视为未完成的状态：终态（committed/failed/rolled-back）之外的全部。 */
const FINISHED_STATES: WriteTransactionState[] = ['committed', 'failed', 'rolled-back'];

/** 重连恢复需要处理的状态；validated/locked 尚未执行，可直接 confirm 或等待过期，不参与恢复。 */
const RECOVERABLE_STATES: WriteTransactionState[] = [
  'executing', 'saving', 'verifying', 'connection-lost', 'outcome-unknown', 'recovering', 'manual-recovery-required'
];

/** 推进成功步骤的状态序列，用于恢复摘要的最近成功步骤。 */
const SUCCESS_STEP_STATES: WriteTransactionState[] = ['validated', 'locked', 'executing', 'saving', 'verifying', 'committed'];

/** 释放文档锁的状态。outcome-unknown 也释放：后续事务靠 Revision 前置兜底冲突，避免文档被永久锁死。 */
const LOCK_RELEASE_STATES: WriteTransactionState[] = [
  'committed', 'failed', 'rolled-back', 'outcome-unknown', 'manual-recovery-required'
];

const REVISION_SCOPES = ['document', 'hierarchy', 'assetDatabase', 'scriptCompilation'] as const;

/**
 * 阶段二通用事务管理器。编辑器无关：Revision 采集、写执行和回滚全部依赖注入，
 * 由 main.ts 在 Task 3+ 接到 Scene/AssetDB 真实实现。
 */
export class WriteTransactionManager {
  private readonly store: WriteTransactionStore;
  private readonly now: () => Date;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly ttlMs: number;
  private readonly executionTimeoutMs: number;
  private readonly undoCapability: WriteUndoCapability;
  private readonly documentLocks = new Map<string, string>();

  constructor(private readonly options: WriteTransactionManagerOptions) {
    this.store = options.store ?? new InMemoryWriteTransactionStore();
    this.now = options.now ?? (() => new Date());
    this.delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.executionTimeoutMs = options.executionTimeoutMs ?? 120_000;
    this.undoCapability = options.undoCapability ?? 'step-undo-with-inverse';
  }

  /**
   * 校验请求并按幂等键去重，采集 Revision 前置并登记事务（validated）。
   *
   * @param value 外部传入的写事务请求。
   * @returns 事务当前结果；幂等重试时带 duplicateOf。
   */
  async prepare(value: unknown): Promise<WriteTransactionResult> {
    const request = validateWriteTransactionRequest(value);
    const requestHash = hashWriteRequest(request);
    const existing = this.store.getByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ProbeError('IDEMPOTENCY_PAYLOAD_MISMATCH', { idempotencyKey: request.idempotencyKey });
      }
      return toResult(existing, existing.transactionId);
    }

    const capture = await this.options.captureRevision(request);
    checkRevisionPrecondition(request.revision, capture.fingerprint);
    this.acquireDocumentLock(capture.documentId, request.transactionId);

    const now = this.now();
    const record: WriteTransactionRecord = {
      transactionId: request.transactionId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      scope: request.scope,
      documentId: capture.documentId,
      state: 'validated',
      request,
      executedOps: 0,
      verification: null,
      failure: null,
      rollbackEvidence: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      stateHistory: [{ state: 'validated', at: now.toISOString(), reason: 'prepare' }]
    };
    this.store.set(record);
    return toResult(record);
  }

  /**
   * 确认并执行事务：复查 Revision 前置、加锁、执行、按需回滚。
   * 结局未知（超时/未知异常）时返回 outcome-unknown，绝不盲目重试写入。
   *
   * @param value 含 transactionId 的确认请求。
   * @returns 事务当前结果；已确认过的事务幂等返回当前状态。
   */
  async confirm(value: unknown): Promise<WriteTransactionResult> {
    const { transactionId } = validateTransactionIdRequest(value);
    let record = this.requireTransaction(transactionId);
    if (record.state !== 'validated') {
      return toResult(record);
    }
    if (this.now().getTime() > Date.parse(record.expiresAt)) {
      record = this.updateRecord(record, {
        failure: { code: 'TRANSACTION_EXPIRED', message: '事务已过有效期', operationIndex: null }
      });
      record = this.transition(record, 'failed', 'TRANSACTION_EXPIRED');
      this.releaseDocumentLock(record);
      throw new ProbeError('TRANSACTION_EXPIRED', { transactionId });
    }

    const capture = await this.options.captureRevision(record.request);
    checkRevisionPrecondition(record.request.revision, capture.fingerprint);

    record = this.transition(record, 'locked', 'confirm');
    record = this.transition(record, 'executing', 'confirm');

    const execution = this.options.execute(record, { undoCapability: this.undoCapability });
    let outcome: WriteExecutionOutcome;
    try {
      outcome = await this.raceTimeout(execution);
    } catch (error) {
      if (error instanceof ProbeError && error.code === 'WRITE_EXECUTION_TIMEOUT') {
        this.trackLateSettlement(transactionId, execution);
      }
      record = this.updateRecord(record, { failure: toWriteFailure(error) });
      record = this.transition(record, 'outcome-unknown', record.failure?.code);
      this.releaseDocumentLock(record);
      return toResult(record);
    }

    if (outcome.kind === 'operation-failed') {
      record = this.updateRecord(record, {
        executedOps: outcome.executedOps,
        failure: outcome.failure,
        executionEvidence: outcome.evidence ?? null
      });
      record = this.transition(record, 'failed', outcome.failure.code);
      record = await this.performRollback(record);
      this.releaseDocumentLock(record);
      return toResult(record);
    }

    record = this.updateRecord(record, {
      executedOps: outcome.executedOps,
      verification: outcome.verification,
      executionEvidence: outcome.evidence ?? null
    });
    if (record.request.save) {
      record = this.transition(record, 'saving', 'executor-success');
    }
    record = this.transition(record, 'verifying', 'executor-success');
    // 协议不变式：committed 必须携带 passed=true 的重读验证报告，缺失一律转入失败回滚。
    if (!outcome.verification || !outcome.verification.passed) {
      record = this.updateRecord(record, {
        failure: { code: 'WRITE_VERIFICATION_FAILED', message: '缺少通过的重读验证报告，禁止提交', operationIndex: null }
      });
      record = this.transition(record, 'failed', 'WRITE_VERIFICATION_FAILED');
      record = await this.performRollback(record);
      this.releaseDocumentLock(record);
      return toResult(record);
    }

    record = this.transition(record, 'committed', 'verification-passed');
    this.releaseDocumentLock(record);
    return toResult(record);
  }

  /**
   * 手动回滚已提交（或已失败未回滚）的事务。
   *
   * @param value 含 transactionId 的回滚请求。
   * @returns 回滚后的事务结果。
   */
  async rollback(value: unknown): Promise<WriteTransactionResult> {
    const { transactionId } = validateTransactionIdRequest(value);
    const record = this.requireTransaction(transactionId);
    if (record.state !== 'committed' && record.state !== 'failed') {
      throw new ProbeError('INVALID_STATE_TRANSITION', {
        transactionId,
        from: record.state,
        to: 'rolling-back'
      });
    }
    const updated = await this.performRollback(record);
    this.releaseDocumentLock(updated);
    return toResult(updated);
  }

  status(value: unknown): WriteTransactionResult {
    const { transactionId } = validateTransactionIdRequest(value);
    return toResult(this.requireTransaction(transactionId));
  }

  /** 只列未完成事务（终态 committed/failed/rolled-back 之外），供重连恢复入口使用。 */
  list(): WriteTransactionResult[] {
    return this.store.list()
      .filter((record) => !FINISHED_STATES.includes(record.state))
      .map((record) => toResult(record));
  }

  /**
   * Bridge 重连后的恢复链路（设计规格 13.4）：比对受影响资源内容指纹，
   * 把未完成事务分类为 committed / not-executed / rollbackable / manual-recovery-required。
   * 禁止从中断位置盲目续写：rollbackable 只能经 transactionRollback 收口。
   *
   * @param context 当前项目和文档上下文。
   * @param captureFingerprint 重采受影响文档指纹。
   * @returns 恢复摘要。
   */
  async recover(
    context: WriteRecoveryContext,
    captureFingerprint: (documentId: string) => Promise<RevisionFingerprint>
  ): Promise<WriteRecoverySummary> {
    const candidates = this.store.list().filter(
      (record) => !FINISHED_STATES.includes(record.state) && RECOVERABLE_STATES.includes(record.state)
    );
    const recovered: WriteRecoveredTransaction[] = [];
    for (const record of candidates) {
      recovered.push(await this.recoverRecord(record, captureFingerprint));
    }

    let lastSuccessfulStep: WriteTransactionState | null = null;
    let lastSuccessfulAt = '';
    for (const record of candidates) {
      const step = readLastSuccessfulStep(record);
      const at = record.stateHistory[record.stateHistory.length - 1]?.at ?? '';
      if (step && at >= lastSuccessfulAt) {
        lastSuccessfulAt = at;
        lastSuccessfulStep = step;
      }
    }

    return {
      project: { path: context.projectPath, creatorVersion: context.creatorVersion },
      document: { documentId: context.documentId },
      unfinishedTransactions: recovered,
      lastSuccessfulStep,
      recommendedNextStep: recovered.some((item) => item.recommendedAction === 'manual')
        ? '存在需人工恢复的事务：先人工核对文档状态，再继续任何写入'
        : recovered.some((item) => item.recommendedAction === 'rollback')
          ? '对未完成事务执行 transactionRollback 回滚；禁止从中断点续写'
          : '无待处理写入，可安全开始新事务'
    };
  }

  private async recoverRecord(
    record: WriteTransactionRecord,
    captureFingerprint: (documentId: string) => Promise<RevisionFingerprint>
  ): Promise<WriteRecoveredTransaction> {
    if (record.state === 'manual-recovery-required') {
      return toRecoveredTransaction(record, 'manual-recovery-required', 'manual');
    }

    let updated = record.state === 'recovering' ? record : this.transition(record, 'recovering', 'reconnect');
    let fingerprint: RevisionFingerprint;
    try {
      fingerprint = await captureFingerprint(record.documentId);
    } catch (error) {
      updated = this.updateRecord(updated, {
        failure: { code: 'RECOVERY_FINGERPRINT_FAILED', message: readReason(error), operationIndex: null }
      });
      updated = this.transition(updated, 'manual-recovery-required', 'fingerprint-capture-failed');
      this.releaseDocumentLock(updated);
      return toRecoveredTransaction(updated, 'manual-recovery-required', 'manual');
    }

    if (fingerprintMatchesPrecondition(updated.request.revision, fingerprint)) {
      // 文档指纹仍处基线：写入未落盘或已随编辑器重启丢失，无需回滚。
      updated = this.updateRecord(updated, {
        failure: { code: 'WRITE_NOT_EXECUTED', message: '受影响资源指纹仍处基线，写入未生效', operationIndex: null }
      });
      updated = this.transition(updated, 'failed', 'not-executed');
      this.releaseDocumentLock(updated);
      return toRecoveredTransaction(updated, 'not-executed', 'none');
    }

    if (updated.verification?.passed) {
      // 断连前已完成保存且重读验证通过，按已提交收口。
      updated = this.transition(updated, 'committed', 'recovered-committed');
      this.releaseDocumentLock(updated);
      return toRecoveredTransaction(updated, 'committed', 'none');
    }

    // 指纹已偏离基线但缺少通过的验证：按可回滚收口，只允许经 transactionRollback 处理。
    updated = this.updateRecord(updated, {
      failure: { code: 'WRITE_OUTCOME_UNCERTAIN', message: '写入结局未知且指纹已变化，需回滚', operationIndex: null }
    });
    updated = this.transition(updated, 'failed', 'rollbackable');
    this.releaseDocumentLock(updated);
    return toRecoveredTransaction(updated, 'rollbackable', 'rollback');
  }

  private async performRollback(record: WriteTransactionRecord): Promise<WriteTransactionRecord> {
    let updated = this.transition(record, 'rolling-back', record.failure?.code);
    try {
      const evidence = await this.options.rollback(updated, { undoCapability: this.undoCapability });
      updated = this.updateRecord(updated, { rollbackEvidence: evidence });
      const clean = evidence.succeeded !== false && evidence.verifiedClean !== false;
      updated = this.transition(updated, clean ? 'rolled-back' : 'manual-recovery-required', 'rollback-finished');
    } catch (error) {
      updated = this.updateRecord(updated, {
        rollbackEvidence: { attempted: true, succeeded: false, undoGroupId: null, verifiedClean: null }
      });
      updated = this.transition(updated, 'manual-recovery-required', readReason(error));
    }
    return updated;
  }

  private raceTimeout(execution: Promise<WriteExecutionOutcome>): Promise<WriteExecutionOutcome> {
    const timeout = this.delay(this.executionTimeoutMs).then(() => {
      throw new ProbeError('WRITE_EXECUTION_TIMEOUT', { timeoutMs: this.executionTimeoutMs });
    });
    return Promise.race([execution, timeout]);
  }

  /**
   * 超时后 executor 仍可能在 Creator 内继续执行。晚到的结果只追加状态历史证据，
   * 不改变 outcome-unknown，真实结局由 Task 7 的重连恢复按指纹分类判定。
   */
  private trackLateSettlement(transactionId: string, execution: Promise<WriteExecutionOutcome>): void {
    execution.then((outcome) => {
      const record = this.store.get(transactionId);
      if (!record || record.state !== 'outcome-unknown') return;
      const derived: WriteTransactionState = outcome.kind === 'success' && outcome.verification?.passed
        ? 'committed'
        : 'failed';
      const at = this.now().toISOString();
      this.store.set({
        ...record,
        stateHistory: [...record.stateHistory, { state: derived, at, reason: 'executor-settled-late' }]
      });
    }, () => {
      // 晚到的失败同样不改变 outcome-unknown；异常细节已由 catch 路径记录。
    });
  }

  private transition(
    record: WriteTransactionRecord,
    to: WriteTransactionState,
    reason?: string
  ): WriteTransactionRecord {
    const allowed = STATE_TRANSITIONS[record.state];
    if (!allowed.includes(to)) {
      throw new ProbeError('INVALID_STATE_TRANSITION', { transactionId: record.transactionId, from: record.state, to });
    }
    const at = this.now().toISOString();
    const updated: WriteTransactionRecord = {
      ...record,
      state: to,
      updatedAt: at,
      stateHistory: [...record.stateHistory, { state: to, at, ...(reason ? { reason } : {}) }]
    };
    this.store.set(updated);
    return updated;
  }

  private updateRecord(
    record: WriteTransactionRecord,
    changes: Partial<WriteTransactionRecord>
  ): WriteTransactionRecord {
    const updated: WriteTransactionRecord = {
      ...record,
      ...changes,
      updatedAt: this.now().toISOString()
    };
    this.store.set(updated);
    return updated;
  }

  private acquireDocumentLock(documentId: string, transactionId: string): void {
    const active = this.documentLocks.get(documentId);
    if (active && active !== transactionId) {
      throw new ProbeError('DOCUMENT_LOCKED', { documentId, activeTransactionId: active });
    }
    this.documentLocks.set(documentId, transactionId);
  }

  private releaseDocumentLock(record: WriteTransactionRecord): void {
    if (!LOCK_RELEASE_STATES.includes(record.state)) return;
    if (this.documentLocks.get(record.documentId) === record.transactionId) {
      this.documentLocks.delete(record.documentId);
    }
  }

  private requireTransaction(transactionId: string): WriteTransactionRecord {
    const record = this.store.get(transactionId);
    if (!record) {
      throw new ProbeError('TRANSACTION_NOT_FOUND', { transactionId });
    }
    return record;
  }
}

/**
 * 桥内手写校验，字段语义与协议包 WriteTransactionRequestSchema 保持一致。
 * 阶段三作用域（source-prefab/apply-to-source）在这里直接拒绝。
 *
 * @param value 外部输入。
 * @returns 归一化后的写事务请求（字段顺序固定，供幂等哈希使用）。
 */
export function validateWriteTransactionRequest(value: unknown): WriteTransactionRequest {
  const request = readObject(value);
  const transactionId = readRequiredString(request.transactionId, 'TRANSACTION_ID_REQUIRED');
  const idempotencyKey = readRequiredString(request.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
  if (request.scope !== 'current-document') {
    throw new ProbeError('WRITE_SCOPE_UNSUPPORTED', { scope: request.scope ?? null });
  }
  const revision = readRevisionPrecondition(request.revision);
  const operations = readWriteOperations(request.operations);
  if (typeof request.save !== 'boolean') {
    throw new ProbeError('INVALID_WRITE_REQUEST', { field: 'save' });
  }
  const undoGroup = readRequiredString(request.undoGroup, 'UNDO_GROUP_REQUIRED');
  return { transactionId, idempotencyKey, scope: 'current-document', revision, operations, save: request.save, undoGroup };
}

export function validateTransactionIdRequest(value: unknown): { transactionId: string } {
  const request = readObject(value);
  return { transactionId: readRequiredString(request.transactionId, 'TRANSACTION_ID_REQUIRED') };
}

function checkRevisionPrecondition(expected: RevisionFingerprint, actual: RevisionFingerprint): void {  const conflicts: WriteConflict[] = [];
  for (const scope of REVISION_SCOPES) {
    const expectedValue = expected[scope];
    if (expectedValue === null) continue;
    if (expectedValue !== actual[scope]) {
      conflicts.push({ scope, expected: expectedValue, actual: actual[scope] });
    }
  }
  if (conflicts.length > 0) {
    throw new ProbeError('REVISION_CONFLICT', { conflicts });
  }
}

function toResult(record: WriteTransactionRecord, duplicateOf?: string): WriteTransactionResult {
  return {
    transactionId: record.transactionId,
    status: record.state,
    ...(duplicateOf ? { duplicateOf } : {}),
    executedOps: record.executedOps,
    verification: record.verification,
    failure: record.failure,
    rollbackEvidence: record.rollbackEvidence
  };
}

/** 指纹逐维比对：前置为 null 的维度不参与判定，全部参与维度一致才视为仍处基线。 */
function fingerprintMatchesPrecondition(expected: RevisionFingerprint, actual: RevisionFingerprint): boolean {
  return REVISION_SCOPES.every((scope) => expected[scope] === null || expected[scope] === actual[scope]);
}

function toRecoveredTransaction(
  record: WriteTransactionRecord,
  classification: WriteRecoveryClassification,
  recommendedAction: WriteRecoveredTransaction['recommendedAction']
): WriteRecoveredTransaction {
  return {
    transactionId: record.transactionId,
    classification,
    state: record.state,
    lastSuccessfulStep: readLastSuccessfulStep(record),
    recommendedAction
  };
}

function readLastSuccessfulStep(record: WriteTransactionRecord): WriteTransactionState | null {
  for (let index = record.stateHistory.length - 1; index >= 0; index -= 1) {
    const state = record.stateHistory[index].state;
    if (SUCCESS_STEP_STATES.includes(state)) return state;
  }
  return null;
}

function toWriteFailure(error: unknown): WriteFailure {
  if (error instanceof ProbeError) {
    return { code: error.code, message: error.code, operationIndex: null, details: error.details };
  }
  if (error instanceof Error) {
    return { code: error.message || 'WRITE_EXECUTION_FAILED', message: error.message, operationIndex: null };
  }
  return { code: 'WRITE_EXECUTION_FAILED', message: '写执行器未知失败', operationIndex: null };
}

function hashWriteRequest(request: WriteTransactionRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

/** 各写操作类型的必填字符串字段及额外校验，与协议 WriteOperationSchema 对齐。 */
const WRITE_OPERATION_STRING_FIELDS: Record<string, string[]> = {
  'node.create': ['parentNodeUuid', 'name'],
  'node.delete': ['nodeUuid'],
  'node.rename': ['nodeUuid', 'name'],
  'node.reparent': ['nodeUuid', 'newParentUuid'],
  'node.duplicate': ['nodeUuid'],
  'node.set_active': ['nodeUuid'],
  'node.set_layer': ['nodeUuid'],
  'node.set_transform': ['nodeUuid'],
  'component.add': ['nodeUuid', 'componentType'],
  'component.remove': ['componentUuid'],
  'component.enable': ['componentUuid'],
  'component.set_property': ['componentUuid', 'propertyPath'],
  'component.set_reference': ['componentUuid', 'propertyPath'],
  'component.clear_reference': ['componentUuid', 'propertyPath'],
  'component.resize_array': ['componentUuid', 'propertyPath']
};

function readWriteOperations(value: unknown): WriteOperation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProbeError('INVALID_WRITE_OPERATIONS');
  }
  return value.map((item, index) => readWriteOperation(item, index));
}

function readWriteOperation(value: unknown, index: number): WriteOperation {
  const operation = readObject(value);
  const type = typeof operation.type === 'string' ? operation.type : '';
  const stringFields = WRITE_OPERATION_STRING_FIELDS[type];
  if (!stringFields) {
    throw new ProbeError('INVALID_WRITE_OPERATION', { index, type: type || null });
  }
  for (const field of stringFields) {
    if (typeof operation[field] !== 'string' || !operation[field]) {
      throw new ProbeError('INVALID_WRITE_OPERATION', { index, type, field });
    }
  }
  switch (type) {
    case 'node.set_active':
      if (typeof operation.active !== 'boolean') throw new ProbeError('INVALID_WRITE_OPERATION', { index, type, field: 'active' });
      break;
    case 'node.set_layer':
      if (typeof operation.layer !== 'number') throw new ProbeError('INVALID_WRITE_OPERATION', { index, type, field: 'layer' });
      break;
    case 'node.set_transform':
      readLocalTransform(operation.localTransform, index);
      break;
    case 'component.add':
      // 内置组件为 null；自定义脚本组件必须携带脚本资产 uuid，供挂载守卫核对。
      if (operation.scriptUuid !== null && typeof operation.scriptUuid !== 'string') {
        throw new ProbeError('INVALID_WRITE_OPERATION', { index, type, field: 'scriptUuid' });
      }
      break;
    case 'component.enable':
      if (typeof operation.enabled !== 'boolean') throw new ProbeError('INVALID_WRITE_OPERATION', { index, type, field: 'enabled' });
      break;
    case 'component.set_reference': {
      const reference = readObject(operation.reference);
      if (typeof reference.kind !== 'string' || !reference.kind) {
        throw new ProbeError('INVALID_WRITE_OPERATION', { index, type, field: 'reference.kind' });
      }
      break;
    }
    case 'component.resize_array':
      if (!Number.isInteger(operation.length) || (operation.length as number) < 0) {
        throw new ProbeError('INVALID_WRITE_OPERATION', { index, type, field: 'length' });
      }
      break;
    default:
      break;
  }
  return { ...operation, type } as WriteOperation;
}

function readLocalTransform(value: unknown, index: number): void {
  const transform = readObject(value);
  if (!transform.position && !transform.rotation && !transform.scale) {
    throw new ProbeError('INVALID_WRITE_OPERATION', { index, type: 'node.set_transform', field: 'localTransform' });
  }
}

function readRevisionPrecondition(value: unknown): RevisionFingerprint {
  const revision = readObject(value);
  return {
    document: readNullableFingerprint(revision.document),
    hierarchy: readNullableFingerprint(revision.hierarchy),
    assetDatabase: readNullableFingerprint(revision.assetDatabase),
    scriptCompilation: readNullableFingerprint(revision.scriptCompilation)
  };
}

function readNullableFingerprint(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value) {
    throw new ProbeError('INVALID_REVISION_PRECONDITION');
  }
  return value;
}

function readRequiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value) {
    throw new ProbeError(code);
  }
  return value;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneRecord(record: WriteTransactionRecord): WriteTransactionRecord {
  return JSON.parse(JSON.stringify(record)) as WriteTransactionRecord;
}
