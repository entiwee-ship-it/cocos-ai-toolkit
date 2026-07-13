import { BridgeClient } from './bridge-client';
import { buildBridgeHello, probeEditorState } from './editor-state';
import { ProbeError } from './probe-errors';
import { probeAssets } from './asset-probe';

const BRIDGE_VERSION = '0.1.0';
const DEFAULT_SERVER_URL = 'ws://127.0.0.1:32188';

let client: BridgeClient | null = null;

type JsonObject = Record<string, unknown>;

const sceneMethods = {
  'probe.editorState': 'probeEditorState',
  'probe.assets': 'probeAssets',
  'probe.hierarchy': 'probeHierarchy',
  'probe.node': 'probeNode',
  'probe.component': 'probeComponent',
  'probe.prefab': 'probePrefab',
  'probe.undoSave': 'probeUndoSave'
} as const;

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
      ...Object.fromEntries(Object.entries(sceneMethods)
        .filter(([method]) => method !== 'probe.editorState' && method !== 'probe.assets')
        .map(([method, sceneMethod]) => [
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
  'probe-editor-state': (request) => forwardToScene('probeEditorState', request),
  'probe-assets': (request) => forwardToScene('probeAssets', request),
  'probe-hierarchy': (request) => forwardToScene('probeHierarchy', request),
  'probe-node': (request) => forwardToScene('probeNode', request),
  'probe-component': (request) => forwardToScene('probeComponent', request),
  'probe-prefab': (request) => forwardToScene('probePrefab', request),
  'probe-undo-save': (request) => forwardToScene('probeUndoSave', request)
};
