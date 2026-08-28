import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAssetIndex,
  invalidateAssetIndexCache,
  probeAssetIndex,
  probeAssetSearch,
  toSerializableAssetIndex
} from '../src/asset-index';
import {
  AssetRecordSchema,
  DocumentAssetRecordSchema,
  ScriptAssetRecordSchema
} from '../../protocol/src/asset';

const originalEditorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Editor');

afterEach(() => {
  invalidateAssetIndexCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalEditorDescriptor) {
    Object.defineProperty(globalThis, 'Editor', originalEditorDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, 'Editor');
});

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

  it('默认序列化省略重复 raw，显式 includeRaw 才返回完整诊断', () => {
    const result = buildAssetIndex([{
      uuid: 'prefab-uuid',
      url: 'db://assets/ui/Test.prefab',
      file: 'E:/project/assets/ui/Test.prefab',
      type: 'cc.Prefab',
      importer: 'prefab',
      invalid: false,
      raw: { uuid: 'prefab-uuid', extra: 'diagnostic' }
    }]);

    const compact = toSerializableAssetIndex(result);
    expect(compact.assets[0]).not.toHaveProperty('raw');
    expect(compact.documents[0]).not.toHaveProperty('raw');
    expect(() => AssetRecordSchema.parse(compact.assets[0])).not.toThrow();
    expect(() => DocumentAssetRecordSchema.parse(compact.documents[0])).not.toThrow();
    expect(() => ScriptAssetRecordSchema.parse({
      assetUuid: 'script-uuid',
      scriptPath: 'db://assets/script/Test.ts',
      filePath: 'E:/project/assets/script/Test.ts',
      classNames: [],
      available: true
    })).not.toThrow();
    expect(toSerializableAssetIndex(result, true)).toMatchObject({
      assets: [{ raw: { uuid: 'prefab-uuid', extra: 'diagnostic' } }],
      documents: [{ raw: { uuid: 'prefab-uuid', extra: 'diagnostic' } }]
    });
  });

  it('Bridge 搜索保持大小写无关的包含匹配与稳定排序，只返回命中资产', async () => {
    installEditorAssets([
      {
        uuid: 'script-uuid',
        url: 'db://assets/script/UserInfoView.ts',
        file: 'E:/project/assets/script/UserInfoView.ts',
        type: 'cc.Script',
        importer: 'typescript',
        name: 'UserInfoView',
        invalid: false,
        internalOnly: 'hidden'
      },
      {
        uuid: 'prefab-uuid',
        url: 'db://assets/ui/UserInfoView.prefab',
        file: 'E:/project/assets/ui/UserInfoView.prefab',
        type: 'cc.Prefab',
        importer: 'prefab',
        displayName: 'UserInfoView',
        invalid: false
      },
      {
        uuid: 'other-uuid',
        url: 'db://assets/ui/Other.prefab',
        type: 'cc.Prefab',
        invalid: false
      }
    ]);

    const firstPage = await probeAssetSearch({ pattern: '  userinfoview  ', offset: 0, pageSize: 1 });
    const secondPage = await probeAssetSearch({ pattern: '  userinfoview  ', offset: 1, pageSize: 1 });

    expect(firstPage).toMatchObject({ total: 2, assets: [{ assetUuid: 'script-uuid' }] });
    expect(secondPage).toMatchObject({ total: 2, assets: [{ assetUuid: 'prefab-uuid' }] });
    expect(firstPage.assets.every((asset) => !('raw' in asset))).toBe(true);
    expect(firstPage.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(secondPage.revision).toBe(firstPage.revision);
  });

  it('影响搜索或返回内容的字段变化会更新 cursor revision', async () => {
    const assets = [{
      uuid: 'prefab-uuid',
      url: 'db://assets/ui/Test.prefab',
      type: 'cc.Prefab',
      importer: 'prefab',
      name: 'Before',
      invalid: false
    }];
    installEditorAssets(assets);
    const before = await probeAssetSearch({ pattern: 'before' });

    assets[0].name = 'After';
    invalidateAssetIndexCache();
    const after = await probeAssetSearch({ pattern: 'after' });

    expect(after.revision).not.toBe(before.revision);
  });

  it('短 TTL 内共享一次全量查询，失效后重新读取 AssetDB', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const request = installEditorAssets([{
      uuid: 'prefab-uuid',
      url: 'db://assets/ui/Test.prefab',
      type: 'cc.Prefab',
      importer: 'prefab',
      invalid: false
    }]);

    await Promise.all([probeAssetIndex(), probeAssetIndex(), probeAssetSearch({ pattern: 'test' })]);
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(4_999);
    await probeAssetIndex();
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(5_001);
    await probeAssetIndex();
    expect(request).toHaveBeenCalledTimes(2);

    invalidateAssetIndexCache();
    await probeAssetIndex();
    expect(request).toHaveBeenCalledTimes(3);
  });
});

function installEditorAssets(assets: Array<Record<string, unknown>>) {
  const request = vi.fn(async () => assets);
  Object.defineProperty(globalThis, 'Editor', {
    configurable: true,
    value: { Message: { request } }
  });
  return request;
}
