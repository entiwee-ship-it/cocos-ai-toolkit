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
import type { PrefabInstanceInfo, PrefabWriterDependencies } from './prefab-writer';
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

/**
 * 操作可见性：选中目标节点并在 Creator 控制台打印操作日志。
 * 尽力而为，任何一步失败都不影响写入主链路。
 */
function focusAndLog(nodeUuid: string | null, message: string): void {
  if (nodeUuid) {
    try {
      const selection = (Editor as unknown as Record<string, unknown>).Selection as {
        select?: (type: string, uuid: string, clear?: boolean) => void;
      } | undefined;
      selection?.select?.('node', nodeUuid, true);
    } catch {
      // 选中失败不影响写入
    }
  }
  try {
    const editorGlobal = Editor as unknown as Record<string, unknown>;
    if (typeof editorGlobal.log === 'function') {
      (editorGlobal.log as (text: string) => void)(`[CocosAI] ${message}`);
    } else {
      console.log(`[CocosAI] ${message}`);
    }
  } catch {
    // 日志失败不影响写入
  }
}

/** 节点日志描述：名称(uuid)，节点不可解析时只保留 uuid。 */
function describeNode(uuid: string): string {
  const node = findRuntimeNode(uuid);
  const name = node && typeof node.name === 'string' && node.name ? node.name : null;
  return name ? `${name}(${uuid})` : uuid;
}

/** 组件日志描述：取运行时类名，无法识别时回退组件 uuid。 */
function describeComponent(component: RuntimeNode, fallbackUuid: string): string {
  const type = typeof component?.__classname__ === 'string' && component.__classname__
    ? component.__classname__
    : typeof component?.constructor?.name === 'string' && component.constructor.name
      ? component.constructor.name
      : null;
  return type ?? fallbackUuid;
}

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
      focusAndLog(uuid, `创建节点 ${name}（父节点 ${describeNode(parentUuid)}）`);
      return uuid;
    },
    removeNode: async (uuid) => {
      const deletedName = describeNode(uuid);
      await Editor.Message.request('scene', 'remove-node', { uuid });
      focusAndLog(null, `删除节点 ${deletedName}`);
    },
    renameNode: async (uuid, name) => {
      const oldName = describeNode(uuid);
      await setNodePropertyViaDump(uuid, 'name', name);
      focusAndLog(uuid, `重命名节点 ${oldName} 为 ${name}`);
    },
    setNodeActive: async (uuid, active) => {
      await setNodePropertyViaDump(uuid, 'active', active);
      focusAndLog(uuid, `节点 ${describeNode(uuid)} 激活状态设为 ${active}`);
    },
    setNodeLayer: async (uuid, layer) => {
      await setNodePropertyViaDump(uuid, 'layer', layer);
      focusAndLog(uuid, `节点 ${describeNode(uuid)} 层级设为 ${layer}`);
    },
    setNodeTransform: async (uuid, transform) => {
      if (transform.position) await setNodePropertyViaDump(uuid, 'position', transform.position);
      if (transform.rotation) await setNodePropertyViaDump(uuid, 'rotation', transform.rotation);
      if (transform.scale) await setNodePropertyViaDump(uuid, 'scale', transform.scale);
      focusAndLog(uuid, `节点 ${describeNode(uuid)} 设置局部变换 ${JSON.stringify(transform)}`);
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
      focusAndLog(uuid, `移动节点 ${describeNode(uuid)} 到父节点 ${describeNode(newParentUuid)}`);
    },
    duplicateNode: async (uuid) => {
      const node = findRuntimeNode(uuid);
      if (!node) return null;
      const duplicated = instantiate(node) as RuntimeNode;
      if (node.parent) duplicated.parent = node.parent;
      const duplicatedUuid = readRuntimeUuid(duplicated);
      focusAndLog(duplicatedUuid, `复制节点 ${describeNode(uuid)} 得到 ${describeNode(duplicatedUuid)}`);
      return duplicatedUuid;
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
          focusAndLog(nodeUuid, `节点 ${describeNode(nodeUuid)} 挂载组件 ${componentType}`);
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
      const ownerUuid = readRuntimeUuid(runtime.node);
      const componentType = describeComponent(runtime.component, componentUuid);
      if (typeof runtime.node.removeComponent === 'function') {
        runtime.node.removeComponent(runtime.component);
      } else if (typeof runtime.component.destroy === 'function') {
        runtime.component.destroy();
      } else {
        throw new ProbeError('COMPONENT_REMOVE_FAILED', { componentUuid });
      }
      focusAndLog(ownerUuid, `节点 ${describeNode(ownerUuid)} 移除组件 ${componentType}`);
    },
    setComponentEnabled: async (componentUuid, enabled) => {
      // enabled 直接写运行时对象：set-property(record:true) 对组件 enabled 实测不生效（0.1.4 验证）。
      const runtime = findRuntimeComponent(componentUuid);
      if (!runtime) {
        throw new ProbeError('COMPONENT_NOT_FOUND', { componentUuid });
      }
      runtime.component.enabled = enabled;
      focusAndLog(
        readRuntimeUuid(runtime.node),
        `组件 ${describeComponent(runtime.component, componentUuid)} 启用状态设为 ${enabled}`
      );
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
      (container as Record<string | number, unknown>)[leafKey] = await resolveRuntimeWriteValue(
        value,
        currentValue,
        propertyPath
      );
      focusAndLog(
        readRuntimeUuid(runtime.node),
        `组件 ${describeComponent(runtime.component, componentUuid)} 属性 ${propertyPath} 写入完成`
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
    },
    getPrefabInstanceInfo: async (nodeUuid) => readPrefabInstanceInfo(nodeUuid),
    queryAssetInfo: async (uuidOrUrl) => queryPrefabAssetInfo(uuidOrUrl)
  };
}

