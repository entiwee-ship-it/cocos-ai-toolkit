import { BridgeClient, type BridgeLifecycleEvent } from './bridge-client';
import { readBridgeBuildId } from './bridge-build-info';
import { buildBridgeHello, openExtensionManager, probeEditorState, selectEditorNode } from './bridge-state';
import type { CreatorDocumentIdentity } from './creator-document-identity';
import { editorPreviewMessageSource, nodeHttpPreviewProbe, openPreviewServer, readPreviewStatus, reloadPreviewPages } from './preview';
import { ProbeError } from './probe-errors';
import { probeAssets } from './asset-probe';
import {
  invalidateAssetIndexCache,
  probeAssetIndex,
  probeAssetSearch,
  probeScriptPathsByUuid
} from './asset-index';
import { importAsset } from './import-asset';
import { createProbeServerBootstrap, type ProbeBootstrapResult } from './probe-bootstrap';

const BRIDGE_VERSION = '0.6.9';
const BRIDGE_BUILD_ID = readBridgeBuildId(__dirname);
const DEFAULT_SERVER_URL = 'ws://127.0.0.1:32188';

const BRIDGE_LIFECYCLE_LOG_NAMES: Record<BridgeLifecycleEvent['type'], string> = {
  connecting: '正在连接探针服务',
  'socket-open': '探针连接已建立',
  'hello-sent': '已发送身份握手',
  ready: '扩展初始化完成',
  disconnected: '探针连接已断开',
  'retry-scheduled': '已安排重新连接',
  disposed: '扩展已卸载'
};

let client: BridgeClient | null = null;

type JsonObject = Record<string, unknown>;

const sceneMethods = {
  'probe.hierarchy': 'probeHierarchy',
  'probe.node': 'probeNode',
  'probe.prefab': 'probePrefab'
} as const;

