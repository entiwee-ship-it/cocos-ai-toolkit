import { createHash, randomUUID } from 'node:crypto';
import { ProbeError } from './probe-errors';
import {
  normalizeProbeProjectPath,
  validateProbeConfirmRequest,
  validateProbePrepareRequest,
  validateProbeStatusRequest,
  type ProbePrepareRequest
} from './probe-operation';

export type ProbeTransactionStatus =
  | 'prepared'
  | 'executing'
  | 'saved'
  | 'rolling-back'
  | 'rolled-back'
  | 'outcome-unknown'
  | 'manual-recovery-required';

export interface ProbeRevisionSnapshot {
  documentAssetUuid: string;
  assetSha256: string;
  hierarchySha256: string;
  dirty: boolean;
  parentNodeUuid: string;
  existingProbeNodeUuid: string | null;
  recoveryContent?: string;
}

export type ProbeRevisionBaseline = Omit<ProbeRevisionSnapshot, 'recoveryContent'>;

export interface ProbeExecutionResult {
  status: Extract<ProbeTransactionStatus, 'rolled-back' | 'manual-recovery-required'>;
  createdNodeUuid: string;
  diskHashRestored: boolean;
  rollbackMethod: 'undo' | 'explicit-remove';
  recoveryMethod: 'none' | 'asset-db-save-asset';
  undoSource: string;
  before: Record<string, unknown>;
  created: Record<string, unknown>;
  saved: Record<string, unknown>;
  rolledBack: Record<string, unknown>;
}

export interface ProbeTransaction {
  transactionId: string;
  revision: string;
  status: ProbeTransactionStatus;
  projectPath: string;
  documentAssetUuid: string;
  parentNodeUuid: string;
  probeName: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  operation: {
    type: 'create-save-rollback-probe';
    position: { x: 17; y: 23; z: 0 };
    component: 'cc.UITransform';
    verificationPauseMs: 2000;
  };
  createdNodeUuid: string | null;
  result: ProbeExecutionResult | null;
  error: { code: string; details: Record<string, unknown> } | null;
  baseline: ProbeRevisionBaseline;
}

export interface ProbeTransactionStore {
  get(transactionId: string): ProbeTransaction | undefined;
  set(transaction: ProbeTransaction): void;
}

export class InMemoryProbeTransactionStore implements ProbeTransactionStore {
  private readonly transactions = new Map<string, ProbeTransaction>();

  get(transactionId: string): ProbeTransaction | undefined {
    const transaction = this.transactions.get(transactionId);
    return transaction ? cloneTransaction(transaction) : undefined;
  }

  set(transaction: ProbeTransaction): void {
    this.transactions.set(transaction.transactionId, cloneTransaction(transaction));
  }
}

interface ProbeTransactionCoordinatorOptions {
  store?: ProbeTransactionStore;
  currentProjectPath: () => string;
  createTransactionId?: () => string;
  now?: () => Date;
  captureRevision: (request: ProbePrepareRequest) => Promise<ProbeRevisionSnapshot>;
  execute: (transaction: ProbeTransaction, recoveryContent?: string) => Promise<ProbeExecutionResult>;
}

export class ProbeTransactionCoordinator {
  private readonly store: ProbeTransactionStore;
  private readonly createTransactionId: () => string;
  private readonly now: () => Date;
  private readonly recoveryContents = new Map<string, string>();

