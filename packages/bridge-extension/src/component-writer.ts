import { ProbeError } from './probe-errors';
import { isBuiltInComponentClass } from './component-schema';
import type { WriteOperation } from './transaction-manager';

/** 组件属性写入校验所需的最小 Schema（来自 Phase 1 组件 Schema）。 */
export interface ComponentPropertyWriteSchema {
  propertyPath: string;
  declaredType: string | null;
  readonly: boolean | null;
  isArray: boolean | null;
}

/** 组件写操作的可序列化证据快照。 */
export interface ComponentInfo {
  uuid: string;
  type: string;
  nodeUuid: string;
  enabled: boolean;
  /** 自定义脚本组件的脚本资产 UUID；内置组件为 null。 */
  scriptUuid?: string | null;
  properties: Record<string, unknown>;
  schema: ComponentPropertyWriteSchema[];
}

/** 引用写入值，结构与协议包 ReferenceSchema 对齐。 */
export interface WriteReferenceValue {
  kind: string;
  available?: boolean;
  [field: string]: unknown;
}

/**
 * 组件写依赖。全部由 Scene 进程真实能力注入，本模块只做编排，
 * 不直接触碰 Editor 全局对象或磁盘文件。
 */
export interface ComponentWriterDependencies {
  getComponentInfo(componentUuid: string): Promise<ComponentInfo | null>;
  nodeExists(nodeUuid: string): Promise<boolean>;
  addComponent(nodeUuid: string, componentType: string, scriptUuid: string | null): Promise<string>;
  removeComponent(componentUuid: string): Promise<void>;
  setComponentEnabled(componentUuid: string, enabled: boolean): Promise<void>;
  getComponentProperty(componentUuid: string, propertyPath: string): Promise<unknown>;
  setComponentProperty(componentUuid: string, propertyPath: string, value: unknown): Promise<void>;
  resizeComponentArray(componentUuid: string, propertyPath: string, length: number): Promise<void>;
  /** 核对引用目标在编辑器中真实可解析（节点/组件/资产存在）。 */
  resolveReference(reference: WriteReferenceValue): Promise<boolean>;
}

export interface ComponentWriteOpResult {
  componentUuid: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** 显式逆操作序列，供 step-undo-with-inverse 回滚路径使用。 */
  inverse: WriteOperation[];
}

/**
 * 把 items[2]、settings.colors[0]、clickEvents[0].handler 这类路径解析为段序列。
 *
 * @param propertyPath 属性路径。
 * @returns 字符串属性名和数字数组下标交替的段数组。
 */
export function parsePropertyPath(propertyPath: string): Array<string | number> {
  if (!propertyPath) {
    throw new ProbeError('INVALID_PROPERTY_PATH', { propertyPath });
  }
  const segments: Array<string | number> = [];
  for (const part of propertyPath.split('.')) {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*(?<indexes>(?:\[\d+\])*)$/.exec(part);
    if (!match) {
      throw new ProbeError('INVALID_PROPERTY_PATH', { propertyPath });
    }
    const name = part.slice(0, match.groups?.indexes ? part.length - match.groups.indexes.length : undefined);
    segments.push(name);
    for (const index of match.groups?.indexes.match(/\d+/g) ?? []) {
      segments.push(Number(index));
    }
  }
  return segments;
}

/**
 * 执行单个组件原子写操作，返回 before/after 证据和显式逆操作。
 * 只允许在事务上下文内由写执行器调用；写入前按 Phase 1 组件 Schema 校验
 * 属性存在性、可写性（readonly 拒绝），引用写入前核对目标可解析。
 *
 * @param operation 组件写操作（component.* 七类之一）。
 * @param dependencies Scene 侧真实能力。
 * @returns 写操作证据。
 */
export async function executeComponentWriteOperation(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  switch (operation.type) {
    case 'component.add':
      return addComponent(operation, dependencies);
    case 'component.remove':
      return removeComponent(operation, dependencies);
    case 'component.enable':
      return enableComponent(operation, dependencies);
    case 'component.set_property':
      return setComponentProperty(operation, dependencies);
    case 'component.set_reference':
      return setComponentReference(operation, dependencies);
    case 'component.clear_reference':
      return clearComponentReference(operation, dependencies);
    case 'component.resize_array':
      return resizeComponentArray(operation, dependencies);
    default:
      throw new ProbeError('INVALID_WRITE_OPERATION', { type: operation.type });
  }
}