export function load(): void {
  invalidateAssetIndexCache();
  const project = Editor.Project as typeof Editor.Project & { uuid?: string };
  const app = Editor.App as typeof Editor.App & { version?: string };
  const projectPath = project.path;
  const projectId = process.env.COCOS_AI_PROJECT_ID ?? project.uuid ?? projectPath;
  const creatorVersion = process.env.COCOS_CREATOR_VERSION ?? app.version ?? '3.8.x-unknown';
  const probeUrl = process.env.COCOS_AI_PROBE_SERVER_URL ?? DEFAULT_SERVER_URL;

  const handlers: Readonly<Record<string, (payload: unknown) => Promise<unknown>>> = {
      'probe.editorState': () => probeEditorStateWithDocumentIdentity(),
      'probe.assets': (payload) => probeAssets(payload),
      'probe.assetIndex': (payload) => probeAssetIndex(payload),
      'probe.assetSearch': (payload) => probeAssetSearch(payload),
      'probe.component': (payload) => probeComponent(payload),
    'probe.nodeSelect': (payload) => {
        const request = payload as { uuid?: unknown };
        if (typeof request.uuid !== 'string' || !request.uuid) throw new ProbeError('UUID_REQUIRED');
        const result = selectEditorNode(request.uuid);
        if (!result.selected) throw new ProbeError('NODE_SELECTION_VERIFY_FAILED', result);
      return Promise.resolve(result);
    },
    'probe.extensionManagerOpen': async () => {
      const result = await openExtensionManager();
      if (!result.opened) throw new ProbeError('EXTENSION_MANAGER_OPEN_FAILED', result);
      return result;
    },
    'probe.openAsset': async (payload) => {
        const request = payload as { uuid?: unknown };
        if (typeof request.uuid !== 'string' || !request.uuid) throw new ProbeError('UUID_REQUIRED');
        await Editor.Message.request('asset-db', 'open-asset', request.uuid);
        return { opened: true, uuid: request.uuid };
      },
      // 直写入口：直接驱动 Scene 写执行器（原子写 + 保存 + 逐项重读）。
      'probe.directWrite': (payload) => forwardDirectWrite(payload),
      'probe.saveDocument': () => forwardToScene('saveDocument', {}),
      'probe.importAsset': (payload) => invalidateAfterAssetWrite(importAsset(payload)),
      'probe.deleteAsset': (payload) => invalidateAfterAssetWrite(forwardToScene('deleteAsset', payload)),
      'probe.refreshAsset': (payload) => invalidateAfterAssetWrite(forwardToScene('refreshAsset', payload)),
      'probe.previewOpen': () => openPreviewServer(editorPreviewMessageSource, nodeHttpPreviewProbe),
      'probe.previewStatus': () => readPreviewStatus(editorPreviewMessageSource),
      'probe.previewReload': () => reloadPreviewPages(editorPreviewMessageSource),
      ...Object.fromEntries(Object.entries(sceneMethods).map(([method, sceneMethod]) => [
        method,
        (payload: unknown) => forwardToScene(sceneMethod, payload)
      ]))
  };
  logBridgeLifecycle('扩展开始加载', {
    扩展版本: BRIDGE_VERSION,
    构建指纹: BRIDGE_BUILD_ID,
    Creator版本: creatorVersion,
    项目ID: projectId,
    项目路径: projectPath,
    进程ID: process.pid,
    探针地址: probeUrl,
    能力数量: Object.keys(handlers).length
  });

  const bootstrap = createProbeServerBootstrap({
    url: probeUrl,
    bridgeDistDirectory: __dirname,
    nodePath: process.env.COCOS_AI_NODE_PATH
  });
  let bridgeClient: BridgeClient;
  bridgeClient = new BridgeClient({
    url: probeUrl,
    sessionToken: process.env.COCOS_AI_SESSION_TOKEN,
    hello: () => buildBridgeHello({
      processId: process.pid,
      projectPath,
      projectId,
      creatorVersion,
      bridgeVersion: BRIDGE_VERSION,
      bridgeBuildId: BRIDGE_BUILD_ID
    }),
    handlers,
    onLifecycleEvent: (event) => {
      logBridgeClientLifecycle(event);
      if (event.type === 'disconnected' && client === bridgeClient) {
        void ensureProbeServer(bootstrap);
      }
    }
  });
  client = bridgeClient;
  bridgeClient.connect();
  void ensureProbeServer(bootstrap);
}

export function unload(): void {
  client?.dispose();
  client = null;
  invalidateAssetIndexCache();
}

function logBridgeClientLifecycle(event: BridgeLifecycleEvent): void {
  logBridgeLifecycle(
    BRIDGE_LIFECYCLE_LOG_NAMES[event.type],
    localizeBridgeLifecycleDetails(event)
  );
}

function localizeBridgeLifecycleDetails(event: BridgeLifecycleEvent): Record<string, unknown> {
  switch (event.type) {
    case 'connecting':
    case 'socket-open': return { 地址: event.url };
    case 'disconnected': return { 关闭码: event.code, 原因: event.reason };
    case 'retry-scheduled': return { 重试次数: event.attempt, 等待毫秒: event.delayMs };
    case 'hello-sent':
    case 'ready':
    case 'disposed': return {};
  }
}

function logBridgeLifecycle(eventName: string, details: Record<string, unknown>): void {
  const usefulDetails = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== '' && value !== null && value !== undefined)
  );
  const suffix = Object.keys(usefulDetails).length > 0
    ? ` ${JSON.stringify(usefulDetails)}`
    : '';
  const message = `[CocosAI][Bridge] ${eventName}${suffix}`;
  try {
    const editorGlobal = Editor as unknown as Record<string, unknown>;
    if (typeof editorGlobal.log === 'function') {
      (editorGlobal.log as (text: string) => void)(message);
      return;
    }
  } catch {
    // Creator 日志 API 不可用时继续回退到进程控制台。
  }
  console.log(message);
}

