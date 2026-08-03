import { editorPreviewMessageSource, readPreviewStatus } from './preview';
import type { CreatorDocumentIdentity } from './creator-document-identity';

export const BRIDGE_CAPABILITIES = [
  'probe.editorState',
  'probe.assets',
  'probe.assetIndex',
  'probe.openAsset',
  'probe.hierarchy',
  'probe.node',
  'probe.component',
  'probe.documentSnapshot',
  'probe.prefab',
  'probe.directWrite',
  'probe.saveDocument',
  'probe.importAsset',
  'probe.createPrefab',
  'probe.deleteAsset',
  'probe.refreshAsset',
  'probe.previewOpen',
  'probe.previewStatus',
  'probe.previewReload'
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

/**
 * 读取编辑器当前状态：主进程公开消息探针 + 调用方已解析的当前文档身份。
 *
 * @param identity Scene 进程经 cce.SceneFacadeManager 实测的当前文档身份；
 *   缺省或解析失败时不伪造 assetUuid，只把未解析证据放进 unresolved。
 * @returns 编辑器版本、项目、文档、就绪、选择、预览状态和未解析证据。
 */
export async function probeEditorState(identity?: CreatorDocumentIdentity): Promise<unknown> {
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
  for (const failure of identity?.failures ?? []) {
    unresolved.push({
      path: failure.source.endsWith('.queryMode') ? 'document.mode' : 'document.assetUuid',
      reason: failure.reason
    });
  }
  if (!identity?.assetUuid) {
    if (!(identity?.failures ?? []).some((failure) => failure.reason === 'CURRENT_DOCUMENT_UUID_EMPTY')) {
      unresolved.push({ path: 'document.assetUuid', reason: 'CURRENT_DOCUMENT_UUID_EMPTY' });
    }
  }
  const preview = await readPreviewStatus(editorPreviewMessageSource);
  return {
    creatorVersion: Editor.App.version,
    projectPath: Editor.Project.path,
    projectId: Editor.Project.uuid,
    document: {
      assetUuid: identity?.assetUuid ?? null,
      dirty,
      ...(identity?.assetUuid ? { mode: identity.mode ?? null, source: identity.source ?? null } : {})
    },
    ready: { scene: sceneReady, assetDatabase: assetDatabaseReady },
    selection,
    preview,
    unresolved
  };
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : 'MESSAGE_API_UNAVAILABLE';
}
