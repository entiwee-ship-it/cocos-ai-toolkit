import { describe, expect, it } from 'vitest';
import { BRIDGE_CAPABILITIES, buildBridgeHello } from '../src/editor-state.js';
import { normalizeAssetInfo } from '../src/asset-probe.js';

describe('buildBridgeHello', () => {
  it('保留项目路径和 Creator 精确版本', () => {
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
    expect(BRIDGE_CAPABILITIES).toContain('probe.writeRevision');
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
