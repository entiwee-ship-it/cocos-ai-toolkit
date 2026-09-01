import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CAPABILITIES, buildBridgeHello, openExtensionManager, selectEditorNode } from '../src/bridge-state.js';
import { normalizeAssetInfo } from '../src/asset-probe.js';

afterEach(() => vi.unstubAllGlobals());

describe('buildBridgeHello', () => {
  it('保留项目身份并只声明当前 Bridge 真实提供的写能力', () => {
    const hello = buildBridgeHello({
      processId: 123,
      projectPath: 'E:/project',
      projectId: 'project-uuid',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.6.9',
      bridgeBuildId: 'sha256:bridge-build'
    });

    expect(hello.method).toBe('bridge.hello');
    expect(hello.payload.editorInstanceId).toBe('project-uuid:123');
    expect(hello.payload.projectPath).toBe('E:/project');
    expect(hello.payload.creatorVersion).toBe('3.8.8');
    expect(hello.payload.bridgeBuildId).toBe('sha256:bridge-build');
    expect(hello.payload.capabilities).toEqual([...BRIDGE_CAPABILITIES]);
    expect(BRIDGE_CAPABILITIES).toContain('probe.directWrite');
    expect(BRIDGE_CAPABILITIES).toContain('probe.saveDocument');
    expect(BRIDGE_CAPABILITIES).toContain('probe.importAsset');
    expect(BRIDGE_CAPABILITIES).toContain('probe.nodeSelect');
    expect(BRIDGE_CAPABILITIES).toContain('probe.extensionManagerOpen');
  });
});

describe('selectEditorNode', () => {
  it('先清空再选择并回读唯一节点', () => {
    const selection: string[] = ['old-node'];
    const calls: string[] = [];
    vi.stubGlobal('Editor', {
      Selection: {
        clear(type: string) {
          calls.push(`clear:${type}`);
          selection.splice(0);
        },
        select(type: string, uuid: string) {
          calls.push(`select:${type}:${uuid}`);
          selection.push(uuid);
        },
        getSelected: () => [...selection]
      }
    });

    expect(selectEditorNode('node-1')).toEqual({
      nodeUuid: 'node-1',
      selected: true,
      selection: ['node-1']
    });
    expect(calls).toEqual(['clear:node', 'select:node:node-1']);
  });
});

describe('openExtensionManager', () => {
  it('通过 Creator Panel API 打开并回读扩展管理器', async () => {
    const open = vi.fn(async () => true);
    const has = vi.fn(async () => true);
    vi.stubGlobal('Editor', { Panel: { open, has } });

    await expect(openExtensionManager()).resolves.toEqual({
      panel: 'extension.manager',
      opened: true
    });
    expect(open).toHaveBeenCalledWith('extension.manager');
    expect(has).toHaveBeenCalledWith('extension.manager');
  });
});

describe('normalizeAssetInfo', () => {
  it('保留资源身份、导入信息和原始未知字段', () => {
    const asset = normalizeAssetInfo({
      uuid: 'asset-1',
      url: 'db://assets/example.prefab',
      file: 'E:/project/assets/example.prefab',
      type: 'cc.Prefab',
      importer: 'prefab',
      isSubAsset: false,
      isBundle: true,
      futureField: { enabled: true }
    });

    expect(asset).toMatchObject({
      uuid: 'asset-1',
      url: 'db://assets/example.prefab',
      file: 'E:/project/assets/example.prefab',
      type: 'cc.Prefab',
      importer: 'prefab',
      isSubAsset: false,
      isBundle: true,
      name: null,
      source: null,
      unknownFieldCount: 1
    });
    expect(asset.raw).toMatchObject({ futureField: { enabled: true } });
  });
});
