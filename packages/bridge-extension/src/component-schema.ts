import { classifyValueKind, readDumpValue, readDumpValueDeep, readObject } from './raw-reflection';
import { normalizeSerializedReferences, type NormalizedReference } from './reference-normalizer';

const PROPERTY_CONSUMED_KEYS = new Set([
  'name',
  'value',
  'default',
  'type',
  'readonly',
  'visible',
  'displayName',
  'tooltip',
  'group',
  'range',
  'min',
  'max',
  'step',
  'slide',
  'formerlySerializedAs',
  'enumList',
  'displayOrder',
  'animatable',
  'isArray',
  'elementTypeData',
  'extends'
]);

const INSPECTOR_METADATA_KEYS = [
  'tooltip',
  'group',
  'range',
  'min',
  'max',
  'step',
  'slide',
  'formerlySerializedAs',
  'enumList',
  'displayOrder',
  'animatable',
  'isArray',
  'elementTypeData'
] as const;

const BUILT_IN_COMPONENT_CLASS_PREFIXES = ['cc.', 'sp.', 'dragonBones.'] as const;

export interface ComponentPropertySchemaResult {
  propertyPath: string;
  serializedName: string;
  displayName: string | null;
  declaredType: string | null;
  actualType: string | null;
  valueKind: string;
  nullable: boolean;
  serializable: boolean;
  visible: boolean | null;
  readonly: boolean | null;
  defaultValue: unknown;
  currentValue: unknown;
  inspectorMetadata: Record<string, unknown>;
  rawClassAttributes?: Record<string, unknown>;
  rawConsumedKeys: string[];
  references: NormalizedReference[];
}

export interface ComponentTypeSchemaResult {
  className: string | null;
  qualifiedName: string | null;
  typeId: string | null;
  scriptUuid: string | null;
  scriptPath: string | null;
  inheritance: string[];
  executionOrder: number | null;
  properties: ComponentPropertySchemaResult[];
  rawClassAttributes?: Record<string, unknown>;
  unresolved: Array<{ path: string; reason: string; details?: unknown }>;
}

/**
 * 判断组件类是否由 Creator 引擎或内建扩展命名空间提供。
 *
 * @param className Creator 注册的组件类名。
 * @returns `cc`、Spine、DragonBones 等内建组件返回 true。
 */
export function isBuiltInComponentClass(className: string | null): boolean {
  return className !== null
    && BUILT_IN_COMPONENT_CLASS_PREFIXES.some((prefix) => className.startsWith(prefix));
}

/**
 * 把 Creator query-component Dump 转换为默认组件和自定义组件共用的 Schema。
 *
 * @param rawValue Creator 返回的组件 Dump。
 * @param scriptPathsByUuid 脚本 UUID 到 db 路径的稳定映射。
 * @param includeRaw 是否保留组件和属性的原始 Inspector 属性。
 * @returns 组件类型、属性元数据、引用、未解析项和可选原始 Inspector 属性。
 */
export function buildComponentTypeSchema(
  rawValue: unknown,
  scriptPathsByUuid: ReadonlyMap<string, string> = new Map(),
  includeRaw = true
): ComponentTypeSchemaResult {
  const raw = readObject(rawValue);
  const values = readObject(raw.value);
  const className = readString(raw.type);
  const typeId = readString(raw.cid);
  const inheritance = Array.isArray(raw.extends)
    ? raw.extends.filter((item): item is string => typeof item === 'string')
    : [];
  const scriptUuid = readComponentScriptUuid(raw);
  const scriptPath = scriptUuid ? scriptPathsByUuid.get(scriptUuid) ?? null : null;
  const unresolved: ComponentTypeSchemaResult['unresolved'] = [];
  const properties: ComponentPropertySchemaResult[] = [];

  for (const [propertyPath, propertyValue] of Object.entries(values)) {
    const property = readObject(propertyValue);
    const declaredType = readString(property.type);
    if (!declaredType) {
      unresolved.push({
        path: `properties.${propertyPath}`,
        reason: 'DECLARED_TYPE_MISSING'
      });
    }
    properties.push(buildPropertySchema(propertyPath, propertyValue, includeRaw));
  }

  if (className === 'cc.MissingScript') {
    unresolved.push({
      path: 'className',
      reason: 'SCRIPT_CLASS_NOT_REGISTERED'
    });
  }
  if (scriptUuid && !scriptPath) {
    unresolved.push({
      path: 'scriptPath',
      reason: 'SCRIPT_ASSET_PATH_NOT_FOUND',
      details: { scriptUuid }
    });
  }
  if (className && !isBuiltInComponentClass(className) && !scriptUuid) {
    unresolved.push({
      path: 'scriptUuid',
      reason: 'SCRIPT_UUID_MISSING'
    });
  }

  return {
    className,
    qualifiedName: className,
    typeId,
    scriptUuid,
    scriptPath,
    inheritance,
    executionOrder: readNumber(raw.executionOrder),
    properties,
    ...(includeRaw ? { rawClassAttributes: raw } : {}),
    unresolved
  };
}

