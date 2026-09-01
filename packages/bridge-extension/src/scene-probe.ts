import { buildComponentTypeSchema, isBuiltInComponentClass } from './component-schema';
import { normalizeProperty, readDumpValue, readObject } from './raw-reflection';

/**
 * 把 Creator query-node Dump 转换为稳定节点结构。
 *
 * @param rawValue Creator 返回的节点 Dump。
 * @param siblingIndex 节点在父节点中的顺序；未知时为 null。
 * @param includeRaw 是否附加节点和组件原始 Dump；默认保留以兼容完整读取。
 * @returns 稳定节点结构；includeRaw 为 true 时附带完整原始 Dump。
 */
export function normalizeNodeDump(
  rawValue: unknown,
  siblingIndex: number | null = null,
  includeRaw = true
) {
  const raw = readObject(rawValue);
  const rawPrefabInfo = readObject(raw.__prefab__);
  const children = Array.isArray(raw.children) ? raw.children : [];
  const components = Array.isArray(raw.__comps__)
    ? raw.__comps__.map((component) => normalizeComponentDump(component, undefined, includeRaw))
    : [];
  return {
    identity: {
      objectUuid: readString(readDumpValue(raw.uuid)),
      fileId: readString(readDumpValue(rawPrefabInfo.fileId))
    },
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
    prefabInstance: normalizePrefabInstanceSummary(raw),
    unresolved: [],
    ...(includeRaw ? { raw } : {})
  };
}

/**
 * 从 query-node Dump 提取紧凑 Prefab 实例身份。
 *
 * @param rawValue Creator 返回的节点 Dump。
 * @returns 实例根标记、源资产 UUID、实例 FileID、状态和待补齐的源 URL。
 */
export function normalizePrefabInstanceSummary(rawValue: unknown) {
  const raw = readObject(rawValue);
  const prefab = readObject(raw.__prefab__);
  const instance = readObject(readDumpValue(prefab.instance));
  const nodeUuid = readString(readDumpValue(raw.uuid));
  const rootUuid = readString(prefab.rootUuid);
  const instanceFileId = readString(readDumpValue(instance.fileId));
  return {
    isInstanceRoot: Boolean(nodeUuid && rootUuid === nodeUuid && instanceFileId),
    prefabAssetUuid: readString(prefab.uuid),
    instanceFileId,
    state: readNumber(readObject(prefab.prefabStateInfo).state),
    sourceUrl: null
  };
}

/**
 * 把 Creator query-component Dump 转换为当前 Bridge 组件结构并携带完整 Schema。
 *
 * @param rawValue Creator 返回的组件 Dump。
 * @param scriptPathsByUuid 脚本资产 UUID 到 db URL 或磁盘路径的索引。
 * @param includeRaw 是否附加组件原始 Dump；默认用于完整读取。
 * @returns 组件身份、类信息、属性摘要、完整 Schema 和未解析项；includeRaw 为 true 时附带原始 Dump。
 */
export function normalizeComponentDump(
  rawValue: unknown,
  scriptPathsByUuid: ReadonlyMap<string, string> = new Map(),
  includeRaw = true
) {
  const raw = readObject(rawValue);
  const values = readObject(raw.value);
  const properties: Record<string, ReturnType<typeof normalizeProperty>> = {};
  for (const [name, property] of Object.entries(values)) {
    properties[name] = normalizeProperty(property, includeRaw);
  }
  const schema = buildComponentTypeSchema(raw, scriptPathsByUuid, includeRaw);
  return {
    identity: {
      objectUuid: readString(readDumpValue(values.uuid)),
      fileId: readComponentFileId(rawValue)
    },
    class: {
      className: schema.className,
      typeId: schema.typeId,
      custom: Boolean(schema.className && !isBuiltInComponentClass(schema.className)),
      scriptUuid: schema.scriptUuid,
      scriptPath: schema.scriptPath,
      inheritance: schema.inheritance
    },
    properties,
    schema,
    unresolved: schema.unresolved,
    ...(includeRaw ? { raw } : {})
  };
}

/**
 * 从 Creator query-component Dump 读取稳定 Prefab FileID。
 *
 * @param rawValue Creator 返回的组件 Dump。
 * @returns 找到时返回组件 FileID；当前组件不属于 Prefab 时返回 null。
 */
export function readComponentFileId(rawValue: unknown): string | null {
  const raw = readObject(rawValue);
  return readPrefabFileId(raw, readObject(raw.value));
}

/**
 * 把 Creator 节点树归一化，并按深度截断。
 *
 * @param treeValue Creator 返回的节点树。
 * @param depth 允许展开的最大层级。
 * @param includeRaw 是否在每个节点附加原始子树；默认保留以兼容完整读取。
 * @returns 归一化节点树；includeRaw 为 false 时不会夹带递归原始树。
 */
