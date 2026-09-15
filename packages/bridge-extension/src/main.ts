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
import {
  editorPreviewMessageSource,
  editorSimulatorPreviewSource,
  evaluateSimulatorRuntime,
  nodeHttpPreviewProbe,
  openPreviewServer,
  openSimulatorPreview,
  readPreviewStatus,
  readSimulatorRuntimeStatus,
  reloadPreviewPages
} from './preview';
import { ProbeError } from './probe-errors';
import { WorkbenchHost, type WorkbenchCreatorRequest } from './workbench-host';

interface ToolCatalogEntry {
  name: string;
  group: string;
  mutating: boolean;
  destructive?: boolean;
  summary: string;
}

const TOOL_CATALOG = require('../tool-catalog.json') as ToolCatalogEntry[];
const BRIDGE_VERSION = '0.9.5';
const BRIDGE_RELEASE_DATE = '2026-09-09';

type JsonObject = Record<string, unknown>;

type SimulatorOrientation = 'portrait' | 'landscape' | 'reverse-portrait' | 'reverse-landscape';

interface SimulatorDevice {
  name: string;
  width: number;
  height: number;
  ratio: number;
}

interface SimulatorSettings {
  devices: SimulatorDevice[];
  device: string;
  resolutionIndex: number;
  orientation: SimulatorOrientation;
  debugger: boolean;
}

const SIMULATOR_ORIENTATIONS: readonly SimulatorOrientation[] = [
  'portrait',
  'landscape',
  'reverse-portrait',
  'reverse-landscape'
];

let ipcServer: CreatorIpcServer | null = null;
let workbenchHost: WorkbenchHost | null = null;
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
  'probe.workbenchOpen': () => openWorkbench(),
  'probe.workbenchRead': async (payload) => {
    if (!workbenchHost) return { status: 'idle', session: null, selectedPath: null, url: null };
    return workbenchHost.readSnapshot(readObject(payload));
  },
  'probe.assetReveal': async (payload) => {
    const uuid = readObject(payload).uuid;
    if (typeof uuid !== 'string' || !uuid) throw new ProbeError('UUID_REQUIRED');
    const info = await Editor.Message.request('asset-db', 'query-asset-info', uuid);
    if (!info || info.uuid !== uuid) throw new ProbeError('ASSET_NOT_FOUND');
    await Editor.Panel.open('assets');
    Editor.Selection.clear('asset');
    Editor.Selection.select('asset', uuid);
    const selected = Editor.Selection.getSelected('asset').includes(uuid);
    if (!selected) throw new ProbeError('ASSET_SELECTION_VERIFY_FAILED');
    return { selected, uuid, url: info.url };
  },
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
  'probe.simulatorOpen': () => openSimulatorPreviewWithoutDebugger(),
  'probe.simulatorSettings': () => readSimulatorSettings(),
  'probe.simulatorSettingsUpdate': (payload) => updateSimulatorSettings(payload),
  'probe.simulatorDebuggerClose': () => closeSimulatorDebugger(),
  'probe.simulatorRuntimeStatus': () => readSimulatorRuntimeStatus(editorPreviewMessageSource),
  'probe.simulatorRuntimeEvaluate': (payload) => {
    const input = readObject(payload);
    if (typeof input.runtimeId !== 'string' || !input.runtimeId) throw new ProbeError('RUNTIME_ID_REQUIRED');
    if (typeof input.expression !== 'string' || !input.expression) throw new ProbeError('RUNTIME_EXPRESSION_REQUIRED');
    return evaluateSimulatorRuntime(editorPreviewMessageSource, {
      runtimeId: input.runtimeId,
      expression: input.expression
    });
  },
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
  const host = workbenchHost;
  workbenchHost = null;
  await host?.stop();
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
      lastError: null
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

async function openWorkbench(): Promise<{ panel: string; opened: boolean; url: string }> {
  const { url } = await ensureWorkbenchHost();
  const panel = 'cocos-ai-bridge.workbench';
  await Editor.Panel.open(panel);
  return { panel, opened: await Editor.Panel.has(panel), url };
}

/**
 * 启动 Creator Simulator，并在 Workbench 场景中隐藏独立 Debugger 面板。
 *
 * @returns Simulator 启动结果与预览地址。
 */
async function openSimulatorPreviewWithoutDebugger(): Promise<unknown> {
  const key = 'preview.simulator_debugger';
  const previous = await Editor.Profile.getConfig('preview', key, 'local');
  try {
    // 先按 Creator 原生可见模式创建渲染表面，避免关闭配置后只得到隐藏 dummy 窗口。
    await Editor.Profile.setConfig('preview', key, true, 'local');
    const result = await openSimulatorPreview(editorSimulatorPreviewSource);
    await closeSimulatorDebugger();
    return result;
  } finally {
    if (typeof previous === 'boolean') {
      await Editor.Profile.setConfig('preview', key, previous, 'local').catch(() => undefined);
    } else {
      await Editor.Profile.removeConfig('preview', key, 'local').catch(() => undefined);
    }
    await closeSimulatorDebugger();
  }
}

/**
 * 读取 Creator Preview 的设备、方向和 Debugger 配置，供运行 Workbench 展示。
 *
 * @returns 当前可选设备和生效配置。
 */
