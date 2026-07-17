import { createHash } from 'node:crypto';
import { ProbeError } from './probe-errors';
import type { NodeInfo, NodeWriterDependencies } from './node-writer';
import {
  parsePropertyPath,
  type ComponentPropertyWriteSchema,
  type ComponentWriterDependencies
} from './component-writer';
import { buildComponentTypeSchema } from './component-schema';
import { readDumpValueAtPath } from './write-scene-channel';
import { saveAndVerifyWriteTransaction, type WriteVerifierDependencies } from './write-verifier';
import { resolveCreatorDocumentIdentity } from './creator-document-identity';

/**
 * Creator Scene 进程真实能力到写通道依赖的适配层。
 * 原则：能用 Scene 消息 API 的操作（create-node、create-component、remove-node、
 * set-property、save-scene、query-*）走消息 API；消息 API 未覆盖的
 * （reparent、duplicate、remove-component、数组 resize）走 Scene 进程运行时对象。
 * 运行时改动不进入编辑器 Undo，回滚依赖事务管理器的显式逆操作路径。
 */

const { director, js, instantiate } = require('cc') as {
  director: { getScene(): unknown };
  js: { getClassByName(name: string): unknown };
  instantiate(node: unknown): unknown;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ccModule = require('cc') as Record<string, any>;

type RuntimeNode = Record<string, any>;

/** 当前文档身份与层级指纹，供事务管理器 Revision 前置采集。 */
export interface CurrentDocumentIdentity {
  documentId: string;
  hierarchySha256: string;
  dirty: boolean | null;
}

/**
 * 解析当前文档资产 UUID、层级内容指纹和 Dirty 状态。
 *
 * @returns 文档身份；文档 UUID 不可解析时抛稳定错误码。
 */
export async function captureCurrentDocumentIdentity(): Promise<CurrentDocumentIdentity> {
  const identity = await resolveCreatorDocumentIdentity(globalThis);
  if (!identity.assetUuid) {
    throw new ProbeError('CURRENT_DOCUMENT_UUID_EMPTY', { failures: identity.failures });
  }
  const tree = await Editor.Message.request('scene', 'query-node-tree');
  const hierarchySha256 = createHash('sha256').update(JSON.stringify(tree ?? null)).digest('hex');
  let dirty: boolean | null = null;
  try {
    dirty = Boolean(await Editor.Message.request('scene', 'query-dirty'));
  } catch {
    dirty = null;
  }
  return { documentId: identity.assetUuid, hierarchySha256, dirty };
}

/** 构造节点原子写依赖（Scene 消息 + 运行时对象）。 */
export function buildNodeWriterDependencies(): NodeWriterDependencies {
  return {
    getNodeInfo: async (uuid) => {
      const node = findRuntimeNode(uuid);
      return node ? runtimeNodeInfo(node) : null;
    },
    listAncestors: async (uuid) => {
      const ancestors: string[] = [];
      let current = findRuntimeNode(uuid)?.parent ?? null;
      while (current) {
        ancestors.push(readRuntimeUuid(current));
        current = current.parent ?? null;
      }
      return ancestors;
    },
    createNode: async (parentUuid, name) => {
      const created = await Editor.Message.request('scene', 'create-node', {
        parent: parentUuid,
        name,
        snapshot: true
      });
      const uuid = typeof created === 'string' ? created : readObject(created).uuid;
      if (typeof uuid !== 'string' || !uuid) {
        throw new ProbeError('NODE_CREATE_FAILED', { parentUuid, name });
      }
      return uuid;
    },
    removeNode: async (uuid) => {
      await Editor.Message.request('scene', 'remove-node', { uuid });
    },
    renameNode: async (uuid, name) => {
      await setNodePropertyViaDump(uuid, 'name', name);
    },
    setNodeActive: async (uuid, active) => {
      await setNodePropertyViaDump(uuid, 'active', active);
    },
    setNodeLayer: async (uuid, layer) => {
      await setNodePropertyViaDump(uuid, 'layer', layer);
    },
    setNodeTransform: async (uuid, transform) => {
      if (transform.position) await setNodePropertyViaDump(uuid, 'position', transform.position);
      if (transform.rotation) await setNodePropertyViaDump(uuid, 'rotation', transform.rotation);
      if (transform.scale) await setNodePropertyViaDump(uuid, 'scale', transform.scale);
    },
    reparentNode: async (uuid, newParentUuid, siblingIndex) => {
      const node = requireRuntimeNode(uuid);
      const newParent = findRuntimeNode(newParentUuid);
      if (!newParent) {
        throw new ProbeError('NODE_PARENT_NOT_FOUND', { parentNodeUuid: newParentUuid });
      }
      node.parent = newParent;
      if (typeof siblingIndex === 'number' && typeof node.setSiblingIndex === 'function') {
        node.setSiblingIndex(siblingIndex);
      }
    },
    duplicateNode: async (uuid) => {
      const node = findRuntimeNode(uuid);
      if (!node) return null;
      const duplicated = instantiate(node) as RuntimeNode;
      if (node.parent) duplicated.parent = node.parent;
      return readRuntimeUuid(duplicated);
    }
  };
}

/** 构造组件原子写依赖（含自定义脚本挂载守卫）。 */
export function buildComponentWriterDependencies(): ComponentWriterDependencies {
  return {
    getComponentInfo: async (componentUuid) => {
      const raw = await Editor.Message.request('scene', 'query-component', componentUuid);
      if (!raw) return null;
      const schema = buildComponentTypeSchema(raw);
      const runtime = findRuntimeComponent(componentUuid);
      return {
        uuid: componentUuid,
        type: schema.className ?? readObject(raw).type as string ?? '',
        nodeUuid: runtime ? readRuntimeUuid(runtime.node) : readComponentNodeUuid(raw) ?? '',
        enabled: runtime ? Boolean(runtime.component.enabled) : readEnabledFromDump(raw),
        scriptUuid: schema.scriptUuid,
        properties: readComponentCurrentValues(schema.properties),
        schema: schema.properties.map(toWriteSchema)
      };
    },
    nodeExists: async (nodeUuid) => {
      return Boolean(await Editor.Message.request('scene', 'query-node', nodeUuid));
    },
    addComponent: async (nodeUuid, componentType, scriptUuid) => {
      if (scriptUuid !== null) {
        // 自定义脚本经挂载守卫核对后走运行时挂载；UUID 同样按组件清单差集确认，
        // 运行时对象 UUID 仅作兜底（编辑器登记前可能尚未分配）。
        const node = requireRuntimeNode(nodeUuid);
        const componentClass = js.getClassByName(componentType);
        if (!componentClass) {
          throw new ProbeError('SCRIPT_CLASS_NOT_REGISTERED', { componentType, scriptUuid });
        }
        const beforeUuids = readNodeComponentUuids(await Editor.Message.request('scene', 'query-node', nodeUuid));
        const component = node.addComponent(componentClass);
        const afterUuids = readNodeComponentUuids(await Editor.Message.request('scene', 'query-node', nodeUuid));
        for (const [uuid, type] of afterUuids) {
          if (!beforeUuids.has(uuid) && type === componentType) {
            return uuid;
          }
        }
        try {
          return readRuntimeUuid(component);
        } catch {
          throw new ProbeError('COMPONENT_ADD_FAILED', { nodeUuid, componentType, scriptUuid });
        }
      }
      // create-component 不保证返回可用 UUID：按前后组件清单差集确认新组件身份。
      const beforeUuids = readNodeComponentUuids(await Editor.Message.request('scene', 'query-node', nodeUuid));
      const created = await Editor.Message.request('scene', 'create-component', {
        uuid: nodeUuid,
        component: componentType
      });
      const directUuid = typeof created === 'string' ? created : readObject(created).uuid;
      if (typeof directUuid === 'string' && directUuid && !beforeUuids.has(directUuid)) {
        return directUuid;
      }
      const afterUuids = readNodeComponentUuids(await Editor.Message.request('scene', 'query-node', nodeUuid));
      for (const [uuid, type] of afterUuids) {
        if (!beforeUuids.has(uuid) && type === componentType) {
          return uuid;
        }
      }
      throw new ProbeError('COMPONENT_ADD_FAILED', { nodeUuid, componentType });
    },
    removeComponent: async (componentUuid) => {
      const runtime = findRuntimeComponent(componentUuid);
      if (!runtime) {
        throw new ProbeError('COMPONENT_NOT_FOUND', { componentUuid });
      }
      if (typeof runtime.node.removeComponent === 'function') {
        runtime.node.removeComponent(runtime.component);
      } else if (typeof runtime.component.destroy === 'function') {
        runtime.component.destroy();
      } else {
        throw new ProbeError('COMPONENT_REMOVE_FAILED', { componentUuid });
      }
    },
    setComponentEnabled: async (componentUuid, enabled) => {
      // enabled 直接写运行时对象：set-property(record:true) 对组件 enabled 实测不生效（0.1.4 验证）。
      const runtime = findRuntimeComponent(componentUuid);
      if (!runtime) {
        throw new ProbeError('COMPONENT_NOT_FOUND', { componentUuid });
      }
      runtime.component.enabled = enabled;
    },
    getComponentProperty: async (componentUuid, propertyPath) => {
      const raw = await Editor.Message.request('scene', 'query-component', componentUuid);
      if (!raw) return undefined;
      return readDumpValueAtPath(raw, parsePropertyPath(propertyPath));
    },
    setComponentProperty: async (componentUuid, propertyPath, value) => {
      // 组件属性写入走运行时对象：scene/set-property 对组件属性实测不生效（3.8.8，0.1.10 验证）。
      // 引用值按 kind 解析为运行时对象；资产引用暂不支持运行时写入。
      const runtime = findRuntimeComponent(componentUuid);
      if (!runtime) {
        throw new ProbeError('COMPONENT_NOT_FOUND', { componentUuid });
      }
      const segments = parsePropertyPath(propertyPath);
      let container: unknown = runtime.component;
      for (let index = 0; index < segments.length - 1; index += 1) {
        container = (container as Record<string | number, unknown>)?.[segments[index]];
        if (container === null || container === undefined) {
          throw new ProbeError('PROPERTY_PATH_NOT_TRAVERSABLE', { componentUuid, propertyPath });
        }
      }
      const leafKey = segments[segments.length - 1];
      const currentValue = (container as Record<string | number, unknown>)[leafKey];
      (container as Record<string | number, unknown>)[leafKey] = coerceRuntimeWriteValue(
        value,
        currentValue,
        propertyPath
      );
    },
    resizeComponentArray: async (componentUuid, propertyPath, length) => {
      const runtime = findRuntimeComponent(componentUuid);
      if (!runtime) {
        throw new ProbeError('COMPONENT_NOT_FOUND', { componentUuid });
      }
      const segments = parsePropertyPath(propertyPath);
      let container: unknown = runtime.component;
      for (let index = 0; index < segments.length - 1; index += 1) {
        container = (container as Record<string | number, unknown>)?.[segments[index]];
      }
      const target = (container as Record<string, unknown>)?.[String(segments[segments.length - 1])];
      if (!Array.isArray(target)) {
        throw new ProbeError('PROPERTY_NOT_ARRAY', { componentUuid, propertyPath });
      }
      target.length = length;
    },
    resolveReference: async (reference) => {
      if (reference.kind === 'node') {
        return typeof reference.objectUuid === 'string'
          && Boolean(await Editor.Message.request('scene', 'query-node', reference.objectUuid));
      }
      if (reference.kind === 'component') {
        return typeof reference.objectUuid === 'string'
          && Boolean(await Editor.Message.request('scene', 'query-component', reference.objectUuid));
      }
      if (reference.kind === 'asset') {
        return typeof reference.assetUuid === 'string'
          && Boolean(await Editor.Message.request('asset-db', 'query-asset-info', reference.assetUuid));
      }
      return false;
    },
    scriptGuard: {
      scriptAssetExists: async (scriptUuid) => {
        return Boolean(await Editor.Message.request('asset-db', 'query-asset-info', scriptUuid));
      },
      isScriptClassRegistered: async (componentType) => {
        return Boolean(js.getClassByName(componentType));
      },
      // 编译事件驱动等待依赖 asset-db 编译事件实测（见能力矩阵）；阶段二挂载的脚本
      // 均为已编译脚本，此处无 pending 编译可等，返回 null 让注册复核直接判定。
      waitForScriptCompilation: async () => null,
      isComponentSchemaAvailable: async (componentType) => {
        return Boolean(js.getClassByName(componentType));
      }
    }
  };
}

/** 构造重读验证依赖（复用 Scene 查询链路）。 */
export function buildWriteVerifierDependencies(): WriteVerifierDependencies {
  return {
    saveDocument: async () => {
      await Editor.Message.request('scene', 'save-scene');
    },
    reloadDocument: async () => {
      // 等价刷新：保存后重新解析文档身份，强制后续读取走最新状态。
      await captureCurrentDocumentIdentity();
    },
    getNodeInfo: async (nodeUuid) => {
      const node = findRuntimeNode(nodeUuid);
      return node ? runtimeNodeInfo(node) as unknown as Record<string, unknown> : null;
    },
    getComponentInfo: async (componentUuid) => {
      const raw = await Editor.Message.request('scene', 'query-component', componentUuid);
      if (!raw) return null;
      const runtime = findRuntimeComponent(componentUuid);
      return {
        uuid: componentUuid,
        type: readObject(raw).type ?? null,
        enabled: runtime ? Boolean(runtime.component.enabled) : readEnabledFromDump(raw)
      };
    },
    getComponentProperty: async (componentUuid, propertyPath) => {
      const raw = await Editor.Message.request('scene', 'query-component', componentUuid);
      if (!raw) return undefined;
      return readDumpValueAtPath(raw, parsePropertyPath(propertyPath));
    }
  };
}

/** 经 query-node Dump 模板设置节点属性（record=true 进入编辑器 Undo）。 */
async function setNodePropertyViaDump(uuid: string, path: string, value: unknown): Promise<void> {
  const raw = await Editor.Message.request('scene', 'query-node', uuid);
  if (!raw) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: uuid });
  }
  const template = readObject(raw)[path];
  if (!template || typeof template !== 'object') {
    throw new ProbeError('PROPERTY_DUMP_UNAVAILABLE', { nodeUuid: uuid, path });
  }
  await Editor.Message.request('scene', 'set-property', {
    uuid,
    path,
    dump: { ...(template as Record<string, unknown>), value },
    record: true
  } as never);
}

