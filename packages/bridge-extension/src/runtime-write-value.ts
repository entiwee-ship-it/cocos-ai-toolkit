/** 运行时引用写值的最小形态。 */
export interface RuntimeWriteReference {
  kind: string;
  [field: string]: unknown;
}

export interface RuntimeWriteValueDependencies {
  resolveReference(reference: RuntimeWriteReference, propertyPath: string): Promise<unknown>;
  createObject?(
    value: Record<string, unknown>,
    propertyPath: string
  ): Promise<unknown | undefined> | unknown | undefined;
  resolveSpecialValue?(
    value: Record<string, unknown>,
    currentValue: unknown,
    propertyPath: string
  ): Promise<unknown | undefined> | unknown | undefined;
}

export function readRuntimeWriteObjectConstructor(
  attributes: Record<string, unknown>,
  propertyName: string
): (new () => unknown) | null {
  const constructor = attributes[`${propertyName}$_$ctor`]
    ?? attributes[`${propertyName}$_$type`];
  return typeof constructor === 'function'
    ? constructor as new () => unknown
    : null;
}

export function readRuntimeWriteClassAttributes(
  legacyClass: unknown,
  ownerConstructor: unknown
): Record<string, unknown> | null {
  if (!isObjectLike(legacyClass)) return null;
  const attributeApi = legacyClass.Attr;
  if (!isObjectLike(attributeApi) || typeof attributeApi.getClassAttrs !== 'function') return null;
  const attributes = attributeApi.getClassAttrs(ownerConstructor) as unknown;
  return isRecord(attributes) ? attributes : null;
}

/**
 * 把协议值递归物化为 Creator 运行时值。
 * 引用交给调用方解析；数组保持顺序；嵌套对象复用当前值原型，避免把 ccclass 实例降级为普通对象。
 */
export async function resolveRuntimeWriteValue(
  value: unknown,
  currentValue: unknown,
  propertyPath: string,
  dependencies: RuntimeWriteValueDependencies
): Promise<unknown> {
  if (Array.isArray(value)) {
    const currentItems = Array.isArray(currentValue) ? currentValue : [];
    return Promise.all(value.map((item, index) => resolveRuntimeWriteValue(
      item,
      currentItems[index],
      `${propertyPath}[${index}]`,
      dependencies
    )));
  }
  if (!isRecord(value)) return value;
  if (typeof value.kind === 'string') {
    return dependencies.resolveReference(value as RuntimeWriteReference, propertyPath);
  }
  const specialValue = await dependencies.resolveSpecialValue?.(value, currentValue, propertyPath);
  if (specialValue !== undefined) return specialValue;

  const createdValue = isRecord(currentValue)
    ? Object.assign(Object.create(Object.getPrototypeOf(currentValue)), currentValue)
    : await dependencies.createObject?.(value, propertyPath);
  const result = isRecord(createdValue) ? createdValue : {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = await resolveRuntimeWriteValue(
      item,
      isRecord(currentValue) ? currentValue[key] : undefined,
      `${propertyPath}.${key}`,
      dependencies
    );
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}
