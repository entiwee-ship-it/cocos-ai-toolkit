import { readFile } from 'node:fs/promises';
import { ProbeError } from './probe-errors';
import type { NodeInfo, NodeWriterDependencies } from './node-writer';
import {
  parsePropertyPath,
  type ComponentPropertyWriteSchema,
  type ComponentWriterDependencies
} from './component-writer';
import { buildComponentTypeSchema } from './component-schema';
import { readDumpValueAtPath } from './write-scene-channel';
import type { WriteVerifierDependencies } from './write-verifier';
import type { PrefabInstanceInfo, PrefabWriterDependencies } from './prefab-writer';
import { resolveCreatorDocumentIdentity } from './creator-document-identity';
import {
  readRuntimeWriteClassAttributes,
  readRuntimeWriteObjectConstructor,
  resolveRuntimeWriteValue,
  type RuntimeWriteReference
} from './runtime-write-value';
import {
  readNodeComponentUuids,
  resolveCreatedComponentUuid
} from './raw-reflection';

/**
 * Creator Scene 进程真实能力到写通道依赖的适配层。
 * 原则：能用 Scene 消息 API 的操作（create-node、create-component、remove-node、
 * set-property、save-scene、query-*）走消息 API；消息 API 未覆盖的
 * （reparent、duplicate、remove-component、数组 resize）走 Scene 进程运行时对象。
 * 运行时改动必须由写后重读确认，不依赖编辑器撤销状态判断成功。
 */