function findRuntimeNode(uuid: string): RuntimeNode | null {
  return findRuntimeNodeIn(director.getScene() as RuntimeNode, uuid);
}

function findRuntimeNodeIn(root: RuntimeNode, uuid: string): RuntimeNode | null {
  if (!root || typeof root !== 'object') return null;
  if (root.uuid === uuid || root._uuid === uuid) return root;
  const children = Array.isArray(root.children) ? root.children : [];
  for (const child of children) {
    const found = findRuntimeNodeIn(child as RuntimeNode, uuid);
    if (found) return found;
  }
  return null;
}

function requireRuntimeNode(uuid: string): RuntimeNode {
  const node = findRuntimeNode(uuid);
  if (!node) {
    throw new ProbeError('NODE_NOT_FOUND', { nodeUuid: uuid });
  }
  return node;
}

/** 从 query-node Dump 读取组件 UUID → 类型映射（条目级 type 为类名，value.uuid.value 为组件 UUID）。 */
function readNodeComponentUuids(nodeDump: unknown): Map<string, string> {
  const components = new Map<string, string>();
  const node = readObject(nodeDump);
  const list = Array.isArray(node.__comps__) ? node.__comps__ : [];
  for (const entry of list) {
    const item = readObject(entry);
    const type = typeof item.type === 'string' ? item.type : null;
    const uuid = readObject(readObject(item.value).uuid).value;
    if (type && typeof uuid === 'string' && uuid) {
      components.set(uuid, type);
    }
  }
  return components;
}

