import { ProbeError } from './probe-errors';
import { normalizeComponentDump, normalizeHierarchyTree, normalizeNodeDump } from './scene-probe';

function notImplemented(): never {
  throw new ProbeError('NOT_IMPLEMENTED');
}

async function probeHierarchy(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const rootUuid = typeof input.rootUuid === 'string' ? input.rootUuid : undefined;
  const depth = typeof input.depth === 'number' ? input.depth : 4;
  const raw = await Editor.Message.request('scene', 'query-node-tree', ...(rootUuid ? [rootUuid] : []));
  return { data: normalizeHierarchyTree(raw, depth), raw, source: 'message-api' };
}

async function probeNode(request: unknown): Promise<unknown> {
  const uuid = requireUuid(unwrapRequest(request));
  const raw = await Editor.Message.request('scene', 'query-node', uuid);
  return { data: normalizeNodeDump(raw), raw, source: 'message-api' };
}

async function probeComponent(request: unknown): Promise<unknown> {
  const uuid = requireUuid(unwrapRequest(request));
  const raw = await Editor.Message.request('scene', 'query-component', uuid);
  return { data: normalizeComponentDump(raw), raw, source: 'message-api' };
}

async function probePrefab(request: unknown): Promise<unknown> {
  const input = readObject(unwrapRequest(request));
  const uuid = typeof input.nodeUuid === 'string' ? input.nodeUuid : null;
  if (!uuid) throw new ProbeError('NODE_UUID_REQUIRED');
  const raw = await Editor.Message.request('scene', 'query-node-tree', uuid);
  const tree = readObject(raw);
  const prefab = readObject(tree.prefab);
  return {
    document: { nodeUuid: uuid, source: 'message-api' },
    sourcePrefab: { assetUuid: typeof prefab.assetUuid === 'string' ? prefab.assetUuid : null },
    instance: {
      state: typeof prefab.state === 'number' ? prefab.state : null,
      isNested: typeof prefab.isNested === 'boolean' ? prefab.isNested : null,
      isAddedChild: typeof prefab.isAddedChild === 'boolean' ? prefab.isAddedChild : null,
      isRevertable: typeof prefab.isRevertable === 'boolean' ? prefab.isRevertable : null,
      isApplicable: typeof prefab.isApplicable === 'boolean' ? prefab.isApplicable : null
    },
    fileId: null,
    overrides: [],
    unresolved: [
      { path: 'fileId', reason: 'SCENE_MESSAGE_API_NOT_EXPOSED' },
      { path: 'overrides', reason: 'NESTED_PREFAB_SAMPLE_REQUIRED' }
    ],
    raw
  };
}

function requireUuid(request: unknown): string {
  const input = readObject(request);
  if (typeof input.uuid !== 'string' || !input.uuid) {
    throw new ProbeError('UUID_REQUIRED');
  }
  return input.uuid;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unwrapRequest(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function load(): void {}

export function unload(): void {}

export const methods = {
  probeEditorState: notImplemented,
  probeAssets: notImplemented,
  probeHierarchy,
  probeNode,
  probeComponent,
  probePrefab,
  probeUndoSave: notImplemented
};
