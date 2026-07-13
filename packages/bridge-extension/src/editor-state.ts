export const BRIDGE_CAPABILITIES = [
  'probe.editorState',
  'probe.assets',
  'probe.hierarchy',
  'probe.node',
  'probe.component',
  'probe.prefab',
  'probe.undoSave'
] as const;

export interface BridgeEditorState {
  processId: number;
  projectPath: string;
  projectId: string;
  creatorVersion: string;
  bridgeVersion: string;
}

export function buildBridgeHello(state: BridgeEditorState) {
  return {
    method: 'bridge.hello' as const,
    payload: {
      editorInstanceId: `${state.projectId}:${state.processId}`,
      projectId: state.projectId,
      projectPath: state.projectPath,
      creatorVersion: state.creatorVersion,
      bridgeVersion: state.bridgeVersion,
      capabilities: [...BRIDGE_CAPABILITIES]
    }
  };
}

export async function probeEditorState(): Promise<unknown> {
  const unresolved: Array<{ path: string; reason: string }> = [];
  const [assetDatabaseReady, sceneReady, dirty] = await Promise.all([
    Editor.Message.request('asset-db', 'query-ready'),
    Editor.Message.request('scene', 'query-is-ready'),
    Editor.Message.request('scene', 'query-dirty').catch((error: unknown) => {
      unresolved.push({ path: 'document.dirty', reason: readReason(error) });
      return null;
    })
  ]);
  const selection = {
    node: Editor.Selection.getSelected('node'),
    asset: Editor.Selection.getSelected('asset')
  };
  unresolved.push({ path: 'document.assetUuid', reason: 'PUBLIC_API_NOT_CONFIRMED' });
  unresolved.push({ path: 'preview', reason: 'PUBLIC_API_NOT_CONFIRMED' });
  return {
    creatorVersion: Editor.App.version,
    projectPath: Editor.Project.path,
    projectId: Editor.Project.uuid,
    document: { assetUuid: null, dirty },
    ready: { scene: sceneReady, assetDatabase: assetDatabaseReady },
    selection,
    preview: null,
    unresolved
  };
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : 'MESSAGE_API_UNAVAILABLE';
}
