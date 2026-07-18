import { describe, expect, it } from 'vitest';
import { ProbeError } from '../src/probe-errors';
import {
  executePrefabWriteOperation,
  type PrefabInstanceInfo,
  type PrefabWriterDependencies
} from '../src/prefab-writer';
import type { WriteOperation } from '../src/transaction-manager';

/** 构造一个最小合法实例信息，便于各用例按字段覆盖。 */
function createInstanceInfo(overrides: Partial<PrefabInstanceInfo> = {}): PrefabInstanceInfo {
  return {
    nodeUuid: 'n-new',
    name: 'healthDialog',
    prefabAssetUuid: 'asset-1',
    sourceObjectFileId: 'file-1',
    instanceFileId: 'inst-1',
    state: 2,
    isApplicable: true,
    isRevertable: true,
    isUnwrappable: true,
    parentUuid: 'n-parent',
    childCount: 5,
    overrideCount: 1,
    overridePaths: ['_name'],
    ...overrides
  };
}

/** 构造全部默认成功的预制体写依赖，单测按需覆盖。 */
function createDependencies(overrides: Partial<PrefabWriterDependencies> = {}): PrefabWriterDependencies {
  return {
    getPrefabInstanceInfo: async () => createInstanceInfo(),
    queryAssetInfo: async () => ({ uuid: 'asset-1', type: 'cc.Prefab' }),
    instantiatePrefab: async () => 'n-new',
    createPrefabFromNode: async () => 'asset-new',
    deleteAsset: async () => undefined,
    revertPrefabInstance: async () => undefined,
    applyPrefabInstance: async () => undefined,
    unlinkPrefabInstance: async () => undefined,
    linkPrefabInstance: async () => undefined,
    resetNodeProperty: async () => undefined,
    ...overrides
  };
}

