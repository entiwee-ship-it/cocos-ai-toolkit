import { ProbeError } from './probe-errors';
import {
  executePrefabWriteOperation,
  type PrefabAssetInfo,
  type PrefabWriterDependencies
} from './prefab-writer';
import type { WriteOperation, WriteVerificationReport } from './transaction-manager';
import {
  executeWriteSceneOperations,
  rollbackWriteSceneOperations,
  type WriteSceneExecutionOutcome
} from './write-scene-channel';
import {
  saveAndVerifyWriteTransaction,
  type VerifiedOperation,
  type WriteVerifierDependencies
} from './write-verifier';
import type { BridgeWriteInput } from './main-write-router';

export interface MainAssetWriteDependencies {
  queryAssetInfo(uuidOrUrl: string): Promise<PrefabAssetInfo | null>;
  createAsset(assetUrl: string, assetKind: 'folder' | 'component-script', content: string | null): Promise<PrefabAssetInfo>;
  moveAsset(sourceUrl: string, targetUrl: string): Promise<void>;
  readAssetMeta(assetUrl: string): Promise<Record<string, unknown>>;
  writeAssetMeta(assetUrl: string, meta: Record<string, unknown>): Promise<void>;
  readAssetContent(assetUrl: string): Promise<string>;
  saveAssetContent(assetUrl: string, content: string): Promise<void>;
  deleteAsset(assetUrl: string): Promise<void>;
}

export async function executeMainAssetWrite(
  input: BridgeWriteInput,
  dependencies: MainAssetWriteDependencies
): Promise<WriteSceneExecutionOutcome> {
  assertAssetOnly(input.operations);
  return executeWriteSceneOperations(
    { ...input, save: false },
    buildChannelDependencies(dependencies)
  );
}

export async function rollbackMainAssetWrite(
  executed: VerifiedOperation[],
  dependencies: MainAssetWriteDependencies
): Promise<{ succeeded: boolean; failedAt: number | null }> {
  return rollbackWriteSceneOperations(executed, buildChannelDependencies(dependencies));
}

function buildChannelDependencies(dependencies: MainAssetWriteDependencies) {
  const prefabDependencies = buildPrefabDependencies(dependencies);
  return {
    executeNodeOperation: async () => { throw new ProbeError('MAIN_ASSET_WRITE_OPERATION_REQUIRED'); },
    executeComponentOperation: async () => { throw new ProbeError('MAIN_ASSET_WRITE_OPERATION_REQUIRED'); },
    executePrefabOperation: (operation: WriteOperation) => executePrefabWriteOperation(operation, prefabDependencies),
    saveDocument: async () => undefined,
    reloadDocument: async () => undefined,
    verify: (executed: VerifiedOperation[]): Promise<WriteVerificationReport> => saveAndVerifyWriteTransaction(
      { save: false } as never,
      executed,
      buildVerifierDependencies(dependencies)
    )
  };
}

function buildPrefabDependencies(dependencies: MainAssetWriteDependencies): PrefabWriterDependencies {
  const unavailable = async (): Promise<never> => {
    throw new ProbeError('MAIN_ASSET_WRITE_OPERATION_REQUIRED');
  };
  return {
    ...dependencies,
    getPrefabInstanceInfo: unavailable,
    instantiatePrefab: unavailable,
    createPrefabFromNode: unavailable,
    revertPrefabInstance: unavailable,
    applyPrefabInstance: unavailable,
    unlinkPrefabInstance: unavailable,
    linkPrefabInstance: unavailable,
    resetNodeProperty: unavailable,
    setPrefabInstanceOverride: unavailable,
    removePrefabInstanceOverride: unavailable,
    getCurrentDocumentAssetUuid: unavailable,
    findPrefabInstanceRoot: unavailable
  } as PrefabWriterDependencies;
}

function buildVerifierDependencies(dependencies: MainAssetWriteDependencies): WriteVerifierDependencies {
  const unavailable = async (): Promise<never> => {
    throw new ProbeError('MAIN_ASSET_WRITE_OPERATION_REQUIRED');
  };
  return {
    saveDocument: async () => undefined,
    reloadDocument: async () => undefined,
    getNodeInfo: unavailable,
    getComponentInfo: unavailable,
    getComponentProperty: unavailable,
    getPrefabInstanceInfo: unavailable,
    queryAssetInfo: dependencies.queryAssetInfo,
    readAssetMeta: dependencies.readAssetMeta,
    readAssetContent: dependencies.readAssetContent
  };
}

function assertAssetOnly(operations: WriteOperation[]): void {
  if (operations.length === 0 || operations.some((operation) => !operation.type.startsWith('asset.'))) {
    throw new ProbeError('MAIN_ASSET_WRITE_OPERATION_REQUIRED');
  }
}