const { director, js, instantiate } = require('cc') as {
  director: { getScene(): unknown };
  js: { getClassByName(name: string): unknown };
  instantiate(node: unknown): unknown;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ccModule = require('cc') as Record<string, any>;

type RuntimeNode = Record<string, any>;

interface RuntimePropertyOverride {
  targetInfo: { localID: string[] } | null;
  propertyPath: string[];
  value: unknown;
}

interface RuntimePrefabInstance {
  propertyOverrides: RuntimePropertyOverride[];
  targetMap: Record<string, unknown>;
  findPropertyOverride?(localIds: string[], propertyPath: string[]): RuntimePropertyOverride | null | undefined;
  removePropertyOverride?(localIds: string[], propertyPath: string[]): void;
}

interface PrefabUtilities {
  TargetInfo: new () => { localID: string[] };
  PropertyOverrideInfo: new () => RuntimePropertyOverride;
  generateTargetMap(node: RuntimeNode, targetMap: Record<string, unknown>, isRoot: boolean): void;
}

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

/** 解析当前文档资产 UUID；无法解析时抛稳定错误码。 */
export async function readCurrentDocumentAssetUuid(): Promise<string> {
  const identity = await resolveCreatorDocumentIdentity(globalThis);
  if (!identity.assetUuid) {
    throw new ProbeError('CURRENT_DOCUMENT_UUID_EMPTY', { failures: identity.failures });
  }
  return identity.assetUuid;
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
  const getComponentInfo: ComponentWriterDependencies['getComponentInfo'] = async (componentUuid) => {
    const raw = await Editor.Message.request('scene', 'query-component', componentUuid);
    if (!raw) return null;
    const schema = buildComponentTypeSchema(raw);
    const runtime = findRuntimeComponent(componentUuid);
    const nodeUuid = runtime ? readRuntimeUuid(runtime.node) : readComponentNodeUuid(raw) ?? '';
    const componentType = schema.className ?? readObject(raw).type as string ?? '';
    const sameTypeComponents = nodeUuid
      ? [...readNodeComponentUuids(await Editor.Message.request('scene', 'query-node', nodeUuid)).entries()]
          .filter(([, type]) => type === componentType)
      : [];
    const sameTypeIndex = sameTypeComponents.findIndex(([uuid]) => uuid === componentUuid);
    return {
      uuid: componentUuid,
      type: componentType,
      nodeUuid,
      ...(runtime ? { nodeStablePath: buildRuntimeNodeStablePath(runtime.node) } : {}),
      ...(sameTypeIndex < 0 ? {} : { sameTypeIndex }),
      enabled: runtime ? Boolean(runtime.component.enabled) : readEnabledFromDump(raw),
      scriptUuid: schema.scriptUuid,
      properties: readComponentCurrentValues(schema.properties),
      schema: schema.properties.map(toWriteSchema)
    };
  };
  return {
    getComponentInfo,
    findComponentInfo: async (nodeUuid, componentType) => {
      const nodeDump = await Editor.Message.request('scene', 'query-node', nodeUuid);
      for (const [componentUuid, currentType] of readNodeComponentUuids(nodeDump)) {
        if (currentType !== componentType) continue;
        const info = await getComponentInfo(componentUuid);
        if (info) return info;
      }
      return null;
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
      const beforeNodeDump = await Editor.Message.request('scene', 'query-node', nodeUuid);
      const created = await Editor.Message.request('scene', 'create-component', {
        uuid: nodeUuid,
        component: componentType
      });
      const afterNodeDump = await Editor.Message.request('scene', 'query-node', nodeUuid);
      const componentUuid = resolveCreatedComponentUuid(
        beforeNodeDump,
        created,
        afterNodeDump,
        componentType
      );
      if (componentUuid) {
        focusAndLog(nodeUuid, `节点 ${describeNode(nodeUuid)} 挂载组件 ${componentType}`);
        return componentUuid;
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
        propertyPath,
        {
          resolveReference: resolveCreatorReference,
          createObject: (_value, nestedPath) => createCreatorSerializedObject(runtime.component, nestedPath),
          resolveSpecialValue: resolveCreatorSpecialValue
        }
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
      // Task 3 实测：asset-db/refresh-asset 触发重新导入 + 异步编译 + 类重注册；
      // 广播事件不可用，类注册完成用有界轮询观察（不用固定延时盲等）。
      waitForScriptCompilation: async (scriptUuid, componentType) => {
        await Editor.Message.request('asset-db', 'refresh-asset', scriptUuid);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (js.getClassByName(componentType)) {
            return { success: true, diagnostics: [] };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
        // 编译错误文本无法经消息/广播通道取得（Task 3 已固化），超时就返回超时诊断。
        return {
          success: false,
          diagnostics: [`等待脚本 ${componentType}(${scriptUuid}) 编译与类注册超时（10s）：脚本可能存在编译错误，请检查 Creator 控制台`]
        };
      },
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
      const facade = resolveSceneFacade();
      if (!facade || typeof facade.softReloadScene !== 'function') {
        throw new ProbeError('CREATOR_SOFT_RELOAD_UNAVAILABLE');
      }
      const reloaded = await (facade.softReloadScene as () => Promise<unknown>).call(facade);
      if (reloaded !== true) {
        throw new ProbeError('CREATOR_SOFT_RELOAD_FAILED', { result: reloaded ?? null });
      }
    },
    getNodeInfo: async (nodeUuid) => {
      const node = findRuntimeNode(nodeUuid);
      return node ? runtimeNodeInfo(node) as unknown as Record<string, unknown> : null;
    },
    getNodeInfoByStablePath: async (stablePath) => {
      const node = findRuntimeNodeByStablePath(stablePath);
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
    getComponentInfoByStableLocator: async (nodeStablePath, componentType, sameTypeIndex) => {
      const node = findRuntimeNodeByStablePath(nodeStablePath);
      if (!node) return null;
      const nodeUuid = readRuntimeUuid(node);
      const matches = [...readNodeComponentUuids(
        await Editor.Message.request('scene', 'query-node', nodeUuid)
      ).entries()].filter(([, type]) => type === componentType);
      const componentUuid = matches[sameTypeIndex]?.[0];
      if (!componentUuid) return null;
      const raw = await Editor.Message.request('scene', 'query-component', componentUuid);
      if (!raw) return null;
      const runtime = findRuntimeComponent(componentUuid);
      return {
        uuid: componentUuid,
        type: componentType,
        enabled: runtime ? Boolean(runtime.component.enabled) : readEnabledFromDump(raw)
      };
    },
    getComponentProperty: async (componentUuid, propertyPath) => {
      const raw = await Editor.Message.request('scene', 'query-component', componentUuid);
      if (!raw) return undefined;
      return readDumpValueAtPath(raw, parsePropertyPath(propertyPath));
    },
    getPrefabInstanceInfo: async (nodeUuid) => readPrefabInstanceInfo(nodeUuid),
    getPrefabTargetProperty: async (instanceRootUuid, targetLocalIds, propertyPath) => {
      return readRuntimePrefabTargetProperty(instanceRootUuid, targetLocalIds, propertyPath);
    },
    queryAssetInfo: async (uuidOrUrl) => queryPrefabAssetInfo(uuidOrUrl),
    readAssetMeta: async (assetUrl) => readAssetMeta(assetUrl),
    readAssetContent: async (assetUrl) => {
      const filePath = await Editor.Message.request('asset-db', 'query-path', assetUrl);
      if (typeof filePath !== 'string' || !filePath) {
        throw new ProbeError('ASSET_PATH_NOT_FOUND', { assetUrl });
      }
      return readFile(filePath, 'utf8');
    }
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
  const overrideEntries = Array.isArray(instance.propertyOverrides)
    ? instance.propertyOverrides
    : (Array.isArray(readObject(instance.propertyOverrides).value) ? readObject(instance.propertyOverrides).value as unknown[] : []);
  const overrideTargets = overrideEntries.map((entry) => {
    const entryValue = readObject(readObject(entry).value);
    const pathDump = entryValue.propertyPath ?? readObject(entry).propertyPath;
    const segments = Array.isArray(pathDump) ? pathDump : (Array.isArray(readObject(pathDump).value) ? readObject(pathDump).value as unknown[] : []);
    const path = segments.map((segment) => {
      const unwrapped = readObject(segment).value ?? segment;
      return String(unwrapped);
    }).join('.');
    const targetInfoValue = readObject(readObject(entryValue.targetInfo ?? readObject(entry).targetInfo).value);
    const localIdDump = targetInfoValue.localID;
    const localIds = Array.isArray(readObject(localIdDump).value) ? readObject(localIdDump).value as unknown[] : (Array.isArray(localIdDump) ? localIdDump : []);
    const targetLocalIds = localIds.map((localId) => readObject(localId).value ?? localId)
      .filter((localId): localId is string => typeof localId === 'string' && localId.length > 0);
    const firstLocalId = targetLocalIds[0] ?? null;
    return {
      path,
      targetFileId: firstLocalId,
      targetLocalIds
    };
  }).filter((target) => target.path.length > 0);
  const overridePaths = overrideTargets.map((target) => target.path);
  const runtimeNode = findRuntimeNode(nodeUuid);
  return {
    nodeUuid,
    name: typeof nameDump.value === 'string' ? nameDump.value : '',
    ...(runtimeNode ? { stablePath: buildRuntimeNodeStablePath(runtimeNode) } : {}),
    prefabAssetUuid: typeof prefab.uuid === 'string' ? prefab.uuid : null,
    sourceObjectFileId: typeof prefab.fileId === 'string' ? prefab.fileId : null,
    instanceFileId: typeof readObject(instance.fileId).value === 'string' ? readObject(instance.fileId).value as string : null,
    state: typeof stateInfo.state === 'number' ? stateInfo.state : null,
    isApplicable: stateInfo.isApplicable === true,
    isRevertable: stateInfo.isRevertable === true,
    isUnwrappable: stateInfo.isUnwrappable === true,
    parentUuid: typeof parentValue.uuid === 'string' ? parentValue.uuid : null,
    childCount: children.length,
    overrideCount: overridePaths.length,
    overridePaths,
    overrideTargets
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
    createAsset: async (assetUrl, _assetKind, content) => {
      const created = await Editor.Message.request('asset-db', 'create-asset', assetUrl, content as never);
      const record = readObject(created);
      if (typeof record.uuid !== 'string' || !record.uuid) {
        throw new ProbeError('ASSET_CREATE_FAILED', { assetUrl });
      }
      return {
        uuid: record.uuid,
        type: typeof record.type === 'string' ? record.type : null
      };
    },
    moveAsset: async (sourceUrl, targetUrl) => {
      await Editor.Message.request('asset-db', 'move-asset', sourceUrl, targetUrl);
    },
    readAssetMeta: async (assetUrl) => readAssetMeta(assetUrl),
    writeAssetMeta: async (assetUrl, meta) => {
      await Editor.Message.request('asset-db', 'save-asset-meta', assetUrl, JSON.stringify(meta));
    },
    readAssetContent: async (assetUrl) => {
      const filePath = await Editor.Message.request('asset-db', 'query-path', assetUrl);
      if (typeof filePath !== 'string' || !filePath) {
        throw new ProbeError('ASSET_PATH_NOT_FOUND', { assetUrl });
      }
      return readFile(filePath, 'utf8');
    },
    saveAssetContent: async (assetUrl, content) => {
      const saved = await Editor.Message.request('asset-db', 'save-asset', assetUrl, content);
      const record = readObject(saved);
      if (typeof record.uuid !== 'string' || !record.uuid) {
        throw new ProbeError('ASSET_SAVE_FAILED', { assetUrl });
      }
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
    },
    resetNodeProperty: async (nodeUuid, propertyPath) => {
      await resetCreatorProperty(nodeUuid, propertyPath);
    },
    setPrefabInstanceOverride: async (instanceRootUuid, targetObjectUuid, propertyPath, value) => {
      const instance = requireRuntimePrefabInstance(instanceRootUuid);
      const target = requireRuntimeObject(targetObjectUuid);
      const targetLocalIds = requireTargetLocalIds(instanceRootUuid, instance, target);
      const propertySegments = parsePropertyPath(propertyPath).map(String);
      const existing = instance.findPropertyOverride?.(targetLocalIds, propertySegments)
        ?? findRuntimePropertyOverride(instance, targetLocalIds, propertySegments);
      const previous = existing ? { value: existing.value } : null;
      const resolvedValue = await writeRuntimeObjectProperty(targetObjectUuid, propertyPath, value);
      if (existing) {
        existing.value = resolvedValue;
      } else {
        const utilities = requirePrefabUtilities();
        const targetInfo = new utilities.TargetInfo();
        targetInfo.localID = [...targetLocalIds];
        const propertyOverride = new utilities.PropertyOverrideInfo();
        propertyOverride.targetInfo = targetInfo;
        propertyOverride.propertyPath = propertySegments;
        propertyOverride.value = resolvedValue;
        instance.propertyOverrides.push(propertyOverride);
      }
      focusAndLog(instanceRootUuid, `预制体实例覆盖 ${propertyPath} 写入完成`);
      return { targetLocalIds, previous };
    },
    removePrefabInstanceOverride: async (instanceRootUuid, targetObjectUuid, propertyPath) => {
      const instance = requireRuntimePrefabInstance(instanceRootUuid);
      const target = requireRuntimeObject(targetObjectUuid);
      const targetLocalIds = requireTargetLocalIds(instanceRootUuid, instance, target);
      const propertySegments = parsePropertyPath(propertyPath).map(String);
      const existing = instance.findPropertyOverride?.(targetLocalIds, propertySegments)
        ?? findRuntimePropertyOverride(instance, targetLocalIds, propertySegments);
      const previous = existing ? { value: existing.value } : null;
      instance.removePropertyOverride?.(targetLocalIds, propertySegments);
      const remaining = findRuntimePropertyOverride(instance, targetLocalIds, propertySegments);
      if (remaining) {
        const index = instance.propertyOverrides.indexOf(remaining);
        if (index >= 0) instance.propertyOverrides.splice(index, 1);
      }
      // 这里只删除覆盖记录；运行时源值由事务保存后的 softReloadScene 统一恢复。
      focusAndLog(instanceRootUuid, `预制体实例覆盖 ${propertyPath} 已精确还原`);
      return { targetLocalIds, previous };
    },
    getCurrentDocumentAssetUuid: async () => {
      return readCurrentDocumentAssetUuid().catch(() => null);
    },
    findPrefabInstanceRoot: async (parentUuid, name, prefabAssetUuid) => {
      const tree = await Editor.Message.request('scene', 'query-node-tree');
      return findInstanceRootInTree(tree, parentUuid, name, prefabAssetUuid, null);
    }
  };
}

function requirePrefabUtilities(): PrefabUtilities {
  const prefab = ccModule.Prefab;
  const utilities = readObject(
    prefab && (typeof prefab === 'object' || typeof prefab === 'function')
      ? (prefab as Record<string, unknown>)._utils
      : null
  );
  if (typeof utilities.TargetInfo !== 'function'
    || typeof utilities.PropertyOverrideInfo !== 'function'
    || typeof utilities.generateTargetMap !== 'function') {
    throw new ProbeError('CREATOR_PREFAB_OVERRIDE_UNAVAILABLE');
  }
  return utilities as unknown as PrefabUtilities;
}

function requireRuntimePrefabInstance(instanceRootUuid: string): RuntimePrefabInstance {
  const node = requireRuntimeNode(instanceRootUuid);
  const prefab = readObject(node.prefab ?? node._prefab ?? node.__prefab__);
  const instance = readObject(prefab.instance);
  if (!Array.isArray(instance.propertyOverrides)) {
    throw new ProbeError('PREFAB_INSTANCE_REQUIRED', { instanceRootUuid });
  }
  if (!instance.targetMap || typeof instance.targetMap !== 'object') instance.targetMap = {};
  return instance as unknown as RuntimePrefabInstance;
}

function requireRuntimeObject(objectUuid: string): RuntimeNode {
  const node = findRuntimeNode(objectUuid);
  if (node) return node;
  const component = findRuntimeComponent(objectUuid)?.component;
  if (component) return component;
  throw new ProbeError('PREFAB_OVERRIDE_TARGET_NOT_FOUND', { targetObjectUuid: objectUuid });
}

function requireTargetLocalIds(
  instanceRootUuid: string,
  instance: RuntimePrefabInstance,
  target: RuntimeNode
): string[] {
  let targetLocalIds = findTargetLocalIds(instance.targetMap, target);
  if (!targetLocalIds) {
    instance.targetMap = {};
    requirePrefabUtilities().generateTargetMap(requireRuntimeNode(instanceRootUuid), instance.targetMap, true);
    targetLocalIds = findTargetLocalIds(instance.targetMap, target);
  }
  if (!targetLocalIds || targetLocalIds.length === 0) {
    throw new ProbeError('PREFAB_OVERRIDE_TARGET_UNADDRESSABLE', {
      instanceRootUuid,
      targetObjectUuid: readRuntimeUuid(target)
    });
  }
  return targetLocalIds;
}

function findTargetLocalIds(
  targetMap: Record<string, unknown>,
  target: RuntimeNode,
  visited = new Set<object>()
): string[] | null {
  if (visited.has(targetMap)) return null;
  visited.add(targetMap);
  for (const [localId, value] of Object.entries(targetMap)) {
    if (value === target) return [localId];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if ('uuid' in record || '_uuid' in record) continue;
    const nested = findTargetLocalIds(record, target, visited);
    if (nested) return [localId, ...nested];
  }
  return null;
}

function readRuntimePrefabTargetProperty(
  instanceRootUuid: string,
  targetLocalIds: string[],
  propertyPath: string
): unknown {
  const instance = requireRuntimePrefabInstance(instanceRootUuid);
  let target = findTargetByLocalIds(instance.targetMap, targetLocalIds);
  if (!target) {
    instance.targetMap = {};
    requirePrefabUtilities().generateTargetMap(requireRuntimeNode(instanceRootUuid), instance.targetMap, true);
    target = findTargetByLocalIds(instance.targetMap, targetLocalIds);
  }
  if (!target) {
    throw new ProbeError('PREFAB_OVERRIDE_TARGET_UNADDRESSABLE', {
      instanceRootUuid,
      targetLocalIds,
      propertyPath
    });
  }
  let current: unknown = target;
  for (const segment of parsePropertyPath(propertyPath)) {
    if (current === null || current === undefined) {
      throw new ProbeError('PROPERTY_PATH_NOT_TRAVERSABLE', {
        instanceRootUuid,
        targetLocalIds,
        propertyPath
      });
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function findTargetByLocalIds(targetMap: Record<string, unknown>, targetLocalIds: string[]): RuntimeNode | null {
  let current: unknown = targetMap;
  for (const localId of targetLocalIds) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[localId];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as RuntimeNode
    : null;
}

function findRuntimePropertyOverride(
  instance: RuntimePrefabInstance,
  targetLocalIds: string[],
  propertyPath: string[]
): RuntimePropertyOverride | null {
  return instance.propertyOverrides.find((entry) => (
    arraysEqual(entry.targetInfo?.localID ?? [], targetLocalIds)
    && arraysEqual(entry.propertyPath, propertyPath)
  )) ?? null;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function writeRuntimeObjectProperty(
  targetObjectUuid: string,
  propertyPath: string,
  value: unknown
): Promise<unknown> {
  const target = requireRuntimeObject(targetObjectUuid);
  const segments = parsePropertyPath(propertyPath);
  let container: unknown = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    container = (container as Record<string | number, unknown>)?.[segments[index]];
    if (container === null || container === undefined) {
      throw new ProbeError('PROPERTY_PATH_NOT_TRAVERSABLE', { targetObjectUuid, propertyPath });
    }
  }
  const leafKey = segments[segments.length - 1];
  const currentValue = (container as Record<string | number, unknown>)[leafKey];
  const resolvedValue = await resolveRuntimeWriteValue(value, currentValue, propertyPath, {
    resolveReference: resolveCreatorReference,
    createObject: (_value, nestedPath) => createCreatorSerializedObject(target, nestedPath),
    resolveSpecialValue: resolveCreatorSpecialValue
  });
  (container as Record<string | number, unknown>)[leafKey] = resolvedValue;
  return resolvedValue;
}

async function resetCreatorProperty(objectUuid: string, propertyPath: string): Promise<void> {
  const cce = readObject((globalThis as Record<string, unknown>).cce);
  const nodeManager = readObject(cce.Node);
  if (typeof nodeManager.resetProperty !== 'function') {
    throw new ProbeError('CREATOR_RESET_PROPERTY_UNAVAILABLE', { objectUuid, propertyPath });
  }
  await (nodeManager.resetProperty as (uuid: string, path: string) => Promise<unknown>)
    .call(nodeManager, objectUuid, propertyPath);
}

/** 在节点树中按父节点 + 源资产 UUID 定位重建后的实例根（createPrefab 会重建节点并把根名改为资产名）。
 * query-node-tree 为精简形态（name/uuid 为裸字符串，prefab.assetUuid 键名）。
 * 匹配父节点 + 源资产即可：资产为本次新建（路径已预检不存在），同名歧义不成立；名称只作优先参考。
 */
function findInstanceRootInTree(
  node: unknown,
  parentUuid: string | null,
  name: string,
  prefabAssetUuid: string,
  currentParentUuid: string | null
): string | null {
  const record = readObject(node);
  const nodeUuid = typeof record.uuid === 'string' ? record.uuid : null;
  const prefab = readObject(record.prefab);
  if (prefab.assetUuid === prefabAssetUuid && (parentUuid === null || currentParentUuid === parentUuid)) {
    return nodeUuid;
  }
  const children = Array.isArray(record.children) ? record.children : [];
  for (const child of children) {
    const found = findInstanceRootInTree(child, parentUuid, name, prefabAssetUuid, nodeUuid ?? currentParentUuid);
    if (found) return found;
  }
  return null;
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

function findRuntimeNodeByStablePath(stablePath: string): RuntimeNode | null {
  const segments = stablePath.split('/').filter(Boolean).map(readStablePathSegment);
  if (segments.length === 0) return null;
  let current = director.getScene() as RuntimeNode;
  let index = 0;
  if (String(current?.name ?? '') === segments[0].name && segments[0].sameNameIndex === 0) {
    index = 1;
  }
  for (; index < segments.length; index += 1) {
    const segment = segments[index];
    const matches = (Array.isArray(current?.children) ? current.children : [])
      .filter((child: RuntimeNode) => String(child?.name ?? '') === segment.name);
    if (segment.sameNameIndex >= matches.length) return null;
    current = matches[segment.sameNameIndex] as RuntimeNode;
  }
  return current;
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
    stablePath: buildRuntimeNodeStablePath(node),
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

function buildRuntimeNodeStablePath(node: RuntimeNode): string {
  const segments: string[] = [];
  let current: RuntimeNode | null = node;
  while (current) {
    const name = String(current.name ?? '');
    const siblings = current.parent && Array.isArray(current.parent.children)
      ? current.parent.children.filter((sibling: RuntimeNode) => String(sibling?.name ?? '') === name)
      : [current];
    const sameNameIndex = Math.max(0, siblings.indexOf(current));
    segments.unshift(`${encodeURIComponent(name)}~${sameNameIndex}`);
    current = current.parent ?? null;
  }
  return `/${segments.join('/')}`;
}

function readStablePathSegment(segment: string): { name: string; sameNameIndex: number } {
  const matched = /^(.*)~(\d+)$/.exec(segment);
  const encodedName = matched?.[1] ?? segment;
  const sameNameIndex = matched ? Number(matched[2]) : 0;
  try {
    return { name: decodeURIComponent(encodedName), sameNameIndex };
  } catch {
    return { name: encodedName, sameNameIndex };
  }
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
async function resolveCreatorReference(
  reference: RuntimeWriteReference,
  propertyPath: string
): Promise<unknown> {
  if (reference.kind === 'missing' || reference.available === false) {
    throw new ProbeError('REFERENCE_NOT_AVAILABLE', { propertyPath, reference });
  }
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
    const assetUuid = typeof reference.subAssetUuid === 'string' && reference.subAssetUuid
      ? reference.subAssetUuid
      : reference.assetUuid;
    if (typeof assetUuid !== 'string' || !assetUuid) {
      throw new ProbeError('REFERENCE_TARGET_NOT_FOUND', { propertyPath, reference });
    }
    return loadAssetByUuid(assetUuid, propertyPath);
  }
  throw new ProbeError('REFERENCE_ASSET_NOT_SUPPORTED', { propertyPath, kind: reference.kind });
}

async function readAssetMeta(assetUrl: string): Promise<Record<string, unknown>> {
  const meta = await Editor.Message.request('asset-db', 'query-asset-meta', assetUrl);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new ProbeError('ASSET_META_NOT_FOUND', { assetUrl });
  }
  return meta as unknown as Record<string, unknown>;
}

function resolveCreatorSpecialValue(
  value: Record<string, unknown>,
  currentValue: unknown
): unknown | undefined {
  const ctorName = (currentValue as { constructor?: { name?: string } })?.constructor?.name;
  if (ctorName === 'Color' && typeof ccModule.Color === 'function') {
    return new ccModule.Color(value.r, value.g, value.b, value.a);
  }
  if (ctorName === 'Vec2' && typeof ccModule.Vec2 === 'function') {
    return new ccModule.Vec2(value.x, value.y);
  }
  if (ctorName === 'Vec3' && typeof ccModule.Vec3 === 'function') {
    return new ccModule.Vec3(value.x, value.y, value.z);
  }
  if (ctorName === 'Size' && typeof ccModule.Size === 'function') {
    return new ccModule.Size(value.width, value.height);
  }
  return undefined;
}

function createCreatorSerializedObject(owner: unknown, propertyPath: string): unknown | undefined {
  const rootProperty = parsePropertyPath(propertyPath)[0];
  if (typeof rootProperty !== 'string') return undefined;
  const ownerConstructor = (owner as { constructor?: unknown })?.constructor;
  if (typeof ownerConstructor !== 'function') return undefined;

  const attributes = readRuntimeWriteClassAttributes(
    readObject(ccModule.cclegacy).Class,
    ownerConstructor
  );
  if (!attributes) return undefined;
  const propertyType = readRuntimeWriteObjectConstructor(attributes, rootProperty);
  if (!propertyType) return undefined;

  try {
    return new propertyType();
  } catch (error) {
    throw new ProbeError('PROPERTY_VALUE_TYPE_INSTANTIATION_FAILED', {
      propertyPath,
      typeName: propertyType.name || null,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
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
