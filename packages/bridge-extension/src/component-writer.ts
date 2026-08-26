import { ProbeError } from './probe-errors';
import { isBuiltInComponentClass } from './component-schema';
import type { WriteOperation } from './write-types';

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
  nodeStablePath?: string | null;
  sameTypeIndex?: number;
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

/** 脚本编译/注册等待结果；diagnostics 保留完整编译诊断。 */
export interface ScriptCompilationResult {
  success: boolean;
  diagnostics: string[];
}

/**
 * 自定义脚本挂载守卫依赖。编译等待链路按 Task 3 实测结论实现：
 * refresh-asset 触发重新导入与异步编译，类重注册用有界轮询观察（广播事件不可用），
 * 不允许固定延时盲等。
 */
export interface ScriptMountGuardDependencies {
  /** 核对 scriptUuid 在资产索引中存在。 */
  scriptAssetExists(scriptUuid: string): Promise<boolean>;
  /** 核对脚本类已注册（js.getClassByName/cc.Class 可达）。 */
  isScriptClassRegistered(componentType: string, scriptUuid: string): Promise<boolean>;
  /** 脚本刚变更时触发重编译并等待类注册完成；无编译 pending 时返回 null。 */
  waitForScriptCompilation(scriptUuid: string, componentType: string): Promise<ScriptCompilationResult | null>;
  /** Phase 1 组件 Schema 是否可取（属性校验和重读验证的前提）。 */
  isComponentSchemaAvailable(componentType: string): Promise<boolean>;
}

/**
 * 组件写依赖。全部由 Scene 进程真实能力注入，本模块只做编排，
 * 不直接触碰 Editor 全局对象或磁盘文件。
 */
export interface ComponentWriterDependencies {
  getComponentInfo(componentUuid: string): Promise<ComponentInfo | null>;
  findComponentInfo(nodeUuid: string, componentType: string): Promise<ComponentInfo | null>;
  nodeExists(nodeUuid: string): Promise<boolean>;
  addComponent(nodeUuid: string, componentType: string, scriptUuid: string | null): Promise<string>;
  removeComponent(componentUuid: string): Promise<void>;
  setComponentEnabled(componentUuid: string, enabled: boolean): Promise<void>;
  getComponentProperty(componentUuid: string, propertyPath: string): Promise<unknown>;
  setComponentProperty(componentUuid: string, propertyPath: string, value: unknown): Promise<void>;
  resizeComponentArray(componentUuid: string, propertyPath: string, length: number): Promise<void>;
  /** 核对引用目标在编辑器中真实可解析（节点/组件/资产存在）。 */
  resolveReference(reference: WriteReferenceValue): Promise<boolean>;
  /** 自定义脚本挂载守卫；scriptUuid 非空时必须提供，否则拒绝挂载。 */
  scriptGuard?: ScriptMountGuardDependencies;
}

export interface ComponentWriteOpResult {
  componentUuid: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** false 表示目标状态原本已满足，本次执行未产生任何文档变更。 */
  changed?: boolean;
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
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      throw new ProbeError('INVALID_PROPERTY_PATH', { propertyPath });
    }
    segments.push(match[1]);
    for (const index of match[2].match(/\d+/g) ?? []) {
      segments.push(Number(index));
    }
  }
  return segments;
}

