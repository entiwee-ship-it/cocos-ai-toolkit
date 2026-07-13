import { normalizeProperty, readDumpValue, readObject } from './raw-reflection';

export function normalizeNodeDump(rawValue: unknown, siblingIndex: number | null = null) {
  const raw = readObject(rawValue);
  const children = Array.isArray(raw.children) ? raw.children : [];
  const components = Array.isArray(raw.__comps__) ? raw.__comps__.map(normalizeComponentDump) : [];
  return {
    identity: { objectUuid: readString(readDumpValue(raw.uuid)), fileId: null },
    name: readString(readDumpValue(raw.name)),
    type: readString(raw.__type__),
    active: readBoolean(readDumpValue(raw.active)),
    layer: readNumber(readDumpValue(raw.layer)),
    siblingIndex,
    parentUuid: readUuid(readDumpValue(raw.parent)),
    childUuids: children.map((child) => readUuid(readDumpValue(child))).filter((uuid): uuid is string => Boolean(uuid)),
    transform: {
      position: readDumpValue(raw.position) ?? null,
      rotation: readDumpValue(raw.rotation) ?? null,
      scale: readDumpValue(raw.scale) ?? null
    },
    components,
    unresolved: [],
    raw
  };
}

export function normalizeComponentDump(rawValue: unknown) {
  const raw = readObject(rawValue);
  const values = readObject(raw.value);
  const className = readString(raw.type);
  const typeId = readString(raw.cid);
  const inheritance = Array.isArray(raw.extends) ? raw.extends.filter((value): value is string => typeof value === 'string') : [];
  const properties: Record<string, ReturnType<typeof normalizeProperty>> = {};
  const unresolved: Array<{ path: string; reason: string }> = [];
  for (const [name, property] of Object.entries(values)) {
    properties[name] = normalizeProperty(property);
    const propertyObject = readObject(property);
    if (typeof propertyObject.type !== 'string') {
      unresolved.push({ path: `properties.${name}`, reason: 'DECLARED_TYPE_MISSING' });
    }
  }
  const scriptProperty = readObject(values.__scriptAsset);
  return {
    identity: { objectUuid: readString(readDumpValue(values.uuid)), fileId: null },
    class: {
      className,
      typeId,
      custom: Boolean(className && !className.startsWith('cc.')),
      scriptUuid: readUuid(readDumpValue(scriptProperty)),
      scriptPath: null,
      inheritance
    },
    properties,
    unresolved,
    raw
  };
}

export function normalizeHierarchyTree(treeValue: unknown, depth: number): unknown {
  const visit = (value: unknown, level: number, siblingIndex: number): unknown => {
    const tree = readObject(value);
    const children = level < depth && Array.isArray(tree.children) ? tree.children : [];
    return {
      identity: { objectUuid: readString(tree.uuid), fileId: null },
      name: readString(tree.name),
      type: readString(tree.type),
      active: readBoolean(tree.active),
      layer: null,
      siblingIndex,
      parentUuid: readString(tree.parent),
      path: readString(tree.path),
      prefab: tree.prefab ?? null,
      components: Array.isArray(tree.components) ? tree.components : [],
      children: children.map((child, index) => visit(child, level + 1, index)),
      raw: tree
    };
  };
  return visit(treeValue, 0, 0);
}

function readUuid(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const object = readObject(value);
  return readString(object.uuid);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
