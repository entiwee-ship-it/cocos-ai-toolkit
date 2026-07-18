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
    getCurrentDocumentAssetUuid: async () => 'asset-doc',
    findPrefabInstanceRoot: async () => 'n1',
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

  it('prefab.create_from_node 成功：按父节点+名称+源资产重定位实例根', async () => {
    let locate: { parentUuid: string | null; name: string; prefabAssetUuid: string } | null = null;
    const dependencies = createDependencies({
      queryAssetInfo: async () => null,
      findPrefabInstanceRoot: async (parentUuid, name, prefabAssetUuid) => {
        locate = { parentUuid, name, prefabAssetUuid };
        return 'n-rebuilt';
      }
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.create_from_node', nodeUuid: 'n1', assetUrl: 'db://assets/a.prefab' } as WriteOperation,
      dependencies
    );

    // createPrefab 会重建节点（实测）：必须按重建后 UUID 出证据和逆操作
    expect(locate).toEqual({ parentUuid: 'n-parent', name: 'healthDialog', prefabAssetUuid: 'asset-new' });
    expect(result.nodeUuid).toBe('n-rebuilt');
    expect(result.assetUuid).toBe('asset-new');
    expect(result.inverse).toEqual([
      { type: 'prefab.unlink_instance', instanceRootUuid: 'n-rebuilt' },
      { type: 'prefab.delete_asset', assetUrl: 'db://assets/a.prefab' }
    ]);
  });

  it('prefab.create_from_node 重建后无法重定位实例根时报错', async () => {
    const dependencies = createDependencies({
      queryAssetInfo: async () => null,
      findPrefabInstanceRoot: async () => null,
      relocatePollBudgetMs: 1
    });
    const error = await executePrefabWriteOperation(
      { type: 'prefab.create_from_node', nodeUuid: 'n1', assetUrl: 'db://assets/a.prefab' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_INSTANCE_NOT_ESTABLISHED');
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

  it('prefab.apply_to_source 非实例节点拒绝', async () => {
    const dependencies = createDependencies({
      getPrefabInstanceInfo: async () => createInstanceInfo({ instanceFileId: null, prefabAssetUuid: null })
    });
    const error = await executePrefabWriteOperation(
      { type: 'prefab.apply_to_source', instanceRootUuid: 'n1' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_INSTANCE_REQUIRED');
  });

  it('prefab.apply_to_source 成功：走门面 applyPrefab 且逆操作为空', async () => {
    let applied: string | null = null;
    const dependencies = createDependencies({
      applyPrefabInstance: async (uuid) => {
        applied = uuid;
      }
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.apply_to_source', instanceRootUuid: 'n1' } as WriteOperation,
      dependencies
    );

    expect(applied).toBe('n1');
    expect(result.inverse).toEqual([]);
    expect(result.before?.prefabAssetUuid).toBe('asset-1');
  });

  it('prefab.unlink_instance 成功：解除关联且逆操作为重新关联', async () => {
    let unlinked: string | null = null;
    const dependencies = createDependencies({
      unlinkPrefabInstance: async (uuid) => {
        unlinked = uuid;
      }
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.unlink_instance', instanceRootUuid: 'n1' } as WriteOperation,
      dependencies
    );

    expect(unlinked).toBe('n1');
    expect(result.inverse).toEqual([{ type: 'prefab.link_instance', nodeUuid: 'n1', prefabAssetUuid: 'asset-1' }]);
  });

  it('prefab.link_instance 成功：关联后实例信息指向目标资产', async () => {
    const dependencies = createDependencies({
      getPrefabInstanceInfo: async () => createInstanceInfo({ prefabAssetUuid: 'asset-1', instanceFileId: 'inst-1' })
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.link_instance', nodeUuid: 'n1', prefabAssetUuid: 'asset-1' } as WriteOperation,
      dependencies
    );

    expect(result.inverse).toEqual([{ type: 'prefab.unlink_instance', instanceRootUuid: 'n1' }]);
    expect(result.after?.prefabAssetUuid).toBe('asset-1');
  });

  it('prefab.link_instance 关联后实例信息未建立时报错', async () => {
    const dependencies = createDependencies({
      getPrefabInstanceInfo: async () => createInstanceInfo({ prefabAssetUuid: null, instanceFileId: null })
    });
    const error = await executePrefabWriteOperation(
      { type: 'prefab.link_instance', nodeUuid: 'n1', prefabAssetUuid: 'asset-1' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_LINK_NOT_ESTABLISHED');
  });

  it('prefab.replace_source 新源与当前源相同视为无效操作并拒绝', async () => {
    const dependencies = createDependencies();
    const error = await executePrefabWriteOperation(
      { type: 'prefab.replace_source', instanceRootUuid: 'n1', newPrefabAssetUuid: 'asset-1' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_REPLACE_NOOP');
  });

  it('prefab.replace_source 新源为当前文档自身时拒绝（防自嵌套循环）', async () => {
    const dependencies = createDependencies({
      getCurrentDocumentAssetUuid: async () => 'asset-doc'
    });
    const error = await executePrefabWriteOperation(
      { type: 'prefab.replace_source', instanceRootUuid: 'n1', newPrefabAssetUuid: 'asset-doc' } as WriteOperation,
      dependencies
    ).catch((caught: unknown) => caught);

    expect((error as ProbeError).code).toBe('PREFAB_CYCLE');
  });

  it('prefab.replace_source 成功：重新关联新源且逆操作为关联旧源', async () => {
    let infoCalls = 0;
    const dependencies = createDependencies({
      getCurrentDocumentAssetUuid: async () => 'asset-doc',
      queryAssetInfo: async () => ({ uuid: 'asset-2', type: 'cc.Prefab' }),
      getPrefabInstanceInfo: async () => {
        infoCalls += 1;
        // 首次为替换前（旧源 asset-1），之后为替换后（新源 asset-2）
        return createInstanceInfo(infoCalls === 1
          ? { prefabAssetUuid: 'asset-1', instanceFileId: 'inst-old' }
          : { prefabAssetUuid: 'asset-2', instanceFileId: 'inst-new' });
      }
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.replace_source', instanceRootUuid: 'n1', newPrefabAssetUuid: 'asset-2' } as WriteOperation,
      dependencies
    );

    expect(result.inverse).toEqual([{ type: 'prefab.replace_source', instanceRootUuid: 'n1', newPrefabAssetUuid: 'asset-1' }]);
    expect(result.after?.prefabAssetUuid).toBe('asset-2');
  });
});