  constructor(private readonly options: ProbeTransactionCoordinatorOptions) {
    this.store = options.store ?? new InMemoryProbeTransactionStore();
    this.createTransactionId = options.createTransactionId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async prepare(value: unknown): Promise<ProbeTransaction> {
    const request = validateProbePrepareRequest(value);
    if (normalizeProbeProjectPath(this.options.currentProjectPath()) !== normalizeProbeProjectPath(request.projectPath)) {
      throw new ProbeError('PROJECT_PATH_MISMATCH');
    }

    const snapshot = await this.options.captureRevision(request);
    if (snapshot.documentAssetUuid !== request.documentAssetUuid) {
      throw new ProbeError('DOCUMENT_UUID_MISMATCH');
    }
    if (!snapshot.parentNodeUuid) {
      throw new ProbeError('PREFAB_ROOT_NOT_FOUND');
    }
    if (snapshot.dirty) {
      throw new ProbeError('DOCUMENT_DIRTY');
    }
    if (snapshot.existingProbeNodeUuid) {
      throw new ProbeError('PROBE_NODE_ALREADY_EXISTS', { nodeUuid: snapshot.existingProbeNodeUuid });
    }

    const createdAt = this.now();
    const transactionId = this.createTransactionId();
    const transaction: ProbeTransaction = {
      transactionId,
      revision: buildProbeRevision(snapshot),
      status: 'prepared',
      projectPath: request.projectPath,
      documentAssetUuid: request.documentAssetUuid,
      parentNodeUuid: snapshot.parentNodeUuid,
      probeName: request.probeName,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
      operation: {
        type: 'create-save-rollback-probe',
        position: { x: 17, y: 23, z: 0 },
        component: 'cc.UITransform',
        verificationPauseMs: 2000
      },
      createdNodeUuid: null,
      result: null,
      error: null,
      baseline: toBaseline(snapshot)
    };
    if (snapshot.recoveryContent !== undefined) {
      this.recoveryContents.set(transactionId, snapshot.recoveryContent);
    }
    this.store.set(transaction);
    return cloneTransaction(transaction);
  }

  async confirm(value: unknown): Promise<ProbeTransaction> {
    const request = validateProbeConfirmRequest(value);
    const transaction = this.requireTransaction(request.transactionId);
    if (request.expectedRevision !== transaction.revision) {
      throw new ProbeError('EXPECTED_REVISION_MISMATCH');
    }
    if (transaction.status !== 'prepared') {
      return transaction;
    }
    if (this.now().getTime() > Date.parse(transaction.expiresAt)) {
      throw new ProbeError('TRANSACTION_EXPIRED');
    }

    const currentSnapshot = await this.options.captureRevision(transaction);
    const currentRevision = buildProbeRevision(currentSnapshot);
    if (currentRevision !== transaction.revision) {
      throw new ProbeError('REVISION_CONFLICT', {
        expectedRevision: transaction.revision,
        currentRevision
      });
    }

    const executing = this.updateTransaction(transaction, { status: 'executing', error: null });
    try {
      const result = await this.options.execute(executing, this.recoveryContents.get(transaction.transactionId));
      return this.updateTransaction(executing, {
        status: result.status,
        createdNodeUuid: result.createdNodeUuid,
        result
      });
    } catch (error) {
      const probeError = error instanceof ProbeError
        ? error
        : new ProbeError(error instanceof Error ? error.message : 'PROBE_EXECUTION_FAILED');
      this.updateTransaction(executing, {
        status: 'outcome-unknown',
        error: { code: probeError.code, details: probeError.details }
      });
      throw probeError;
    }
  }

  status(value: unknown): ProbeTransaction {
    const request = validateProbeStatusRequest(value);
    return this.requireTransaction(request.transactionId);
  }

  private requireTransaction(transactionId: string): ProbeTransaction {
    const transaction = this.store.get(transactionId);
    if (!transaction) {
      throw new ProbeError('TRANSACTION_NOT_FOUND', { transactionId });
    }
    return transaction;
  }

  private updateTransaction(
    transaction: ProbeTransaction,
    changes: Partial<ProbeTransaction>
  ): ProbeTransaction {
    const updated = {
      ...transaction,
      ...changes,
      updatedAt: this.now().toISOString()
    };
    this.store.set(updated);
    return cloneTransaction(updated);
  }
}

export function buildProbeRevision(snapshot: ProbeRevisionSnapshot): string {
  const canonical = JSON.stringify({
    documentAssetUuid: snapshot.documentAssetUuid,
    assetSha256: snapshot.assetSha256,
    hierarchySha256: snapshot.hierarchySha256,
    dirty: snapshot.dirty,
    parentNodeUuid: snapshot.parentNodeUuid,
    existingProbeNodeUuid: snapshot.existingProbeNodeUuid
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function cloneTransaction(transaction: ProbeTransaction): ProbeTransaction {
  return JSON.parse(JSON.stringify(transaction)) as ProbeTransaction;
}

function toBaseline(snapshot: ProbeRevisionSnapshot): ProbeRevisionBaseline {
  return {
    documentAssetUuid: snapshot.documentAssetUuid,
    assetSha256: snapshot.assetSha256,
    hierarchySha256: snapshot.hierarchySha256,
    dirty: snapshot.dirty,
    parentNodeUuid: snapshot.parentNodeUuid,
    existingProbeNodeUuid: snapshot.existingProbeNodeUuid
  };
}
