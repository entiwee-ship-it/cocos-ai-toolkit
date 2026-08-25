import { describe, expect, it } from 'vitest';
import { BRIDGE_CAPABILITIES, buildBridgeHello } from '../src/editor-state.js';
import { normalizeAssetInfo } from '../src/asset-probe.js';

describe('buildBridgeHello', () => {
  it('保留项目身份并只声明当前 Bridge 真实提供的写能力', () => {
    const hello = buildBridgeHello({
      processId: 123,
      projectPath: 'E:/project',
      projectId: 'project-uuid',
      creatorVersion: '3.8.8',
      bridgeVersion: '0.1.0'
    });

    expect(hello.method).toBe('bridge.hello');
    expect(hello.payload.editorInstanceId).toBe('project-uuid:123');
    expect(hello.payload.projectPath).toBe('E:/project');
    expect(hello.payload.creatorVersion).toBe('3.8.8');
    expect(hello.payload.capabilities).toEqual([...BRIDGE_CAPABILITIES]);
    expect(BRIDGE_CAPABILITIES).toContain('probe.directWrite');
    expect(BRIDGE_CAPABILITIES).toContain('probe.saveDocument');
    expect(BRIDGE_CAPABILITIES).toContain('probe.importAsset');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.documentSnapshot');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.writePrepare');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.writeRevision');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.writeConfirm');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.transactionStatus');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.transactionList');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.transactionRollback');
    expect(BRIDGE_CAPABILITIES).not.toContain('probe.createAsset');
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