async function readSimulatorSettings(): Promise<SimulatorSettings> {
  const rawDevices = await Editor.Message.request('device', 'query');
  const devices = Array.isArray(rawDevices)
    ? rawDevices.map(readSimulatorDevice).filter((device): device is SimulatorDevice => device !== null)
    : [];
  if (devices.length === 0) throw new ProbeError('SIMULATOR_DEVICES_UNAVAILABLE');

  const [rawDevice, rawResolutionIndex, rawOrientation, rawDebugger] = await Promise.all([
    Editor.Profile.getConfig('preview', 'preview.device', 'local'),
    Editor.Profile.getConfig('preview', 'preview.simulator_resolution', 'local'),
    Editor.Profile.getConfig('preview', 'preview.simulator_orientation', 'local'),
    Editor.Profile.getConfig('preview', 'preview.simulator_debugger', 'local')
  ]);
  const deviceName = typeof rawDevice === 'string' ? rawDevice : '';
  const namedIndex = devices.findIndex((device) => device.name === deviceName);
  const configuredIndex = typeof rawResolutionIndex === 'number' && Number.isInteger(rawResolutionIndex)
    ? rawResolutionIndex
    : -1;
  const resolutionIndex = configuredIndex >= 0 && configuredIndex < devices.length
    ? configuredIndex
    : namedIndex >= 0 ? namedIndex : 0;
  const orientation = isSimulatorOrientation(rawOrientation) ? rawOrientation : 'landscape';
  return {
    devices,
    device: devices[resolutionIndex].name,
    resolutionIndex,
    orientation,
    debugger: rawDebugger === true
  };
}

/**
 * 保存 Workbench 选择的 Simulator 设备和方向。
 *
 * @param payload 包含 resolutionIndex 与 orientation 的设置请求。
 * @returns 保存后的完整 Simulator 配置。
 */
async function updateSimulatorSettings(payload: unknown): Promise<SimulatorSettings> {
  const current = await readSimulatorSettings();
  const input = readObject(payload);
  const resolutionIndex = input.resolutionIndex === undefined
    ? current.resolutionIndex
    : Number(input.resolutionIndex);
  if (!Number.isInteger(resolutionIndex) || resolutionIndex < 0 || resolutionIndex >= current.devices.length) {
    throw new ProbeError('SIMULATOR_RESOLUTION_INVALID', {
      resolutionIndex,
      deviceCount: current.devices.length
    });
  }
  const orientation = input.orientation === undefined ? current.orientation : input.orientation;
  if (!isSimulatorOrientation(orientation)) {
    throw new ProbeError('SIMULATOR_ORIENTATION_INVALID', { orientation });
  }
  await Editor.Profile.setConfig('preview', 'preview.device', current.devices[resolutionIndex].name, 'local');
  await Editor.Profile.setConfig('preview', 'preview.simulator_resolution', resolutionIndex, 'local');
  await Editor.Profile.setConfig('preview', 'preview.simulator_orientation', orientation, 'local');
  return readSimulatorSettings();
}

/**
 * 关闭 Creator Preview 创建的独立 Debugger 面板。
 *
 * @returns 面板关闭结果。
 */
async function closeSimulatorDebugger(): Promise<{ closed: boolean }> {
  const closed = await Editor.Panel.close('preview.debugger').catch(() => false);
  return { closed: closed === true };
}

function readSimulatorDevice(value: unknown): SimulatorDevice | null {
  const item = readObject(value);
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const width = typeof item.width === 'number' ? item.width : Number(item.width);
  const height = typeof item.height === 'number' ? item.height : Number(item.height);
  const ratio = typeof item.ratio === 'number' ? item.ratio : Number(item.ratio);
  if (!name || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  return {
    name,
    width: Math.round(width),
    height: Math.round(height),
    ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  };
}

function isSimulatorOrientation(value: unknown): value is SimulatorOrientation {
  return typeof value === 'string'
    && SIMULATOR_ORIENTATIONS.includes(value as SimulatorOrientation);
}

async function ensureWorkbenchHost(): Promise<{ url: string }> {
  if (!workbenchHost) {
    const descriptor = buildDescriptor();
    workbenchHost = new WorkbenchHost({
      projectId: descriptor.projectId,
      editorInstanceId: descriptor.editorInstanceId
    }, undefined, undefined, requestWorkbenchCreator);
  }
  try {
    return await workbenchHost.start();
  } catch (error) {
    await workbenchHost.stop().catch(() => undefined);
    workbenchHost = null;
    throw error;
  }
}

const requestWorkbenchCreator: WorkbenchCreatorRequest = async (selector, method, payload) => {
  const descriptor = buildDescriptor();
  if (selector.projectId !== descriptor.projectId || selector.editorInstanceId !== descriptor.editorInstanceId) {
    throw new ProbeError('EDITOR_INSTANCE_NOT_FOUND', { ...selector });
  }
  const handler = handlers[method];
  if (!handler) throw new ProbeError('METHOD_NOT_ALLOWED', { method });
  return handler(payload);
};

async function closeWorkbench(): Promise<{ detached: boolean }> {
  await workbenchHost?.stopSession(true);
  return { detached: true };
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
  const componentRequest = readObject(request);
  return forwardToScene('probeComponent', {
    request: componentRequest,
    ...(componentRequest.runtimeInspector ? {} : { scriptPathsByUuid: await readScriptPathsBestEffort() })
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
  openWorkbench: () => openWorkbench(),
  queryWorkbenchUrl: () => ensureWorkbenchHost(),
  closeWorkbench: () => closeWorkbench(),
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