/** 经 query-node Dump 读取节点的 __prefab__ 结构，解析为实例信息证据。 */
async function readPrefabInstanceInfo(nodeUuid: string): Promise<PrefabInstanceInfo | null> {
  const raw = await Editor.Message.request('scene', 'query-node', nodeUuid).catch(() => null);
  if (!raw) return null;
  const record = readObject(raw);
  const prefab = readObject(record.__prefab__);
  const stateInfo = readObject(prefab.prefabStateInfo);
  const instance = readObject(readObject(prefab.instance).value);
  const nameDump = readObject(record.name);
  const parentDump = readObject(record.parent);
  const parentValue = readObject(parentDump.value);
  const childrenDump = record.children;
  const children = Array.isArray(childrenDump) ? childrenDump : (Array.isArray(readObject(childrenDump).value) ? readObject(childrenDump).value as unknown[] : []);
  return {
    nodeUuid,
    name: typeof nameDump.value === 'string' ? nameDump.value : '',
    prefabAssetUuid: typeof prefab.uuid === 'string' ? prefab.uuid : null,
    sourceObjectFileId: typeof prefab.fileId === 'string' ? prefab.fileId : null,
    instanceFileId: typeof readObject(instance.fileId).value === 'string' ? readObject(instance.fileId).value as string : null,
    state: typeof stateInfo.state === 'number' ? stateInfo.state : null,
    isApplicable: stateInfo.isApplicable === true,
    isRevertable: stateInfo.isRevertable === true,
    isUnwrappable: stateInfo.isUnwrappable === true,
    parentUuid: typeof parentValue.uuid === 'string' ? parentValue.uuid : null,
    childCount: children.length
  };
}

/** 资产预检：按 UUID 或 db:// URL 查询资产信息，不存在返回 null。 */
async function queryPrefabAssetInfo(uuidOrUrl: string): Promise<{ uuid: string; type: string | null } | null> {
  const info = await Editor.Message.request('asset-db', 'query-asset-info', uuidOrUrl).catch(() => null);
  if (!info) return null;
  const record = readObject(info);
  return {
    uuid: typeof record.uuid === 'string' ? record.uuid : uuidOrUrl,
    type: typeof record.type === 'string' ? record.type : null
  };
}

/** 取 cce.SceneFacadeManager 门面；不可用时返回 null。 */
function resolveSceneFacade(): Record<string, unknown> | null {
  const cce = readObject((globalThis as Record<string, unknown>).cce);
  const facade = cce.SceneFacadeManager ?? cce.sceneFacadeManager ?? cce.SceneFacade ?? cce.sceneFacade;
  return facade && (typeof facade === 'object' || typeof facade === 'function')
    ? facade as Record<string, unknown>
    : null;
}

/** 调用门面预制体语义方法；方法缺失时报稳定错误码。 */
async function callFacadePrefabMethod(method: string, args: unknown[], unavailableCode: string): Promise<unknown> {
  const facade = resolveSceneFacade();
  if (!facade || typeof facade[method] !== 'function') {
    throw new ProbeError(unavailableCode, { method });
  }
  return (facade[method] as (...callArgs: unknown[]) => Promise<unknown>).apply(facade, args);
}

