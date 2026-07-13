import { ProbeError } from './probe-errors';

function notImplemented(): never {
  throw new ProbeError('NOT_IMPLEMENTED');
}

export function load(): void {}

export function unload(): void {}

export const methods = {
  probeEditorState: notImplemented,
  probeAssets: notImplemented,
  probeHierarchy: notImplemented,
  probeNode: notImplemented,
  probeComponent: notImplemented,
  probePrefab: notImplemented,
  probeUndoSave: notImplemented
};