async function addComponent(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  const nodeUuid = operation.nodeUuid as string;
  if (!await dependencies.nodeExists(nodeUuid)) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid });
  }
  const componentType = operation.componentType as string;
  const scriptUuid = (operation.scriptUuid as string | null) ?? null;
  if (scriptUuid !== null && isBuiltInComponentClass(componentType)) {
    // 内置组件不允许携带脚本 UUID，防止调用方混淆挂载路径。
    throw new ProbeError('INVALID_WRITE_OPERATION', { type: operation.type, field: 'scriptUuid' });
  }
  const componentUuid = await dependencies.addComponent(nodeUuid, componentType, scriptUuid);
  if (!componentUuid) {
    throw new ProbeError('COMPONENT_ADD_FAILED', { nodeUuid, componentType });
  }
  const after = await requireComponentInfo(dependencies, componentUuid);
  return {
    componentUuid,
    before: null,
    after: { uuid: componentUuid, type: after.type, enabled: after.enabled },
    inverse: [{ type: 'component.remove', componentUuid }]
  };
}

async function removeComponent(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  const componentUuid = operation.componentUuid as string;
  const before = await requireComponentInfo(dependencies, componentUuid);
  await dependencies.removeComponent(componentUuid);
  return {
    componentUuid,
    before: { uuid: componentUuid, type: before.type, nodeUuid: before.nodeUuid, enabled: before.enabled },
    after: null,
    // 逆操作为尽力重挂：属性值无法经逆操作还原，深度回滚依赖编辑器 Undo。
    inverse: [{
      type: 'component.add',
      nodeUuid: before.nodeUuid,
      componentType: before.type,
      scriptUuid: before.scriptUuid ?? null
    }]
  };
}

async function enableComponent(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  const componentUuid = operation.componentUuid as string;
  const before = await requireComponentInfo(dependencies, componentUuid);
  await dependencies.setComponentEnabled(componentUuid, operation.enabled as boolean);
  const after = await requireComponentInfo(dependencies, componentUuid);
  return {
    componentUuid,
    before: { uuid: componentUuid, enabled: before.enabled },
    after: { uuid: componentUuid, enabled: after.enabled },
    inverse: [{ type: 'component.enable', componentUuid, enabled: before.enabled }]
  };
}

async function setComponentProperty(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  const componentUuid = operation.componentUuid as string;
  const propertyPath = operation.propertyPath as string;
  const info = await requireComponentInfo(dependencies, componentUuid);
  const segments = parsePropertyPath(propertyPath);
  assertWritableSchema(info, segments);
  const oldValue = readValueAtPath(info.properties, segments, propertyPath);
  if ('expectedOldValue' in operation && operation.expectedOldValue !== undefined
    && !deepEqual(operation.expectedOldValue, oldValue)) {
    // 乐观锁：调用方声明的旧值与当前值不一致时零写入拒绝。
    throw new ProbeError('PROPERTY_VALUE_CONFLICT', {
      componentUuid,
      propertyPath,
      expected: operation.expectedOldValue,
      actual: oldValue
    });
  }
  await dependencies.setComponentProperty(componentUuid, propertyPath, operation.value);
  const actual = await dependencies.getComponentProperty(componentUuid, propertyPath);
  return {
    componentUuid,
    before: { uuid: componentUuid, propertyPath, value: oldValue },
    after: { uuid: componentUuid, propertyPath, value: actual },
    inverse: [{ type: 'component.set_property', componentUuid, propertyPath, value: oldValue }]
  };
}

async function setComponentReference(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  const componentUuid = operation.componentUuid as string;
  const propertyPath = operation.propertyPath as string;
  const info = await requireComponentInfo(dependencies, componentUuid);
  const segments = parsePropertyPath(propertyPath);
  assertWritableSchema(info, segments);
  const reference = operation.reference as WriteReferenceValue;
  if (reference.kind === 'missing' || reference.available === false) {
    throw new ProbeError('REFERENCE_NOT_AVAILABLE', { componentUuid, propertyPath, kind: reference.kind });
  }
  if (!await dependencies.resolveReference(reference)) {
    throw new ProbeError('REFERENCE_TARGET_NOT_FOUND', { componentUuid, propertyPath, reference });
  }
  const oldValue = readValueAtPath(info.properties, segments, propertyPath);
  await dependencies.setComponentProperty(componentUuid, propertyPath, reference);
  const actual = await dependencies.getComponentProperty(componentUuid, propertyPath);
  return {
    componentUuid,
    before: { uuid: componentUuid, propertyPath, reference: oldValue },
    after: { uuid: componentUuid, propertyPath, reference: actual },
    inverse: [{ type: 'component.set_property', componentUuid, propertyPath, value: oldValue }]
  };
}