/**
 * 执行单个组件原子写操作并返回 before/after 证据。写入前按组件 Schema 校验
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
  const existing = await dependencies.findComponentInfo(nodeUuid, componentType);
  if (existing) {
    const snapshot = {
      uuid: existing.uuid,
      type: existing.type,
      nodeUuid: existing.nodeUuid,
      ...(existing.nodeStablePath ? { nodeStablePath: existing.nodeStablePath } : {}),
      ...(existing.sameTypeIndex === undefined ? {} : { sameTypeIndex: existing.sameTypeIndex }),
      enabled: existing.enabled
    };
    return {
      componentUuid: existing.uuid,
      before: snapshot,
      after: snapshot,
      changed: false
    };
  }
  if (scriptUuid !== null) {
    // 自定义脚本必须先过挂载守卫：核对资产索引、编译完成、类注册完成，
    // 任何一步失败都不执行挂载，避免产生 MissingScript。
    await assertScriptMountable(dependencies.scriptGuard, componentType, scriptUuid);
  }
  const componentUuid = await dependencies.addComponent(nodeUuid, componentType, scriptUuid);
  if (!componentUuid) {
    throw new ProbeError('COMPONENT_ADD_FAILED', { nodeUuid, componentType });
  }
  const after = await requireComponentInfo(dependencies, componentUuid);
  return {
    componentUuid,
    before: null,
    after: {
      uuid: componentUuid,
      type: after.type,
      enabled: after.enabled,
      ...(after.nodeStablePath ? { nodeStablePath: after.nodeStablePath } : {}),
      ...(after.sameTypeIndex === undefined ? {} : { sameTypeIndex: after.sameTypeIndex })
    }
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
    after: null
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
    after: { uuid: componentUuid, enabled: after.enabled }
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
    after: { uuid: componentUuid, propertyPath, value: actual }
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
  const reference = operation.reference as WriteReferenceValue | WriteReferenceValue[];
  const references = Array.isArray(reference) ? reference : [reference];
  for (let index = 0; index < references.length; index += 1) {
    const item = references[index];
    if (item.kind === 'missing' || item.available === false) {
      throw new ProbeError('REFERENCE_NOT_AVAILABLE', {
        componentUuid, propertyPath, index, kind: item.kind
      });
    }
    if (!await dependencies.resolveReference(item)) {
      throw new ProbeError('REFERENCE_TARGET_NOT_FOUND', {
        componentUuid, propertyPath, index, reference: item
      });
    }
  }
  const oldValue = readValueAtPath(info.properties, segments, propertyPath);
  await dependencies.setComponentProperty(componentUuid, propertyPath, reference);
  const actual = await dependencies.getComponentProperty(componentUuid, propertyPath);
  return {
    componentUuid,
    before: { uuid: componentUuid, propertyPath, reference: oldValue },
    after: { uuid: componentUuid, propertyPath, reference: actual }
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
    after: { uuid: componentUuid, propertyPath, reference: actual }
  };
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
    after: { uuid: componentUuid, propertyPath, length: Array.isArray(resized) ? resized.length : null }
  };
}

/**
 * 自定义脚本挂载守卫：核对脚本资产存在、类已注册（必要时事件驱动等待编译完成）、
 * Phase 1 Schema 可取。任何一步失败都抛稳定错误码，调用方保证不产生 MissingScript。
 */
async function assertScriptMountable(
  guard: ScriptMountGuardDependencies | undefined,
  componentType: string,
  scriptUuid: string
): Promise<void> {
  if (!guard) {
    throw new ProbeError('SCRIPT_MOUNT_GUARD_UNAVAILABLE', { componentType, scriptUuid });
  }
  if (!await guard.scriptAssetExists(scriptUuid)) {
    throw new ProbeError('SCRIPT_ASSET_NOT_FOUND', { componentType, scriptUuid });
  }
  if (!await guard.isScriptClassRegistered(componentType, scriptUuid)) {
    // 脚本刚变更时类可能尚未注册：触发重编译并有界轮询等待类注册，不用固定延时。
    const compilation = await guard.waitForScriptCompilation(scriptUuid, componentType);
    if (compilation && !compilation.success) {
      throw new ProbeError('SCRIPT_COMPILATION_FAILED', {
        componentType,
        scriptUuid,
        diagnostics: compilation.diagnostics
      });
    }
    if (!await guard.isScriptClassRegistered(componentType, scriptUuid)) {
      throw new ProbeError('SCRIPT_CLASS_NOT_REGISTERED', { componentType, scriptUuid });
    }
  }
  if (!await guard.isComponentSchemaAvailable(componentType)) {
    throw new ProbeError('SCRIPT_SCHEMA_UNAVAILABLE', { componentType, scriptUuid });
  }
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

export function deepEqual(left: unknown, right: unknown): boolean {
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