function findRuntimeComponent(componentUuid: string): { node: RuntimeNode; component: RuntimeNode } | null {  const visit = (node: RuntimeNode | null): { node: RuntimeNode; component: RuntimeNode } | null => {
    if (!node || typeof node !== 'object') return null;
    const components = Array.isArray(node._components)
      ? node._components
      : Array.isArray(node.__comps__) ? node.__comps__ : [];
    for (const component of components) {
      if (component && (component.uuid === componentUuid || component._uuid === componentUuid)) {
        return { node, component: component as RuntimeNode };
      }
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      const found = visit(child as RuntimeNode);
      if (found) return found;
    }
    return null;
  };
  return visit(director.getScene() as RuntimeNode);
}

function runtimeNodeInfo(node: RuntimeNode): NodeInfo {
  return {
    uuid: readRuntimeUuid(node),
    name: String(node.name ?? ''),
    active: Boolean(node.active),
    layer: Number(node.layer ?? 0),
    parentUuid: node.parent ? readRuntimeUuid(node.parent) : null,
    position: {
      x: Number(node.position?.x ?? 0),
      y: Number(node.position?.y ?? 0),
      z: Number(node.position?.z ?? 0)
    },
    rotation: {
      x: Number(node.rotation?.x ?? 0),
      y: Number(node.rotation?.y ?? 0),
      z: Number(node.rotation?.z ?? 0),
      w: Number(node.rotation?.w ?? 1)
    },
    scale: {
      x: Number(node.scale?.x ?? 1),
      y: Number(node.scale?.y ?? 1),
      z: Number(node.scale?.z ?? 1)
    }
  };
}

