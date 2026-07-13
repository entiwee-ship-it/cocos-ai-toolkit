import { readFile } from 'node:fs/promises';
import { BridgeClient } from './bridge-client';
import { buildBridgeHello, probeEditorState } from './editor-state';
import { ProbeError } from './probe-errors';
import { probeAssets } from './asset-probe';
import { probeAssetIndex } from './asset-index';
import { captureProbeRevision, restoreProbeAsset } from './probe-runtime';
import type { ProbePrepareRequest } from './probe-operation';
import {
  InMemoryProbeTransactionStore,
  ProbeTransactionCoordinator,
  type ProbeExecutionResult,
  type ProbeTransaction
} from './probe-transaction';

const BRIDGE_VERSION = '0.1.0';
const DEFAULT_SERVER_URL = 'ws://127.0.0.1:32188';

let client: BridgeClient | null = null;

type JsonObject = Record<string, unknown>;

const sceneMethods = {
  'probe.hierarchy': 'probeHierarchy',
  'probe.node': 'probeNode',
  'probe.component': 'probeComponent',
  'probe.prefab': 'probePrefab'
} as const;

const transactionStore = new InMemoryProbeTransactionStore();
const transactionCoordinator = new ProbeTransactionCoordinator({
  store: transactionStore,
  currentProjectPath: () => Editor.Project.path,
  captureRevision: (request) => captureCurrentRevision(request),
  execute: (transaction, recoveryContent) => executeTransaction(transaction, recoveryContent)
});

export function load(): void {
  const project = Editor.Project as typeof Editor.Project & { uuid?: string };
  const app = Editor.App as typeof Editor.App & { version?: string };
  const projectPath = project.path;
  const projectId = process.env.COCOS_AI_PROJECT_ID ?? project.uuid ?? projectPath;
  const creatorVersion = process.env.COCOS_CREATOR_VERSION ?? app.version ?? '3.8.x-unknown';

  client = new BridgeClient({
    url: process.env.COCOS_AI_PROBE_SERVER_URL ?? DEFAULT_SERVER_URL,
    sessionToken: process.env.COCOS_AI_SESSION_TOKEN,
    hello: () => buildBridgeHello({
      processId: process.pid,
      projectPath,
      projectId,
      creatorVersion,
      bridgeVersion: BRIDGE_VERSION
    }),
    handlers: {
      'probe.editorState': () => probeEditorState(),
      'probe.assets': (payload) => probeAssets(payload),
      'probe.assetIndex': () => probeAssetIndex(),
      'probe.openAsset': async (payload) => {
        const request = payload as { uuid?: unknown };
        if (typeof request.uuid !== 'string' || !request.uuid) throw new ProbeError('UUID_REQUIRED');
        await Editor.Message.request('asset-db', 'open-asset', request.uuid);
        return { opened: true, uuid: request.uuid };
      },
      'probe.undoSavePrepare': (payload) => transactionCoordinator.prepare(payload),
      'probe.undoSaveConfirm': (payload) => transactionCoordinator.confirm(payload),
      'probe.undoSaveStatus': async (payload) => transactionCoordinator.status(payload),
      ...Object.fromEntries(Object.entries(sceneMethods).map(([method, sceneMethod]) => [
        method,
        (payload: unknown) => forwardToScene(sceneMethod, payload)
      ]))
    }
  });
  client.connect();
}

export function unload(): void {
  client?.dispose();
  client = null;
}

async function captureCurrentRevision(request: ProbePrepareRequest) {
  return captureProbeRevision(request, {
    queryAssetInfo: (documentAssetUuid) => Editor.Message.request('asset-db', 'query-asset-info', documentAssetUuid),
    readFile,
    queryDirty: () => Editor.Message.request('scene', 'query-dirty'),
    queryNodeTree: () => Editor.Message.request('scene', 'query-node-tree')
  });
}

async function executeTransaction(
  transaction: ProbeTransaction,
  recoveryContent?: string
): Promise<ProbeExecutionResult> {
  const sceneResult = await forwardToScene('probeUndoSaveConfirm', transaction) as ProbeExecutionResult;
  if (recoveryContent === undefined) {
    throw new ProbeError('RECOVERY_CONTENT_UNAVAILABLE');
  }
  const recovery = await restoreProbeAsset({
    documentAssetUuid: transaction.documentAssetUuid,
    baselineSha256: transaction.baseline.assetSha256,
    recoveryContent
  }, {
    readCurrentContent: () => readDocumentAsset(transaction.documentAssetUuid),
    saveAsset: (documentAssetUuid, content) => Editor.Message.request(
      'asset-db',
      'save-asset',
      documentAssetUuid,
      content
    )
  });
  const finalSnapshot = await captureCurrentRevision(transaction);
  const diskHashRestored = recovery.diskHashRestored
    && finalSnapshot.assetSha256 === transaction.baseline.assetSha256;
  const editorStateRestored = finalSnapshot.hierarchySha256 === transaction.baseline.hierarchySha256
    && finalSnapshot.dirty === transaction.baseline.dirty
    && finalSnapshot.parentNodeUuid === transaction.baseline.parentNodeUuid
    && finalSnapshot.existingProbeNodeUuid === null;

  return {
    ...sceneResult,
    diskHashRestored,
    recoveryMethod: recovery.recoveryMethod,
    status: diskHashRestored && editorStateRestored ? 'rolled-back' : 'manual-recovery-required',
    rolledBack: {
      ...sceneResult.rolledBack,
      diskHashRestored,
      editorStateRestored,
      finalAssetSha256: recovery.finalAssetSha256,
      finalHierarchySha256: finalSnapshot.hierarchySha256
    }
  };
}

async function readDocumentAsset(documentAssetUuid: string): Promise<Buffer> {
  const value = await Editor.Message.request('asset-db', 'query-asset-info', documentAssetUuid);
  const assetInfo = value && typeof value === 'object' ? value as { file?: unknown } : {};
  if (typeof assetInfo.file !== 'string' || !assetInfo.file) {
    throw new ProbeError('ASSET_FILE_PATH_UNAVAILABLE');
  }
  return readFile(assetInfo.file);
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

export const methods: Record<string, (request: JsonObject) => Promise<unknown>> = {
  'probe-editor-state': () => probeEditorState(),
  'probe-assets': (request) => probeAssets(request),
  'probe-asset-index': () => probeAssetIndex(),
  'probe-hierarchy': (request) => forwardToScene('probeHierarchy', request),
  'probe-node': (request) => forwardToScene('probeNode', request),
  'probe-component': (request) => forwardToScene('probeComponent', request),
  'probe-prefab': (request) => forwardToScene('probePrefab', request),
  'probe-undo-save-prepare': (request) => transactionCoordinator.prepare(request),
  'probe-undo-save-confirm': (request) => transactionCoordinator.confirm(request),
  'probe-undo-save-status': async (request) => transactionCoordinator.status(request)
};
