import { buildComponentTypeSchema, readComponentScriptUuid } from './component-schema';
import { normalizeProperty, readDumpValue, readObject } from './raw-reflection';

/**
 * 把 Creator query-node Dump 转换为稳定节点结构。
 *
 * @param rawValue Creator 返回的节点 Dump。
 * @param siblingIndex 节点在父节点中的顺序；未知时为 null。
 * @returns 保留完整原始 Dump 的节点结构。
 */
export function normalizeNodeDump(rawValue: unknown, siblingIndex: number | null = null) {
  const raw = readObject(rawValue);
  const children = Array.isArray(raw.children) ? raw.children : [];
  const components = Array.isArray(raw.__comps__)
    ? raw.__comps__.map((component) => normalizeComponentDump(component))
    : [];
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

/**
 * 把 Creator query-component Dump 转换为兼容旧探针并携带完整 Schema 的组件结构。
 *
 * @param rawValue Creator 返回的组件 Dump。
 * @param scriptPath 由脚本资产 UUID 解析出的 db URL 或磁盘路径。
 * @returns 组件身份、类信息、属性摘要、完整 Schema、未解析项和原始 Dump。
 */
export function normalizeComponentDump(rawValue: unknown, scriptPath: string | null = null) {
  const raw = readObject(rawValue);
  const values = readObject(raw.value);
  const properties: Record<string, ReturnType<typeof normalizeProperty>> = {};
  for (const [name, property] of Object.entries(values)) {
    properties[name] = normalizeProperty(property);
  }
  const scriptUuid = readComponentScriptUuid(raw);
  const scriptPathsByUuid = scriptUuid && scriptPath
    ? new Map([[scriptUuid, scriptPath]])
    : new Map<string, string>();
  const schema = buildComponentTypeSchema(raw, scriptPathsByUuid);
  return {
    identity: { objectUuid: readString(readDumpValue(values.uuid)), fileId: null },
    class: {
      className: schema.className,
      typeId: schema.typeId,
      custom: Boolean(schema.className && !schema.className.startsWith('cc.')),
      scriptUuid: schema.scriptUuid,
      scriptPath: schema.scriptPath,
      inheritance: schema.inheritance
    },
    properties,
    schema,
    unresolved: schema.unresolved,
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

export function normalizePrefabDump(rawNodeValue: unknown, ownerDocumentAssetUuid: string | null) {
  const rawNode = readObject(rawNodeValue);
  const rawPrefabInfo = readObject(rawNode.__prefab__);
  const instance = readObject(rawPrefabInfo.instance);
  const instanceValues = readObject(readDumpValue(instance));
  const propertyOverrides = readDumpArray(instanceValues.propertyOverrides).map((entry, index) => {
    const value = readObject(readDumpValue(entry));
    const targetInfo = readObject(readDumpValue(value.targetInfo));
    return {
      index,
      targetLocalIds: readStringDumpArray(readObject(targetInfo.localID).value),
      propertyPath: readStringDumpArray(readObject(value.propertyPath).value),
      declaredType: readString(readObject(value.value).type),
      sourceValue: null,
      overrideValue: readDumpValue(value.value),
      effectiveValue: null,
      raw: entry
    };
  });
  const unresolved: Array<{ path: string; reason: string }> = [];
  for (let index = 0; index < propertyOverrides.length; index += 1) {
    unresolved.push({ path: `propertyOverrides.${index}.sourceValue`, reason: 'SOURCE_VALUE_REQUIRES_PREFAB_SOURCE_LOOKUP' });
    unresolved.push({ path: `propertyOverrides.${index}.effectiveValue`, reason: 'EFFECTIVE_VALUE_REQUIRES_TARGET_RESOLUTION' });
  }
  return {
    ownerDocumentAssetUuid,
    sourcePrefabAssetUuid: readString(rawPrefabInfo.uuid),
    instanceRootObjectUuid: readString(rawPrefabInfo.rootUuid) ?? readString(readDumpValue(rawNode.uuid)),
    sourceObjectFileId: readString(rawPrefabInfo.fileId),
    instanceFileId: readString(readDumpValue(instanceValues.fileId)),
    prefabRootNodeUuid: readUuid(readDumpValue(instanceValues.prefabRootNode)),
    sync: readBoolean(rawPrefabInfo.sync),
    state: rawPrefabInfo.prefabStateInfo ?? null,
    propertyOverrides,
    targetOverrides: readDumpArray(instanceValues.targetOverrides),
    mountedChildren: readDumpArray(instanceValues.mountedChildren),
    mountedComponents: readDumpArray(instanceValues.mountedComponents),
    removedComponents: readDumpArray(instanceValues.removedComponents),
    unresolved,
    rawPrefabInfo
  };
}

interface ResolvablePrefabOverride {
  index: number;
  targetLocalIds: string[];
  propertyPath: string[];
  sourceValue: unknown;
  overrideValue: unknown;
  effectiveValue: unknown;
  [key: string]: unknown;
}

interface ResolvablePrefabDump {
  propertyOverrides: ResolvablePrefabOverride[];
  unresolved: Array<{ path: string; reason: string }>;
  [key: string]: unknown;
}

export function resolvePrefabOverrideValues(
  prefab: ResolvablePrefabDump,
  sourceRoot: unknown,
  effectiveRoot: unknown
): ResolvablePrefabDump {
  const sourceTargets = buildFileIdIndex(sourceRoot);
  const effectiveTargets = buildFileIdIndex(effectiveRoot);
  const unresolved = prefab.unresolved.filter((entry) =>
    !/^propertyOverrides\.\d+\.(sourceValue|effectiveValue)$/.test(entry.path)
  );
  const propertyOverrides = prefab.propertyOverrides.map((entry) => {
    const targetFileId = entry.targetLocalIds.length === 1 ? entry.targetLocalIds[0] : null;
    const source = targetFileId ? readPropertyPath(sourceTargets.get(targetFileId), entry.propertyPath) : { found: false, value: null };
    const effective = targetFileId ? readPropertyPath(effectiveTargets.get(targetFileId), entry.propertyPath) : { found: false, value: null };
    if (!source.found) {
      unresolved.push({ path: `propertyOverrides.${entry.index}.sourceValue`, reason: readTargetResolutionReason(entry.targetLocalIds, targetFileId, 'SOURCE_TARGET_OR_PROPERTY_NOT_FOUND') });
    }
    if (!effective.found) {
      unresolved.push({ path: `propertyOverrides.${entry.index}.effectiveValue`, reason: readTargetResolutionReason(entry.targetLocalIds, targetFileId, 'EFFECTIVE_TARGET_OR_PROPERTY_NOT_FOUND') });
    }
    return {
      ...entry,
      sourceValue: source.found ? toSerializableValue(source.value) : null,
      effectiveValue: effective.found ? toSerializableValue(effective.value) : null
    };
  });
  return { ...prefab, propertyOverrides, unresolved };
}

function readTargetResolutionReason(targetLocalIds: string[], targetFileId: string | null, missingReason: string): string {
  if (targetLocalIds.length === 0) return 'TARGET_LOCAL_ID_MISSING';
  if (targetLocalIds.length > 1) return 'MULTI_SEGMENT_TARGET_LOCAL_ID_REQUIRES_NESTED_TARGET_MAP';
  return targetFileId ? missingReason : 'TARGET_LOCAL_ID_MISSING';
}

function buildFileIdIndex(root: unknown): Map<string, unknown> {
  const index = new Map<string, unknown>();
  const visited = new Set<unknown>();
  const visitNode = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const node = value as Record<string, unknown>;
    const nodeFileId = readRuntimeFileId(node);
    if (nodeFileId) index.set(nodeFileId, value);
    for (const component of readRuntimeArray(node, ['components', '_components', '__comps__'])) {
      if (!component || typeof component !== 'object') continue;
      const componentFileId = readRuntimeFileId(component as Record<string, unknown>);
      if (componentFileId) index.set(componentFileId, component);
    }
    for (const child of readRuntimeArray(node, ['children', '_children'])) visitNode(child);
  };
  visitNode(root);
  return index;
}

function readRuntimeFileId(value: Record<string, unknown>): string | null {
  for (const key of ['_prefab', '__prefab__', '__prefab', 'prefab']) {
    const prefab = readObject(value[key]);
    const fileId = readString(readDumpValue(prefab.fileId));
    if (fileId) return fileId;
  }
  return null;
}

function readRuntimeArray(value: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function readPropertyPath(target: unknown, propertyPath: string[]): { found: boolean; value: unknown } {
  if (!target) return { found: false, value: null };
  let current: unknown = target;
  for (const key of propertyPath) {
    if (!current || typeof current !== 'object' || !(key in current)) return { found: false, value: null };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function toSerializableValue(value: unknown, depth = 0, visited = new Set<unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (visited.has(value)) return { kind: 'circular-reference' };
  const object = value as Record<string, unknown>;
  const objectUuid = readString(object.uuid) ?? readString(object._uuid);
  if (objectUuid && (Array.isArray(object.children) || Array.isArray(object._children))) {
    return { kind: 'node-reference', objectUuid };
  }
  if (objectUuid && object.node) return { kind: 'component-reference', objectUuid };
  if (objectUuid) return { kind: 'asset-reference', assetUuid: objectUuid };
  if (depth >= 4) return { kind: 'object', truncated: true };
  visited.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => toSerializableValue(item, depth + 1, visited));
    visited.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    if (key === '_prefab' || key === '__prefab__' || key === '__prefab' || key === 'parent' || key === '_parent' || key === 'children' || key === '_children' || key === 'components' || key === '_components') continue;
    if (typeof child === 'function') continue;
    result[key] = toSerializableValue(child, depth + 1, visited);
  }
  visited.delete(value);
  return result;
}

function readDumpArray(value: unknown): unknown[] {
  const unwrapped = readDumpValue(value);
  return Array.isArray(unwrapped) ? unwrapped : [];
}

function readStringDumpArray(value: unknown): string[] {
  const result: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = readString(readDumpValue(item));
    if (text !== null) result.push(text);
  }
  return result;
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
