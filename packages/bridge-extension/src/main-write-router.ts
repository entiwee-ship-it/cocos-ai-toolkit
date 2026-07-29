import type { WriteExecutionOutcome, WriteOperation } from './transaction-manager';
import type { WriteSceneExecutionOutcome } from './write-scene-channel';

export interface BridgeWriteInput {
  operations: WriteOperation[];
  save: boolean;
  undoGroup: string;
}

export interface BridgeWriteRouterDependencies {
  executeMainAssetWrite(input: BridgeWriteInput): Promise<WriteSceneExecutionOutcome>;
  executeSceneWrite(input: BridgeWriteInput): Promise<WriteExecutionOutcome>;
}

export async function executeBridgeWrite(
  input: BridgeWriteInput,
  dependencies: BridgeWriteRouterDependencies
): Promise<WriteExecutionOutcome> {
  return input.operations.length > 0 && input.operations.every((operation) => operation.type.startsWith('asset.'))
    ? dependencies.executeMainAssetWrite(input)
    : dependencies.executeSceneWrite(input);
}
