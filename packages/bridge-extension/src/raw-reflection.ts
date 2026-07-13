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
  const rawValue = 'value' in property ? property.value : value;
  return {
    declaredType,
    valueKind: classifyValueKind(declaredType, rawValue, property.extends),
    value: rawValue,
    visible: typeof property.visible === 'boolean' ? property.visible : null,
    readonly: typeof property.readonly === 'boolean' ? property.readonly : null,
    raw: value
  };
}

export function classifyValueKind(type: string | null, value: unknown, extendsValue: unknown): string {
  const inheritance = Array.isArray(extendsValue) ? extendsValue.filter((item): item is string => typeof item === 'string') : [];
  if (type === 'cc.Node') return 'node-reference';
  if (inheritance.includes('cc.Component') || type?.endsWith('Component')) return 'component-reference';
  if (inheritance.includes('cc.Asset') || type?.endsWith('Asset') || type === 'cc.SpriteFrame' || type === 'cc.Prefab') return 'asset-reference';
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'object';
  return typeof value;
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