/** 构造预制体写依赖（Scene 消息 API + cce.SceneFacadeManager 门面）。 */
export function buildPrefabWriterDependencies(): PrefabWriterDependencies {
  return {
    getPrefabInstanceInfo: async (nodeUuid) => readPrefabInstanceInfo(nodeUuid),
    queryAssetInfo: async (uuidOrUrl) => queryPrefabAssetInfo(uuidOrUrl),
    instantiatePrefab: async (parentNodeUuid, prefabAssetUuid, name) => {
      // 实测路径：scene/create-node 消息 + type='cc.Prefab'（不带 type 会被剥掉实例信息）。
      const created = await Editor.Message.request('scene', 'create-node', {
        parent: parentNodeUuid,
        assetUuid: prefabAssetUuid,
        ...(name ? { name } : {}),
        type: 'cc.Prefab'
      } as never);
      if (typeof created !== 'string' || !created) {
        throw new ProbeError('PREFAB_INSTANCE_NOT_ESTABLISHED', { parentNodeUuid, prefabAssetUuid });
      }
      return created;
    },
    createPrefabFromNode: async (nodeUuid, assetUrl) => {
      const assetUuid = await callFacadePrefabMethod('createPrefab', [nodeUuid, assetUrl], 'CREATOR_CREATE_PREFAB_UNAVAILABLE');
      if (typeof assetUuid !== 'string' || !assetUuid) {
        throw new ProbeError('CREATE_PREFAB_FAILED', { nodeUuid, assetUrl });
      }
      return assetUuid;
    },
    deleteAsset: async (assetUrl) => {
      await Editor.Message.request('asset-db', 'delete-asset', assetUrl as never);
    },
    revertPrefabInstance: async (instanceRootUuid) => {
      await callFacadePrefabMethod('restorePrefab', [instanceRootUuid], 'CREATOR_REVERT_PREFAB_UNAVAILABLE');
    },
    applyPrefabInstance: async (instanceRootUuid) => {
      await callFacadePrefabMethod('applyPrefab', [instanceRootUuid], 'CREATOR_APPLY_PREFAB_UNAVAILABLE');
    },
    unlinkPrefabInstance: async (instanceRootUuid) => {
      await callFacadePrefabMethod('unlinkPrefab', [instanceRootUuid], 'CREATOR_UNLINK_PREFAB_UNAVAILABLE');
    },
    linkPrefabInstance: async (nodeUuid, prefabAssetUuid) => {
      await callFacadePrefabMethod('linkPrefab', [nodeUuid, prefabAssetUuid], 'CREATOR_LINK_PREFAB_UNAVAILABLE');
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
 * 把协议写值转换为运行时赋值：引用按 kind 解析为运行时对象（资产引用经 assetManager 加载）；
 * Color/Vec2/Vec3/Size 按当前值构造对应 cc 类实例，其余原样赋值。
 */
async function resolveRuntimeWriteValue(
  value: unknown,
  currentValue: unknown,
  propertyPath: string
): Promise<unknown> {
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
      if (reference.kind === 'asset') {
        if (typeof reference.assetUuid !== 'string' || !reference.assetUuid) {
          throw new ProbeError('REFERENCE_TARGET_NOT_FOUND', { propertyPath, reference });
        }
        // 资产引用经编辑器资产管线加载（支持 uuid@subId 子资产形式）。
        return loadAssetByUuid(reference.assetUuid, propertyPath);
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

/** 经 assetManager.loadAny 加载资产对象（含子资产），供引用写入。 */
function loadAssetByUuid(assetUuid: string, propertyPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ccModule.assetManager || typeof ccModule.assetManager.loadAny !== 'function') {
      reject(new ProbeError('ASSET_PIPELINE_UNAVAILABLE', { propertyPath }));
      return;
    }
    ccModule.assetManager.loadAny({ uuid: assetUuid }, (error: unknown, asset: unknown) => {
      if (error || !asset) {
        reject(new ProbeError('REFERENCE_TARGET_NOT_FOUND', {
          propertyPath,
          assetUuid,
          reason: error ? String(error) : 'ASSET_LOAD_EMPTY'
        }));
        return;
      }
      resolve(asset);
    });
  });
}
