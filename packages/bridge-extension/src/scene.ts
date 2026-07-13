import { ProbeError } from './probe-errors';
import { normalizeComponentDump, normalizeHierarchyTree, normalizeNodeDump } from './scene-probe';
import { validateProbeOperation } from './probe-operation';

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

async function probeUndoSave(request: unknown): Promise<unknown> {
  const operation = validateProbeOperation(unwrapRequest(request));
  if (Editor.Project.path.split('\\').join('/') !== operation.projectPath.split('\\').join('/')) {
    throw new ProbeError('PROJECT_PATH_MISMATCH');
  }
  const before = await Editor.Message.request('scene', 'query-node-tree');
  const root = readObject(before);
  const parent = findPrefabRootUuid(root, operation.documentAssetUuid);
  if (!parent) throw new ProbeError('PREFAB_ROOT_NOT_FOUND');
  const createdUuid = await Editor.Message.request('scene', 'create-node', {
    parent,
    name: operation.probeName,
    snapshot: true,
    position: { x: 17, y: 23, z: 0 }
  });
  const created = await Editor.Message.request('scene', 'query-node', createdUuid);
  await Editor.Message.request('scene', 'save-scene');
  const saved = await Editor.Message.request('scene', 'query-node', createdUuid);
  if (createdUuid !== operation.expectedNodeUuid) {
    await Editor.Message.request('scene', 'remove-node', { uuid: createdUuid });
    await Editor.Message.request('scene', 'save-scene');
    throw new ProbeError('EXPECTED_NODE_UUID_MISMATCH', { createdUuid });
  }
  await Editor.Message.request('scene', 'remove-node', { uuid: createdUuid });
  await Editor.Message.request('scene', 'save-scene');
  const restored = await Editor.Message.request('scene', 'query-node', createdUuid);
  return { before: Boolean(before), createdUuid, created: Boolean(created), saved: Boolean(saved), restored: restored === null };
}

function findPrefabRootUuid(value: Record<string, unknown>, assetUuid: string): string | null {
  const prefab = readObject(value.prefab);
  if (prefab.assetUuid === assetUuid && typeof value.uuid === 'string') return value.uuid;
  if (Array.isArray(value.children)) {
    for (const child of value.children) {
      const found = findPrefabRootUuid(readObject(child), assetUuid);
      if (found) return found;
    }
  }
  return null;
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
  probeUndoSave
};
