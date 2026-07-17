import { describe, expect, it } from 'vitest';
import { buildAssetIndex, toSerializableAssetIndex } from '../src/asset-index';

describe('buildAssetIndex', () => {
  it('把脚本 UUID 稳定映射到 db 路径和磁盘路径', () => {
    const result = buildAssetIndex([{
      uuid: 'script-uuid',
      url: 'db://assets/script/TestComp.ts',
      file: 'E:/project/assets/script/TestComp.ts',
      type: 'cc.Script',
      importer: 'typescript',
      isSubAsset: false,
      isBundle: true,
      imported: true,
      isDirectory: false,
      visible: true,
      readonly: false,
      displayName: 'TestComp',
      source: 'assets/script/TestComp.ts',
      path: 'assets/script/TestComp.ts',
      name: 'TestComp',
      invalid: false,
      raw: {}
    }]);

    expect(result.scriptsByUuid.get('script-uuid')).toMatchObject({
      assetUuid: 'script-uuid',
      scriptPath: 'db://assets/script/TestComp.ts',
      filePath: 'E:/project/assets/script/TestComp.ts',
      available: true
    });
    expect(result.assets[0]).toMatchObject({
      isBundle: true,
      imported: true,
      isDirectory: false,
      visible: true,
      readonly: false,
      displayName: 'TestComp',
      source: 'assets/script/TestComp.ts',
      path: 'assets/script/TestComp.ts'
    });
    expect(result.scripts).toHaveLength(1);
  });

  it('同时识别 Scene 和 Prefab 文档资产', () => {
    const result = buildAssetIndex([
      {
        uuid: 'scene-uuid',
        url: 'db://assets/scenes/Lobby.scene',
        file: 'E:/project/assets/scenes/Lobby.scene',
        type: 'cc.SceneAsset',
        importer: 'scene',
        isSubAsset: false,
        name: 'Lobby',
        invalid: false,
        raw: {}
      },
      {
        uuid: 'prefab-uuid',
        url: 'db://assets/ui/Lobby.prefab',
        file: 'E:/project/assets/ui/Lobby.prefab',
        type: 'cc.Prefab',
        importer: 'prefab',
        isSubAsset: false,
        name: 'Lobby',
        invalid: false,
        raw: {}
      }
    ]);

    expect(result.documents).toEqual([
      expect.objectContaining({ assetUuid: 'scene-uuid', documentType: 'scene' }),
      expect.objectContaining({ assetUuid: 'prefab-uuid', documentType: 'prefab' })
    ]);
  });

  it('保留 Creator 内置资产，但不把 internal Scene 和 Prefab 加入项目文档候选', () => {
    const result = buildAssetIndex([
      {
        uuid: 'internal-scene-uuid',
        url: 'db://internal/default.scene',
        file: 'C:/Creator/resources/default.scene',
        type: 'cc.SceneAsset',
        importer: 'scene',
        readonly: true,
        invalid: false,
        raw: {}
      },
      {
        uuid: 'project-scene-uuid',
        url: 'db://assets/main.scene',
        file: 'E:/project/assets/main.scene',
        type: 'cc.SceneAsset',
        importer: 'scene',
        readonly: false,
        invalid: false,
        raw: {}
      }
    ]);

    expect(result.assets.map((asset) => asset.assetUuid)).toEqual([
      'internal-scene-uuid',
      'project-scene-uuid'
    ]);
    expect(result.documents).toEqual([
      expect.objectContaining({ assetUuid: 'project-scene-uuid', documentType: 'scene' })
    ]);
  });

  it('保留重复 UUID 和文档类型冲突，且序列化结果不泄漏 Map', () => {
    const result = buildAssetIndex([
      {
        uuid: 'duplicate-uuid',
        url: 'db://assets/ui/A.scene',
        file: 'E:/project/assets/ui/A.scene',
        type: 'cc.Prefab',
        importer: 'prefab',
        isSubAsset: false,
        name: 'A',
        invalid: false,
        raw: {}
      },
      {
        uuid: 'duplicate-uuid',
        url: 'db://assets/ui/B.prefab',
        file: 'E:/project/assets/ui/B.prefab',
        type: 'cc.Prefab',
        importer: 'prefab',
        isSubAsset: false,
        name: 'B',
        invalid: false,
        raw: {}
      }
    ]);

    expect(result.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'ASSET_DOCUMENT_TYPE_CONFLICT' }),
      expect.objectContaining({ reason: 'DUPLICATE_ASSET_UUID' })
    ]));
    expect(toSerializableAssetIndex(result)).not.toHaveProperty('assetsByUuid');
    expect(toSerializableAssetIndex(result)).not.toHaveProperty('scriptsByUuid');
  });
});
