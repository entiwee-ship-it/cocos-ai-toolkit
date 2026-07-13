import { ProbeError } from './probe-errors';

export interface ProbePrepareRequest {
  projectPath: string;
  documentAssetUuid: string;
  probeName: string;
}

export interface ProbeConfirmRequest {
  transactionId: string;
  expectedRevision: string;
}

export interface ProbeStatusRequest {
  transactionId: string;
}

/**
 * 校验创建探针事务的固定安全边界。
 *
 * @param value 外部传入的 prepare 参数。
 * @returns 已校验的 prepare 参数。
 */
export function validateProbePrepareRequest(value: unknown): ProbePrepareRequest {
  const request = readObject(value);
  const projectPath = readRequiredString(request.projectPath, 'PROJECT_PATH_REQUIRED');
  const normalizedProjectPath = normalizePath(projectPath);
  if (!/\/worktrees\/[^/]*cocos-ai-probe(?:\/|$)/i.test(normalizedProjectPath)) {
    throw new ProbeError('PROBE_PROJECT_NOT_ISOLATED');
  }

  const documentAssetUuid = readRequiredString(request.documentAssetUuid, 'DOCUMENT_UUID_REQUIRED');
  const probeName = readRequiredString(request.probeName, 'PROBE_NAME_REQUIRED');
  if (!probeName.startsWith('CocosAiProbe_')) {
    throw new ProbeError('INVALID_PROBE_NAME');
  }

  return { projectPath, documentAssetUuid, probeName };
}

export function validateProbeConfirmRequest(value: unknown): ProbeConfirmRequest {
  const request = readObject(value);
  return {
    transactionId: readRequiredString(request.transactionId, 'TRANSACTION_ID_REQUIRED'),
    expectedRevision: readRequiredString(request.expectedRevision, 'EXPECTED_REVISION_REQUIRED')
  };
}

export function validateProbeStatusRequest(value: unknown): ProbeStatusRequest {
  const request = readObject(value);
  return {
    transactionId: readRequiredString(request.transactionId, 'TRANSACTION_ID_REQUIRED')
  };
}

export function normalizeProbeProjectPath(value: string): string {
  return normalizePath(value).replace(/\/$/, '').toLowerCase();
}

function normalizePath(value: string): string {
  return value.split('\\').join('/');
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
