import { ProbeError } from './probe-errors';

export interface ProbeOperationRequest {
  projectPath: string;
  documentAssetUuid: string;
  expectedNodeUuid: string;
  probeName: string;
}

export function validateProbeOperation(value: unknown): ProbeOperationRequest {
  const request = value as Partial<ProbeOperationRequest>;
  if (typeof request.projectPath !== 'string' || !request.projectPath.split('\\').join('/').includes('/worktrees/')) {
    throw new ProbeError('PROBE_PROJECT_NOT_ISOLATED');
  }
  if (typeof request.documentAssetUuid !== 'string' || !request.documentAssetUuid) throw new ProbeError('DOCUMENT_UUID_REQUIRED');
  if (typeof request.expectedNodeUuid !== 'string' || !request.expectedNodeUuid) throw new ProbeError('EXPECTED_NODE_UUID_REQUIRED');
  if (typeof request.probeName !== 'string' || !request.probeName.startsWith('CocosAiProbe_')) throw new ProbeError('INVALID_PROBE_NAME');
  return request as ProbeOperationRequest;
}