describe('executePrefabWriteOperation', () => {
  it('prefab.instantiate 资产不存在时拒绝且不创建节点', async () => {
    let instantiateCalled = 0;
    const dependencies = createDependencies({
      queryAssetInfo: async () => null,
      instantiatePrefab: async () => {
        instantiateCalled += 1;
        return 'n-new';
      }
    });

    const error = await executePrefabWriteOperation(
      { type: 'prefab.instantiate', prefabAssetUuid: 'missing', parentNodeUuid: 'n-parent' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProbeError);
    expect((error as ProbeError).code).toBe('PREFAB_ASSET_NOT_FOUND');
    expect(instantiateCalled).toBe(0);
  });

  it('prefab.instantiate 资产类型非预制体时拒绝', async () => {
    const dependencies = createDependencies({
      queryAssetInfo: async () => ({ uuid: 'asset-1', type: 'cc.ImageAsset' })
    });

    const error = await executePrefabWriteOperation(
      { type: 'prefab.instantiate', prefabAssetUuid: 'asset-1', parentNodeUuid: 'n-parent' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_ASSET_TYPE_MISMATCH');
  });

  it('prefab.instantiate 父节点不存在时拒绝', async () => {
    const dependencies = createDependencies({
      getPrefabInstanceInfo: async () => null
    });

    const error = await executePrefabWriteOperation(
      { type: 'prefab.instantiate', prefabAssetUuid: 'asset-1', parentNodeUuid: 'n-missing' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('NODE_NOT_FOUND');
  });

  it('prefab.instantiate 成功：返回实例证据与 node.delete 逆操作', async () => {
    const dependencies = createDependencies();
    const result = await executePrefabWriteOperation(
      { type: 'prefab.instantiate', prefabAssetUuid: 'asset-1', parentNodeUuid: 'n-parent', name: 'Card' } as WriteOperation,
      dependencies
    );

    expect(result.nodeUuid).toBe('n-new');
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({ prefabAssetUuid: 'asset-1', instanceFileId: 'inst-1', state: 2 });
    expect(result.inverse).toEqual([{ type: 'node.delete', nodeUuid: 'n-new' }]);
  });

  it('prefab.instantiate 实例信息未建立（缺 instanceFileId）时报错', async () => {
    const dependencies = createDependencies({
      getPrefabInstanceInfo: async () => createInstanceInfo({ instanceFileId: null })
    });

    const error = await executePrefabWriteOperation(
      { type: 'prefab.instantiate', prefabAssetUuid: 'asset-1', parentNodeUuid: 'n-parent' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_INSTANCE_NOT_ESTABLISHED');
  });

  it('prefab.create_from_node 目标路径已存在时拒绝（防覆盖弹窗）', async () => {
    let createCalled = 0;
    const dependencies = createDependencies({
      queryAssetInfo: async () => ({ uuid: 'existing', type: 'cc.Prefab' }),
      createPrefabFromNode: async () => {
        createCalled += 1;
        return 'asset-new';
      }
    });

    const error = await executePrefabWriteOperation(
      { type: 'prefab.create_from_node', nodeUuid: 'n1', assetUrl: 'db://assets/a.prefab' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('ASSET_ALREADY_EXISTS');
    expect(createCalled).toBe(0);
  });

  it('prefab.create_from_node 成功：返回资产证据与 unlink+delete_asset 逆操作', async () => {
    const dependencies = createDependencies({
      queryAssetInfo: async () => null
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.create_from_node', nodeUuid: 'n1', assetUrl: 'db://assets/a.prefab' } as WriteOperation,
      dependencies
    );

    expect(result.assetUuid).toBe('asset-new');
    expect(result.inverse).toEqual([
      { type: 'prefab.unlink_instance', instanceRootUuid: 'n1' },
      { type: 'prefab.delete_asset', assetUrl: 'db://assets/a.prefab' }
    ]);
  });

  it('prefab.delete_asset 成功执行且无逆操作', async () => {
    let deleted: string | null = null;
    const dependencies = createDependencies({
      deleteAsset: async (assetUrl) => {
        deleted = assetUrl;
      }
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.delete_asset', assetUrl: 'db://assets/a.prefab' } as WriteOperation,
      dependencies
    );

    expect(deleted).toBe('db://assets/a.prefab');
    expect(result.inverse).toEqual([]);
  });

  it('prefab.revert_override 非实例节点拒绝', async () => {
    const dependencies = createDependencies({
      getPrefabInstanceInfo: async () => createInstanceInfo({ instanceFileId: null, prefabAssetUuid: null })
    });
    const error = await executePrefabWriteOperation(
      { type: 'prefab.revert_override', instanceRootUuid: 'n1' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_INSTANCE_REQUIRED');
  });

  it('prefab.revert_override 整实例还原走 restorePrefab', async () => {
    let reverted: string | null = null;
    const dependencies = createDependencies({
      revertPrefabInstance: async (uuid) => {
        reverted = uuid;
      },
      getPrefabInstanceInfo: async () => createInstanceInfo({ overrideCount: 1, overridePaths: ['_name'] })
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.revert_override', instanceRootUuid: 'n1' } as WriteOperation,
      dependencies
    );

    expect(reverted).toBe('n1');
    expect(result.inverse).toEqual([]);
    expect(result.before?.overrideCount).toBe(1);
  });

  it('prefab.revert_override 指定属性路径走 resetProperty 单属性还原', async () => {
    let reset: { uuid: string; path: string } | null = null;
    const dependencies = createDependencies({
      resetNodeProperty: async (uuid, path) => {
        reset = { uuid, path };
      }
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.revert_override', instanceRootUuid: 'n1', propertyPath: 'position' } as WriteOperation,
      dependencies
    );

    expect(reset).toEqual({ uuid: 'n1', path: 'position' });
    expect(result.inverse).toEqual([]);
  });

  it('未实现的 prefab 操作返回稳定错误码', async () => {
    const error = await executePrefabWriteOperation(
      { type: 'prefab.apply_to_source', instanceRootUuid: 'n1' } as WriteOperation,
      createDependencies()
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('INVALID_WRITE_OPERATION');
  });
});