async function clearComponentReference(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  const componentUuid = operation.componentUuid as string;
  const propertyPath = operation.propertyPath as string;
  const info = await requireComponentInfo(dependencies, componentUuid);
  const segments = parsePropertyPath(propertyPath);
  assertWritableSchema(info, segments);
  const oldValue = readValueAtPath(info.properties, segments, propertyPath);
  await dependencies.setComponentProperty(componentUuid, propertyPath, null);
  const actual = await dependencies.getComponentProperty(componentUuid, propertyPath);
  return {
    componentUuid,
    before: { uuid: componentUuid, propertyPath, reference: oldValue },
    after: { uuid: componentUuid, propertyPath, reference: actual },
    inverse: oldValue === null || oldValue === undefined
      ? []
      : [{ type: 'component.set_reference', componentUuid, propertyPath, reference: oldValue }]
  };
}

async function resizeComponentArray(
  operation: WriteOperation,
  dependencies: ComponentWriterDependencies
): Promise<ComponentWriteOpResult> {
  const componentUuid = operation.componentUuid as string;
  const propertyPath = operation.propertyPath as string;
  const info = await requireComponentInfo(dependencies, componentUuid);
  const segments = parsePropertyPath(propertyPath);
  const schemaProperty = findSchemaProperty(info, segments);
  if (schemaProperty?.isArray === false) {
    throw new ProbeError('PROPERTY_NOT_ARRAY', { componentUuid, propertyPath });
  }
  const current = readValueAtPath(info.properties, segments, propertyPath);
  if (!Array.isArray(current)) {
    throw new ProbeError('PROPERTY_NOT_ARRAY', { componentUuid, propertyPath });
  }
  const oldLength = current.length;
  const length = operation.length as number;
  await dependencies.resizeComponentArray(componentUuid, propertyPath, length);
  const resized = await dependencies.getComponentProperty(componentUuid, propertyPath);
  return {
    componentUuid,
    before: { uuid: componentUuid, propertyPath, length: oldLength },
    after: { uuid: componentUuid, propertyPath, length: Array.isArray(resized) ? resized.length : null },
    inverse: [{ type: 'component.resize_array', componentUuid, propertyPath, length: oldLength }]
  };
}

/** 按 Schema 校验顶层属性存在且可写；readonly 拒绝。 */
function assertWritableSchema(info: ComponentInfo, segments: Array<string | number>): void {
  const schemaProperty = findSchemaProperty(info, segments);
  if (info.schema.length > 0 && !schemaProperty) {
    throw new ProbeError('PROPERTY_NOT_FOUND', {
      componentUuid: info.uuid,
      propertyPath: String(segments[0])
    });
  }
  if (schemaProperty?.readonly === true) {
    throw new ProbeError('PROPERTY_READONLY', {
      componentUuid: info.uuid,
      propertyPath: String(segments[0])
    });
  }
}

function findSchemaProperty(
  info: ComponentInfo,
  segments: Array<string | number>
): ComponentPropertyWriteSchema | undefined {
  const topLevel = String(segments[0]);
  return info.schema.find((property) => property.propertyPath === topLevel);
}

/**
 * 沿段序列读取当前值。数字段要求容器为数组且不越界；
 * 中间容器为 null/undefined 且路径未尽时拒绝遍历。
 */
function readValueAtPath(
  container: Record<string, unknown>,
  segments: Array<string | number>,
  propertyPath: string
): unknown {
  let current: unknown = container;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        throw new ProbeError('PROPERTY_NOT_ARRAY', { propertyPath });
      }
      if (segment >= current.length) {
        throw new ProbeError('ARRAY_INDEX_OUT_OF_BOUNDS', { propertyPath, index: segment, length: current.length });
      }
      current = current[segment];
      continue;
    }
    if (current === null || current === undefined || typeof current !== 'object') {
      throw new ProbeError('PROPERTY_PATH_NOT_TRAVERSABLE', { propertyPath, segment });
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

async function requireComponentInfo(
  dependencies: ComponentWriterDependencies,
  componentUuid: string
): Promise<ComponentInfo> {
  const info = await dependencies.getComponentInfo(componentUuid);
  if (!info) {
    throw new ProbeError('COMPONENT_NOT_FOUND', { componentUuid });
  }
  return info;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key]
    ));
  }
  return false;
}
