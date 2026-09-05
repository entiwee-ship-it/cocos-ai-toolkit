import { probeAssetIndex, probeAssetSearch, probeScriptPathsByUuid, invalidateAssetIndexCache } from './asset-index';
import { probeAssets } from './asset-probe';
import { readBridgeBuildId } from './bridge-build-info';
import { buildBridgeHello, openExtensionManager, probeEditorState, selectEditorNode } from './bridge-state';
import type { CreatorDocumentIdentity } from './creator-document-identity';
import { importAsset } from './import-asset';
import {
  CreatorIpcServer,
  buildCreatorPipeName,
  type CreatorEndpointDescriptor,
  type CreatorIpcLifecycleEvent
} from './ipc-server';
import { editorPreviewMessageSource, nodeHttpPreviewProbe, openPreviewServer, readPreviewStatus, reloadPreviewPages } from './preview';
import { ProbeError } from './probe-errors';

interface ToolCatalogEntry {
  name: string;
  group: string;
  writeRequired: boolean;
  destructive?: boolean;
  summary: string;
}

const TOOL_CATALOG = require('../tool-catalog.json') as ToolCatalogEntry[];
const BRIDGE_VERSION = '0.8.0';
const BRIDGE_RELEASE_DATE = '2026-09-05';

type JsonObject = Record<string, unknown>;

let ipcServer: CreatorIpcServer | null = null;
let extensionStartedAt = new Date().toISOString();

const sceneMethods = {
  'probe.hierarchy': 'probeHierarchy',
  'probe.node': 'probeNode',
  'probe.prefab': 'probePrefab'
} as const;

const handlers: Readonly<Record<string, (payload: unknown) => Promise<unknown>>> = {
  'probe.editorState': () => probeEditorStateWithDocumentIdentity(),
  'probe.assets': (payload) => probeAssets(payload),
  'probe.assetIndex': (payload) => probeAssetIndex(payload),
  'probe.assetSearch': (payload) => probeAssetSearch(payload),
  'probe.component': (payload) => probeComponent(payload),
  'probe.nodeSelect': async (payload) => {
    const uuid = readObject(payload).uuid;
    if (typeof uuid !== 'string' || !uuid) throw new ProbeError('UUID_REQUIRED');
    const result = selectEditorNode(uuid);
    if (!result.selected) throw new ProbeError('NODE_SELECTION_VERIFY_FAILED', result);
    return result;
  },
  'probe.extensionManagerOpen': async () => {
    const result = await openExtensionManager();
    if (!result.opened) throw new ProbeError('EXTENSION_MANAGER_OPEN_FAILED', result);
    return result;
  },
  'probe.managerPanelOpen': () => openToolManager(),
  'probe.openAsset': async (payload) => {
    const uuid = readObject(payload).uuid;
    if (typeof uuid !== 'string' || !uuid) throw new ProbeError('UUID_REQUIRED');
    await Editor.Message.request('asset-db', 'open-asset', uuid);
    return { opened: true, uuid };
  },
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

/** Creator 扩展加载后只启动进程内命名管道，不再拉起外部服务。 */
export async function load(): Promise<void> {
  if (ipcServer) return;
  extensionStartedAt = new Date().toISOString();
  const descriptor = buildDescriptor();
  logBridgeLifecycle('扩展开始加载', {
    扩展版本: BRIDGE_VERSION,
    构建指纹: descriptor.bridgeBuildId,
    Creator版本: descriptor.creatorVersion,
    项目ID: descriptor.projectId,
    项目路径: descriptor.projectPath,
    进程ID: descriptor.processId,
    直连管道: descriptor.pipeName,
    能力数量: descriptor.capabilities.length
  });

  const server = new CreatorIpcServer({
    describe: buildDescriptor,
    handlers,
    sessionToken: process.env.COCOS_AI_SESSION_TOKEN,
    onLifecycleEvent: logIpcLifecycle
  });
  ipcServer = server;
  try {
    await server.start();
  } catch (error) {
    ipcServer = null;
    logBridgeLifecycle('本机直连启动失败', { 原因: readReason(error) });
    throw error;
  }
}

export async function unload(): Promise<void> {
  const server = ipcServer;
  ipcServer = null;
  invalidateAssetIndexCache();
  await server?.stop();
}

function buildDescriptor(): CreatorEndpointDescriptor {
  const projectPath = process.env.COCOS_AI_PROJECT_PATH ?? Editor.Project.path;
  const projectId = process.env.COCOS_AI_PROJECT_ID ?? Editor.Project.uuid;
  const creatorVersion = process.env.COCOS_CREATOR_VERSION ?? Editor.App.version ?? '3.8.x-unknown';
  const hello = buildBridgeHello({
    processId: process.pid,
    projectPath,
    projectId,
    creatorVersion,
    bridgeVersion: BRIDGE_VERSION,
    bridgeBuildId: readBridgeBuildId(__dirname)
  }).payload;
  return {
    schemaVersion: 1,
    ...hello,
    processId: process.pid,
    pipeName: buildCreatorPipeName(hello.editorInstanceId),
    startedAt: extensionStartedAt
  };
}

function logIpcLifecycle(event: CreatorIpcLifecycleEvent): void {
  switch (event.type) {
    case 'starting':
      return;
    case 'ready':
      logBridgeLifecycle('本机直连已就绪', {
        管道: event.pipeName,
        端点文件: event.endpointFile
      });
      return;
    case 'request-failed':
      logBridgeLifecycle('工具调用失败', {
        ...(event.method ? { 方法: event.method } : {}),
        原因: event.reason
      });
      return;
    case 'stopped':
      logBridgeLifecycle('扩展已卸载', { 管道: event.pipeName });
  }
}

function logBridgeLifecycle(eventName: string, details: Record<string, unknown>): void {
  const usefulDetails = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== '' && value !== null && value !== undefined)
  );
  const suffix = Object.keys(usefulDetails).length > 0 ? ` ${JSON.stringify(usefulDetails)}` : '';
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