function readRuntimeUuid(value: RuntimeNode): string {
  const uuid = value?.uuid ?? value?._uuid;
  if (typeof uuid !== 'string' || !uuid) {
    throw new ProbeError('RUNTIME_UUID_UNAVAILABLE');
  }
  return uuid;
}

function readComponentNodeUuid(raw: unknown): string | null {
  const values = readObject(readObject(raw).value);
  const nodeDump = readObject(values.node);
  const uuid = nodeDump.uuid ?? readObject(nodeDump.value).uuid;
  return typeof uuid === 'string' && uuid ? uuid : null;
}

function readEnabledFromDump(raw: unknown): boolean {
  const values = readObject(readObject(raw).value);
  const enabled = values.enabled;
  if (typeof enabled === 'boolean') return enabled;
  const dumpValue = readObject(enabled).value;
  return typeof dumpValue === 'boolean' ? dumpValue : true;
}

function readComponentCurrentValues(
  properties: Array<{ propertyPath: string; currentValue: unknown }>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const property of properties) {
    values[property.propertyPath] = property.currentValue;
  }
  return values;
}

function toWriteSchema(property: {
  propertyPath: string;
  declaredType: string | null;
  readonly: boolean | null;
  inspectorMetadata: Record<string, unknown>;
}): ComponentPropertyWriteSchema {
  const isArray = property.inspectorMetadata.isArray;
  return {
    propertyPath: property.propertyPath,
    declaredType: property.declaredType,
    readonly: property.readonly,
    isArray: typeof isArray === 'boolean' ? isArray : null
  };
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 把协议写值转换为运行时赋值：引用按 kind 解析为运行时对象；
 * Color/Vec2/Vec3/Size 按当前值构造对应 cc 类实例，其余原样赋值。
 */
function coerceRuntimeWriteValue(value: unknown, currentValue: unknown, propertyPath: string): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const reference = value as Record<string, unknown>;
    if (typeof reference.kind === 'string') {
      if (reference.kind === 'node') {
        const node = typeof reference.objectUuid === 'string' ? findRuntimeNode(reference.objectUuid) : null;
        if (!node) throw new ProbeError('REFERENCE_TARGET_NOT_FOUND', { propertyPath, reference });
        return node;
      }
      if (reference.kind === 'component') {
        const target = typeof reference.objectUuid === 'string'
          ? findRuntimeComponent(reference.objectUuid)
          : null;
        if (!target) throw new ProbeError('REFERENCE_TARGET_NOT_FOUND', { propertyPath, reference });
        return target.component;
      }
      throw new ProbeError('REFERENCE_ASSET_NOT_SUPPORTED', { propertyPath, kind: reference.kind });
    }
    const ctorName = (currentValue as { constructor?: { name?: string } })?.constructor?.name;
    if (ctorName === 'Color' && typeof ccModule.Color === 'function') {
      return new ccModule.Color(reference.r, reference.g, reference.b, reference.a);
    }
    if (ctorName === 'Vec2' && typeof ccModule.Vec2 === 'function') {
      return new ccModule.Vec2(reference.x, reference.y);
    }
    if (ctorName === 'Vec3' && typeof ccModule.Vec3 === 'function') {
      return new ccModule.Vec3(reference.x, reference.y, reference.z);
    }
    if (ctorName === 'Size' && typeof ccModule.Size === 'function') {
      return new ccModule.Size(reference.width, reference.height);
    }
  }
  return value;
}
