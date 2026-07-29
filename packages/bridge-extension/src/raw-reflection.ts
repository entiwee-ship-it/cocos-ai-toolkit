export interface NormalizedProperty {
  declaredType: string | null;
  valueKind: string;
  value: unknown;
  visible: boolean | null;
  readonly: boolean | null;
  raw: unknown;
}

export function normalizeProperty(value: unknown): NormalizedProperty {
  const property = readObject(value);
  const declaredType = typeof property.type === 'string' ? property.type : null;
  const rawValue = readDumpValueDeep(value);
  return {
    declaredType,
    valueKind: classifyValueKind(declaredType, rawValue, property.extends),
    value: rawValue,
    visible: typeof property.visible === 'boolean' ? property.visible : null,
    readonly: typeof property.readonly === 'boolean' ? property.readonly : null,
    raw: value
  };
}

/**
 * 按 Creator 声明类型、继承链和当前值识别稳定的属性值类别。
 *
 * @param type Creator 属性声明类型。
 * @param value Creator 属性当前值。
 * @param extendsValue Creator 属性声明的继承链。
 * @returns PropertyValueKindSchema 对应字符串。
 */
export function classifyValueKind(type: string | null, value: unknown, extendsValue: unknown): string {
  const inheritance = Array.isArray(extendsValue) ? extendsValue.filter((item): item is string => typeof item === 'string') : [];
  if (Array.isArray(value)) return 'array';
  if (type === 'cc.Node') return 'node-reference';
  if (inheritance.includes('cc.Component') || type?.endsWith('Component')) return 'component-reference';
  if (inheritance.includes('cc.Asset') || type?.endsWith('Asset') || type === 'cc.SpriteFrame' || type === 'cc.Prefab') return 'asset-reference';
  if (type === 'Enum') return 'enum';
  if (type === 'cc.Vec2' || type === 'cc.Vec3' || type === 'cc.Vec4' || type === 'cc.Quat') return 'vector';
  if (type === 'cc.Color') return 'color';
  if (type === 'cc.Size') return 'size';
  if (type === 'cc.Rect') return 'rect';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return typeof value;
  return 'unknown-serialized';
}

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readDumpValue(value: unknown): unknown {
  const object = readObject(value);
  return 'value' in object ? object.value : value;
}

export function readDumpValueDeep(value: unknown): unknown {
  const unwrapped = readDumpValue(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(readDumpValueDeep);
  if (!unwrapped || typeof unwrapped !== 'object') return unwrapped;
  return Object.fromEntries(
    Object.entries(unwrapped as Record<string, unknown>)
      .map(([key, item]) => [key, readDumpValueDeep(item)])
  );
}

/** 从 query-node Dump 读取组件 UUID 到类型映射。 */
export function readNodeComponentUuids(nodeDump: unknown): Map<string, string> {
  const components = new Map<string, string>();
  const node = readObject(nodeDump);
  const list = Array.isArray(node.__comps__) ? node.__comps__ : [];
  for (const entry of list) {
    const item = readObject(entry);
    const type = typeof item.type === 'string' ? item.type : null;
    const uuid = readDumpValue(readObject(item.value).uuid);
    if (type && typeof uuid === 'string' && uuid) {
      components.set(uuid, type);
    }
  }
  return components;
}

/**
 * 解析 create-component 的结果。Creator 会为新节点自动挂载 UITransform，
 * 查询组件与 create-component 之间可能出现同类型组件已存在但没有 UUID 差集的竞态。
 */
export function resolveCreatedComponentUuid(
  beforeNodeDump: unknown,
  created: unknown,
  afterNodeDump: unknown,
  componentType: string
): string | null {
  const beforeUuids = readNodeComponentUuids(beforeNodeDump);
  const createdObject = readObject(created);
  const directUuid = typeof created === 'string'
    ? created
    : readDumpValue(createdObject.uuid);
  if (typeof directUuid === 'string' && directUuid && !beforeUuids.has(directUuid)) {
    return directUuid;
  }

  const afterUuids = readNodeComponentUuids(afterNodeDump);
  for (const [uuid, type] of afterUuids) {
    if (!beforeUuids.has(uuid) && type === componentType) {
      return uuid;
    }
  }
  for (const [uuid, type] of afterUuids) {
    if (type === componentType) {
      return uuid;
    }
  }
  return null;
}