async function queryManagerState(): Promise<unknown> {
  const editor = await probeEditorStateWithDocumentIdentity().catch((error) => ({
    unresolved: [{ path: 'manager.editorState', reason: readReason(error) }]
  }));
  return {
    extension: {
      name: 'Cocos AI',
      version: BRIDGE_VERSION,
      releaseDate: BRIDGE_RELEASE_DATE,
      buildId: readBridgeBuildId(__dirname),
      author: 'Enti'
    },
    tools: {
      version: BRIDGE_VERSION,
      total: TOOL_CATALOG.length,
      items: TOOL_CATALOG
    },
    ipc: ipcServer?.getStatus() ?? {
      state: 'stopped',
      pipeName: buildDescriptor().pipeName,
      activeRequests: 0,
      totalRequests: 0,
      lastRequestAt: null,
      lastError: null,
      authentication: process.env.COCOS_AI_SESSION_TOKEN ? 'enabled' : 'local-user'
    },
    editor,
    updatedAt: new Date().toISOString()
  };
}

async function openToolManager(): Promise<{ panel: string; opened: boolean }> {
  const panel = 'cocos-ai-bridge';
  await Editor.Panel.open(panel);
  return { panel, opened: await Editor.Panel.has(panel) };
}

/** 组合主进程公开状态探针与 Scene 进程当前文档身份。 */
async function probeEditorStateWithDocumentIdentity(): Promise<unknown> {
  const identity = await forwardToScene('editorStateDocumentIdentity', {})
    .catch((error: unknown): CreatorDocumentIdentity => ({
      assetUuid: null,
      mode: null,
      source: null,
      failures: [{
        source: 'scene.editorStateDocumentIdentity',
        reason: readReason(error)
      }]
    })) as CreatorDocumentIdentity;
  return probeEditorState(identity);
}

async function probeComponent(request: unknown): Promise<unknown> {
  return forwardToScene('probeComponent', {
    request: readObject(request),
    scriptPathsByUuid: await readScriptPathsBestEffort()
  });
}

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

function readObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const methods: Record<string, (request: JsonObject) => Promise<unknown>> = {
  openPanel: () => openToolManager(),
  queryManagerState: () => queryManagerState(),
  openExtensionManager: () => openExtensionManager(),
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
