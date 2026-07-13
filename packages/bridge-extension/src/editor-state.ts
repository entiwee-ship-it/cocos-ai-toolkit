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