export function normalizeHierarchyTree(treeValue: unknown, depth: number, includeRaw = true): unknown {
  const visit = (value: unknown, level: number, siblingIndex: number): unknown => {
    const tree = readObject(value);
    const sourceChildren = Array.isArray(tree.children) ? tree.children : [];
    const children = level < depth ? sourceChildren : [];
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
      truncated: readBoolean(tree.truncated) === true || (level >= depth && sourceChildren.length > 0),
      children: children.map((child, index) => visit(child, level + 1, index)),
      ...(includeRaw ? { raw: tree } : {})
    };
  };
  return visit(treeValue, 0, 0);
}

/**
 * 把 Creator 节点 Dump 中的 PrefabInfo 和 PrefabInstance 规范化为只读协议。
 *
 * @param rawNodeValue Creator 返回的实例根节点 Dump。
 * @param ownerDocumentAssetUuid 当前打开 Scene 或 Prefab 的 Asset UUID。
 * @param hostNodePath 当前实例根在宿主文档中的节点路径。
 * @returns 来源 UUID、FileID、Override、挂载项、未解析项和原始 PrefabInfo。
 */
export function normalizePrefabDump(
  rawNodeValue: unknown,
  ownerDocumentAssetUuid: string | null,
  hostNodePath: string | null = null
) {
  const rawNode = readObject(rawNodeValue);
  const rawPrefabInfo = readObject(rawNode.__prefab__);
  const instance = readObject(rawPrefabInfo.instance);
  const instanceValues = readObject(readDumpValue(instance));
  const sourcePrefabAssetUuid = readString(rawPrefabInfo.uuid);
  const sourceObjectFileId = readString(rawPrefabInfo.fileId);
  const instanceFileId = readString(readDumpValue(instanceValues.fileId));
  const undefinedOverrideIndexes = new Set<number>();
  const propertyOverrides = readDumpArray(instanceValues.propertyOverrides).map((entry, index) => {
    const value = readObject(readDumpValue(entry));
    const targetInfo = readObject(readDumpValue(value.targetInfo));
    const rawOverrideValue = readDumpValue(value.value);
    if (rawOverrideValue === undefined) undefinedOverrideIndexes.add(index);
    return {
      index,
      targetLocalIds: readStringDumpArray(readObject(targetInfo.localID).value),
      propertyPath: readStringDumpArray(readObject(value.propertyPath).value),
      declaredType: readString(readObject(value.value).type),
      sourceValue: null,
      overrideValue: toSerializableValue(rawOverrideValue),
      effectiveValue: null,
      raw: entry
    };
  });
  const unresolved: Array<{ path: string; reason: string }> = [];
  if (!sourcePrefabAssetUuid) {
    unresolved.push({
      path: 'sourcePrefabAssetUuid',
      reason: 'SOURCE_PREFAB_ASSET_UUID_MISSING'
    });
  }
  if (!sourceObjectFileId) {
    unresolved.push({
      path: 'sourceObjectFileId',
      reason: 'SOURCE_OBJECT_FILE_ID_MISSING'
    });
  }
  if (!instanceFileId) {
    unresolved.push({
      path: 'instanceFileId',
      reason: 'PREFAB_INSTANCE_FILE_ID_MISSING'
    });
  }
  for (let index = 0; index < propertyOverrides.length; index += 1) {
    if (undefinedOverrideIndexes.has(index)) {
      unresolved.push({
        path: `propertyOverrides.${index}.overrideValue`,
        reason: 'CREATOR_OVERRIDE_VALUE_UNDEFINED'
      });
    }
    unresolved.push({ path: `propertyOverrides.${index}.sourceValue`, reason: 'SOURCE_VALUE_REQUIRES_PREFAB_SOURCE_LOOKUP' });
    unresolved.push({ path: `propertyOverrides.${index}.effectiveValue`, reason: 'EFFECTIVE_VALUE_REQUIRES_TARGET_RESOLUTION' });
  }
  return {
    ownerDocumentAssetUuid,
    hostNodePath,
    sourcePrefabAssetUuid,
    instanceRootObjectUuid: readString(rawPrefabInfo.rootUuid) ?? readString(readDumpValue(rawNode.uuid)),
    sourceObjectFileId,
    instanceFileId,
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

interface NestedPrefabTargetMap {
  targets: Record<string, { assetUuid: string; fileId: string; nodePath: string | null }>;
  children: Record<string, NestedPrefabTargetMap>;
}

/**
 * 使用源资源、实例运行态和可选嵌套 TargetMap 补齐 Override 三值。
 *
 * @param prefab 已规范化但尚未补齐源值和最终值的 Prefab 数据。
 * @param sourceRoot 源 Prefab 的运行时根对象。
 * @param effectiveRoot 当前实例的运行时根对象。
 * @param nestedTargetMaps 多段 localID 对应的跨 Prefab TargetMap。
 * @returns 保留 Override 值并补齐源值、最终值和失败诊断的新 Prefab 数据。
 */
export function resolvePrefabOverrideValues(
  prefab: ResolvablePrefabDump,
  sourceRoot: unknown,
  effectiveRoot: unknown,
  nestedTargetMaps?: NestedPrefabTargetMap
): ResolvablePrefabDump {
  const sourceTargets = buildFileIdIndex(sourceRoot);
  const effectiveTargets = buildFileIdIndex(effectiveRoot);
  const unresolved = prefab.unresolved.filter((entry) =>
    !/^propertyOverrides\.\d+\.(sourceValue|effectiveValue)$/.test(entry.path)
  );
  const propertyOverrides = prefab.propertyOverrides.map((entry) => {
    const nestedTarget = entry.targetLocalIds.length > 1 && nestedTargetMaps
      ? resolveNestedPrefabTarget(entry.targetLocalIds, nestedTargetMaps)
      : null;
    const targetFileId = entry.targetLocalIds.length === 1
      ? entry.targetLocalIds[0]
      : nestedTarget?.target?.fileId ?? null;
    const source = targetFileId ? readPropertyPath(sourceTargets.get(targetFileId), entry.propertyPath) : { found: false, value: null };
    const effective = targetFileId ? readPropertyPath(effectiveTargets.get(targetFileId), entry.propertyPath) : { found: false, value: null };
    if (!source.found) {
      unresolved.push({
        path: `propertyOverrides.${entry.index}.sourceValue`,
        reason: nestedTarget?.failedSegmentIndex !== undefined
          ? `NESTED_TARGET_MAP_SEGMENT_NOT_FOUND_AT_${nestedTarget.failedSegmentIndex}`
          : readTargetResolutionReason(entry.targetLocalIds, targetFileId, 'SOURCE_TARGET_OR_PROPERTY_NOT_FOUND')
      });
    }
    if (!effective.found) {
      unresolved.push({
        path: `propertyOverrides.${entry.index}.effectiveValue`,
        reason: nestedTarget?.failedSegmentIndex !== undefined
          ? `NESTED_TARGET_MAP_SEGMENT_NOT_FOUND_AT_${nestedTarget.failedSegmentIndex}`
          : readTargetResolutionReason(entry.targetLocalIds, targetFileId, 'EFFECTIVE_TARGET_OR_PROPERTY_NOT_FOUND')
      });
    }
    return {
      ...entry,
      sourceValue: source.found ? toSerializableValue(source.value) : null,
      effectiveValue: effective.found ? toSerializableValue(effective.value) : null
    };
  });
  return { ...prefab, propertyOverrides, unresolved };
}

/**
 * 在嵌套 TargetMap 中逐段解析多段 localID。
 *
 * @param localIds Creator TargetInfo 中按层级排列的 localID 数组。
 * @param targetMaps 当前实例上下文的嵌套 TargetMap。
 * @returns 最终目标；失败时同时返回失败段索引。
 */
function resolveNestedPrefabTarget(
  localIds: string[],
  targetMaps: NestedPrefabTargetMap
): { target: { assetUuid: string; fileId: string; nodePath: string | null } | null; failedSegmentIndex?: number } {
  let current = targetMaps;
  for (let index = 0; index < localIds.length; index += 1) {
    const localId = localIds[index];
    const target = current.targets[localId];
    const child = current.children[localId];
    if (index === localIds.length - 1) {
      return target ? { target } : { target: null, failedSegmentIndex: index };
    }
    if (!child) return { target: null, failedSegmentIndex: index + 1 };
    current = child;
  }
  return { target: null, failedSegmentIndex: localIds.length - 1 };
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

/**
 * 把 Creator 运行态值转换为 JSON 可稳定表达的值和引用标记。
 *
 * @param value Creator Dump 或运行态属性值。
 * @param depth 当前递归深度。
 * @param visited 当前递归链中已经访问的对象。
 * @returns 可通过 WebSocket JSON 往返的值。
 */
function toSerializableValue(value: unknown, depth = 0, visited = new Set<unknown>()): unknown {
  if (value === undefined) return { kind: 'undefined', source: 'creator-dump' };
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

/**
 * 从节点或组件 Dump 的多种 Prefab 字段命名中读取 FileID。
 *
 * @param values 可能包含 `__prefab__`、`__prefab`、`_prefab` 或 `prefab` 的 Dump 对象。
 * @returns 首个有效 FileID；不存在时返回 null。
 */
function readPrefabFileId(...values: Record<string, unknown>[]): string | null {
  for (const value of values) {
    for (const key of ['__prefab__', '__prefab', '_prefab', 'prefab']) {
      const prefab = readObject(readDumpValue(value[key]));
      const fileId = readString(readDumpValue(prefab.fileId));
      if (fileId) return fileId;
    }
  }
  return null;
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