/**
 * 读取自定义组件 Dump 中的脚本资源 UUID。
 *
 * @param rawValue Creator 返回的组件 Dump。
 * @returns 脚本 UUID；不存在时返回 null。
 */
export function readComponentScriptUuid(rawValue: unknown): string | null {
  const values = readObject(readObject(rawValue).value);
  const scriptAsset = readObject(values.__scriptAsset);
  const target = readObject(readDumpValue(scriptAsset));
  return readString(target.uuid);
}

/**
 * 从 AssetDB 脚本信息中读取 AI 可复用的稳定路径。
 *
 * @param value query-asset-info 或资产索引中的脚本记录。
 * @returns 优先返回 db URL；不存在时退回磁盘文件路径，再缺失则返回 null。
 */
export function readScriptPathFromAssetInfo(value: unknown): string | null {
  const asset = readObject(value);
  return readString(asset.url) ?? readString(asset.file) ?? readString(asset.filePath);
}

export { normalizeSerializedReferences } from './reference-normalizer';

/**
 * 规范化单个组件属性的类型、Inspector 元数据、当前值和引用列表。
 *
 * @param propertyPath 属性在组件中的序列化路径。
 * @param rawValue Creator 返回的属性包装。
 * @param includeRaw 是否保留属性原始 Inspector 属性。
 * @returns 可直接进入组件 Schema 的属性描述和可选原始 Inspector 属性。
 */
function buildPropertySchema(
  propertyPath: string,
  rawValue: unknown,
  includeRaw: boolean
): ComponentPropertySchemaResult {
  const property = readObject(rawValue);
  const declaredType = readString(property.type);
  const currentValue = readDumpValueDeep(property);
  const defaultValue = 'default' in property ? readDumpValueDeep(property.default) : null;
  const references = normalizeSerializedReferences(property);
  const inspectorMetadata: Record<string, unknown> = {};
  for (const key of INSPECTOR_METADATA_KEYS) {
    if (key in property) inspectorMetadata[key] = property[key];
  }
  const rawConsumedKeys = Object.keys(property)
    .filter((key) => PROPERTY_CONSUMED_KEYS.has(key));

  return {
    propertyPath,
    serializedName: readString(property.name) ?? propertyPath,
    displayName: readString(property.displayName) ?? readString(property.name) ?? propertyPath,
    declaredType,
    actualType: readActualType(declaredType, currentValue),
    valueKind: readPropertyValueKind(
      declaredType,
      currentValue,
      property.extends,
      property.isArray === true,
      references
    ),
    nullable: defaultValue === null || currentValue === null,
    serializable: true,
    visible: readBoolean(property.visible),
    readonly: readBoolean(property.readonly),
    defaultValue,
    currentValue,
    inspectorMetadata,
    ...(includeRaw ? { rawClassAttributes: property } : {}),
    rawConsumedKeys,
    references
  };
}

/**
 * 判断属性在协议中的值类别，同时避免把引用数组降级成标量引用。
 *
 * @param declaredType Creator 声明类型。
 * @param currentValue 已解包的当前值。
 * @param inheritance Creator 声明的继承链。
 * @param isArray Creator 是否明确标记该属性为数组。
 * @param references 当前属性解析出的引用列表。
 * @returns PropertyValueKindSchema 对应字符串。
 */
function readPropertyValueKind(
  declaredType: string | null,
  currentValue: unknown,
  inheritance: unknown,
  isArray: boolean,
  references: NormalizedReference[]
): string {
  if (isArray || Array.isArray(currentValue)) return 'array';
  const concreteKinds = new Set(references.map((reference) =>
    reference.kind === 'missing' ? reference.expectedKind : reference.kind
  ));
  if (concreteKinds.size === 1) {
    const kind = [...concreteKinds][0];
    if (kind === 'node') return 'node-reference';
    if (kind === 'component') return 'component-reference';
    if (kind === 'asset') return 'asset-reference';
  }
  return classifyValueKind(declaredType, currentValue, inheritance);
}

/**
 * 推断 Creator 当前值的实际类型，声明类型存在时优先保留声明。
 *
 * @param declaredType Creator 声明类型。
 * @param value 已解包的当前值。
 * @returns 实际类型名称；无法判断时返回 null。
 */
function readActualType(declaredType: string | null, value: unknown): string | null {
  if (declaredType) return declaredType;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return 'Array';
  if (typeof value === 'object') {
    const object = readObject(value);
    return readString(object.__type__) ?? readString(object.type) ?? 'Object';
  }
  return typeof value;
}

/**
 * 读取非空字符串字段。
 *
 * @param value 待读取值。
 * @returns 非空字符串；其它值返回 null。
 */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 读取布尔字段。
 *
 * @param value 待读取值。
 * @returns 布尔值；其它值返回 null。
 */
function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * 读取数字字段。
 *
 * @param value 待读取值。
 * @returns 数字；其它值返回 null。
 */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