async function ensureProbeServer(
  bootstrap: { ensureRunning(): Promise<ProbeBootstrapResult> }
): Promise<void> {
  try {
    const result = await bootstrap.ensureRunning();
    logBridgeLifecycle('探针服务自检完成', { 结果: result });
  } catch (error) {
    logBridgeLifecycle('探针服务自动启动失败', {
      原因: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * 组合主进程公开状态探针与 Scene 进程当前文档身份。
 * 身份转发失败时按未解析保留证据（best-effort），不拖死整个编辑器状态探针。
 *
 * @returns 编辑器状态；document.assetUuid/mode/source 由 Scene 进程实测填充。
 */
async function probeEditorStateWithDocumentIdentity(): Promise<unknown> {
  const identity = await forwardToScene('editorStateDocumentIdentity', {})
    .catch((error: unknown): CreatorDocumentIdentity => ({
      assetUuid: null,
      mode: null,
      source: null,
      failures: [{
        source: 'scene.editorStateDocumentIdentity',
        reason: error instanceof Error ? error.message : String(error)
      }]
    })) as CreatorDocumentIdentity;
  return probeEditorState(identity);
}

/**
 * 尽力读取脚本 UUID 路径，并转发单个组件的完整 Schema 请求到 Scene 进程。
 *
 * @param request 包含当前文档组件实例 UUID 的请求。
 * @returns 组件身份、属性、Inspector 元数据、脚本路径和原始 Dump。
 */
async function probeComponent(request: unknown): Promise<unknown> {
  const scriptPathsByUuid = await readScriptPathsBestEffort();
  return forwardToScene('probeComponent', {
    request: readObject(request),
    scriptPathsByUuid
  });
}

/**
 * 尽力读取脚本资产索引，AssetDB 索引异常时保留组件和文档主查询能力。
 *
 * @returns 可跨 Creator 进程传输的 UUID、路径元组；索引不可用时返回空数组。
 */
async function readScriptPathsBestEffort(): Promise<Array<[string, string]>> {
  try {
    return await probeScriptPathsByUuid();
  } catch {
    return [];
  }
}

async function invalidateAfterAssetWrite<T>(operation: Promise<T>): Promise<T> {
  return operation.finally(invalidateAssetIndexCache);
}

async function forwardDirectWrite(payload: unknown): Promise<unknown> {
  const operation = forwardToScene('writeExecute', payload);
  return hasAssetIndexMutation(payload) ? invalidateAfterAssetWrite(operation) : operation;
}

function hasAssetIndexMutation(payload: unknown): boolean {
  const operations = readObject(payload).operations;
  return Array.isArray(operations) && operations.some((value) => {
    const type = readObject(value).type;
    return typeof type === 'string' && (type.startsWith('asset.') || type === 'prefab.create_from_node');
  });
}

async function forwardToScene(method: string, request: unknown): Promise<unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ProbeError('INVALID_REQUEST');
  }
  return Editor.Message.request('scene', 'execute-scene-script', {
    name: 'cocos-ai-bridge',
    method,
    args: [request]
  });
}

/**
 * 把未知输入收窄为普通对象。
 *
 * @param value 待解析输入。
 * @returns 普通对象；其它值返回空对象。
 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const methods: Record<string, (request: JsonObject) => Promise<unknown>> = {
  'probe-editor-state': () => probeEditorStateWithDocumentIdentity(),
  'probe-assets': (request) => probeAssets(request),
  'probe-asset-index': (request) => probeAssetIndex(request),
  'probe-hierarchy': (request) => forwardToScene('probeHierarchy', request),
  'probe-node': (request) => forwardToScene('probeNode', request),
  'probe-component': (request) => probeComponent(request),
  'probe-prefab': (request) => forwardToScene('probePrefab', request),
  'probe-direct-write': (request) => forwardDirectWrite(request),
  'probe-save-document': () => forwardToScene('saveDocument', {}),
  'probe-import-asset': (request) => invalidateAfterAssetWrite(importAsset(request))
};
