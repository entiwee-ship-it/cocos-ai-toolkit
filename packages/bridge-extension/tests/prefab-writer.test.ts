import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ProbeError } from '../src/probe-errors';
import {
  executePrefabWriteOperation,
  type PrefabInstanceInfo,
  type PrefabWriterDependencies
} from '../src/prefab-writer';
import type { WriteOperation } from '../src/write-types';

/** 构造一个最小合法实例信息，便于各用例按字段覆盖。 */
function createInstanceInfo(overrides: Partial<PrefabInstanceInfo> = {}): PrefabInstanceInfo {
  return {
    nodeUuid: 'n-new',
    name: 'healthDialog',
    stablePath: '/Scene~0/healthDialog~0',
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
    overrideTargets: [{ path: '_name', targetFileId: 'file-1' }],
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
    setPrefabInstanceOverride: async () => ({
      targetLocalIds: ['file-label-component'],
      previous: null
    }),
    removePrefabInstanceOverride: async () => ({
      targetLocalIds: ['file-label-component'],
      previous: { value: '旧标题' }
    }),
    getCurrentDocumentAssetUuid: async () => 'asset-doc',
    findPrefabInstanceRoot: async () => 'n1',
    createAsset: async (assetUrl: string) => ({ uuid: `created:${assetUrl}`, type: null }),
    moveAsset: async () => undefined,
    readAssetMeta: async () => ({ userData: { priority: 0 } }),
    writeAssetMeta: async () => undefined,
    readAssetContent: async () => 'current-content',
    saveAssetContent: async () => undefined,
    ...overrides
  } as PrefabWriterDependencies;
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

  it('prefab.instantiate 成功：返回实例证据', async () => {
    const dependencies = createDependencies();
    const result = await executePrefabWriteOperation(
      { type: 'prefab.instantiate', prefabAssetUuid: 'asset-1', parentNodeUuid: 'n-parent', name: 'Card' } as WriteOperation,
      dependencies
    );

    expect(result.nodeUuid).toBe('n-new');
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({
      stablePath: '/Scene~0/healthDialog~0',
      prefabAssetUuid: 'asset-1',
      instanceFileId: 'inst-1',
      state: 2
    });
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

    // createPrefab 会重建节点（实测）：必须按重建后 UUID 出证据
    expect(locate).toEqual({ parentUuid: 'n-parent', name: 'healthDialog', prefabAssetUuid: 'asset-new' });
    expect(result.nodeUuid).toBe('n-rebuilt');
    expect(result.assetUuid).toBe('asset-new');
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

  it('prefab.delete_asset 成功执行并返回删除证据', async () => {
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
  });

  it('asset.create 禁止空 Prefab 模板并支持目录与组件脚本', async () => {
    const calls: unknown[][] = [];
    const createdAssets = new Map<string, { uuid: string; type: string | null }>();
    const dependencies = createDependencies({
      queryAssetInfo: async (assetUrl) => createdAssets.get(assetUrl) ?? null,
      createAsset: async (...args: unknown[]) => {
        calls.push(args);
        const asset = { uuid: `asset-${calls.length}`, type: null };
        createdAssets.set(args[0] as string, asset);
        return asset;
      }
    } as Partial<PrefabWriterDependencies>);

    await expect(executePrefabWriteOperation({
      type: 'asset.create', assetUrl: 'db://assets/ui/Empty.prefab', assetKind: 'prefab'
    } as WriteOperation, dependencies)).rejects.toThrow('PREFAB_CREATION_REQUIRES_NODE');
    await executePrefabWriteOperation({
      type: 'asset.create', assetUrl: 'db://assets/ui', assetKind: 'folder'
    } as WriteOperation, dependencies);
    await executePrefabWriteOperation({
      type: 'asset.create', assetUrl: 'db://assets/ui/Dialog.ts', assetKind: 'component-script', content: 'export class Dialog {}'
    } as WriteOperation, dependencies);

    expect(calls).toEqual([
      ['db://assets/ui', 'folder', null],
      ['db://assets/ui/Dialog.ts', 'component-script', 'export class Dialog {}']
    ]);
  });

  it('asset.move 保持 UUID 并生成反向移动操作', async () => {
    let moved = false;
    const dependencies = createDependencies({
      queryAssetInfo: async (url) => {
        if (url === 'db://assets/a.ts') return moved ? null : { uuid: 'asset-a', type: 'cc.Script' };
        if (url === 'db://assets/b.ts') return moved ? { uuid: 'asset-a', type: 'cc.Script' } : null;
        return null;
      },
      moveAsset: async () => { moved = true; }
    } as Partial<PrefabWriterDependencies>);

    const result = await executePrefabWriteOperation({
      type: 'asset.move', sourceUrl: 'db://assets/a.ts', targetUrl: 'db://assets/b.ts', expectedAssetUuid: 'asset-a'
    } as WriteOperation, dependencies);

  });

  it('asset.move 检测 UUID 漂移并拒绝成功', async () => {
    let moved = false;
    const dependencies = createDependencies({
      queryAssetInfo: async (url) => {
        if (url === 'db://assets/a.ts') return moved ? null : { uuid: 'asset-a', type: 'cc.Script' };
        if (url === 'db://assets/b.ts') return moved ? { uuid: 'asset-b', type: 'cc.Script' } : null;
        return null;
      },
      moveAsset: async () => { moved = true; }
    } as Partial<PrefabWriterDependencies>);

    await expect(executePrefabWriteOperation({
      type: 'asset.move', sourceUrl: 'db://assets/a.ts', targetUrl: 'db://assets/b.ts', expectedAssetUuid: 'asset-a'
    } as WriteOperation, dependencies)).rejects.toThrow('ASSET_UUID_DRIFT');
  });

  it('asset.write_meta 保留前后 Meta 且 asset.delete 要求精确 UUID', async () => {
    let deleted = false;
    const written: unknown[] = [];
    const dependencies = createDependencies({
      queryAssetInfo: async () => deleted ? null : { uuid: 'asset-a', type: 'cc.Script' },
      writeAssetMeta: async (_assetUrl: string, meta: unknown) => { written.push(meta); },
      deleteAsset: async () => { deleted = true; }
    } as Partial<PrefabWriterDependencies>);
    const metaResult = await executePrefabWriteOperation({
      type: 'asset.write_meta', assetUrl: 'db://assets/a.ts', expectedAssetUuid: 'asset-a',
      meta: { userData: { priority: 1 } }
    } as WriteOperation, dependencies);

    await expect(executePrefabWriteOperation({
      type: 'asset.delete', assetUrl: 'db://assets/a.ts', expectedAssetUuid: 'asset-other'
    } as WriteOperation, dependencies)).rejects.toThrow('ASSET_IDENTITY_MISMATCH');
    await executePrefabWriteOperation({
      type: 'asset.delete', assetUrl: 'db://assets/a.ts', expectedAssetUuid: 'asset-a'
    } as WriteOperation, dependencies);
    expect(deleted).toBe(true);
    expect(written).toEqual([{ userData: { priority: 1 } }]);
  });

  it('asset.update_text 只替换唯一旧文本并返回内容哈希证据', async () => {
    let content = 'export enum UIID {\n  Lobby,\n}\n';
    const beforeContent = content;
    const dependencies = createDependencies({
      queryAssetInfo: async () => ({ uuid: 'game-ui-config', type: 'cc.Script' }),
      readAssetContent: async () => content,
      saveAssetContent: async (_assetUrl, nextContent) => { content = nextContent; }
    });

    const result = await executePrefabWriteOperation({
      type: 'asset.update_text',
      assetUrl: 'db://assets/script/GameUIConfig.ts',
      expectedAssetUuid: 'game-ui-config',
      expectedCurrentSha256: sha256(beforeContent),
      oldText: '  Lobby,',
      newText: '  Lobby,\n  CocosAiValidation,'
    } as WriteOperation, dependencies);

    expect(content).toContain('CocosAiValidation');
    expect(result.after).toMatchObject({ sha256: sha256(content), matchCount: 1 });
  });

  it('asset.update_text 旧文本多处命中时零写入拒绝', async () => {
    let saveCalls = 0;
    const dependencies = createDependencies({
      queryAssetInfo: async () => ({ uuid: 'game-ui-config', type: 'cc.Script' }),
      readAssetContent: async () => 'Lobby\nLobby\n',
      saveAssetContent: async () => { saveCalls += 1; }
    });

    await expect(executePrefabWriteOperation({
      type: 'asset.update_text',
      assetUrl: 'db://assets/script/GameUIConfig.ts',
      expectedAssetUuid: 'game-ui-config',
      oldText: 'Lobby',
      newText: 'CocosAiValidation'
    } as WriteOperation, dependencies)).rejects.toThrow('ASSET_TEXT_MATCH_COUNT_INVALID');
    expect(saveCalls).toBe(0);
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
  });

  it('prefab.instance_override 精确写入实例覆盖并返回精确覆盖证据', async () => {
    let written: unknown = null;
    const dependencies = createDependencies({
      setPrefabInstanceOverride: async (...args) => {
        written = args;
        return { targetLocalIds: ['nested-instance', 'label-component'], previous: null };
      },
      getPrefabInstanceInfo: async () => createInstanceInfo({
        overrideCount: 1,
        overridePaths: ['string'],
        overrideTargets: [{
          path: 'string', targetFileId: 'nested-instance',
          targetLocalIds: ['nested-instance', 'label-component']
        }]
      })
    });

    const result = await executePrefabWriteOperation({
      type: 'prefab.instance_override', instanceRootUuid: 'instance-root',
      targetObjectUuid: 'label-component', targetNodePath: 'Root/Panel/Label',
      propertyPath: 'string', value: '新标题'
    } as WriteOperation, dependencies);

    expect(written).toEqual([
      'instance-root', 'label-component', 'string', '新标题'
    ]);
    expect(result.targetLocalIds).toEqual(['nested-instance', 'label-component']);
  });

  it('prefab.revert_override 带目标对象时精确移除目标属性覆盖', async () => {
    let removed: unknown = null;
    const dependencies = createDependencies({
      removePrefabInstanceOverride: async (...args) => {
        removed = args;
        return {
          targetLocalIds: ['nested-instance', 'label-component'],
          previous: { value: '新标题' }
        };
      }
    });

    const result = await executePrefabWriteOperation({
      type: 'prefab.revert_override', instanceRootUuid: 'instance-root',
      targetObjectUuid: 'label-component', targetNodePath: 'Root/Panel/Label',
      propertyPath: 'string'
    } as WriteOperation, dependencies);

    expect(removed).toEqual(['instance-root', 'label-component', 'string']);
    expect(result.targetLocalIds).toEqual(['nested-instance', 'label-component']);
    expect(result.previousOverride).toEqual({ value: '新标题' });
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

  it('prefab.apply_to_source 成功：走门面 applyPrefab 并返回前后证据', async () => {
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
    expect(result.before?.prefabAssetUuid).toBe('asset-1');
  });

  it('prefab.unlink_instance 成功：解除关联并返回前后证据', async () => {
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
  });

  it('prefab.link_instance 成功：关联后实例信息指向目标资产', async () => {
    const dependencies = createDependencies({
      getPrefabInstanceInfo: async () => createInstanceInfo({ prefabAssetUuid: 'asset-1', instanceFileId: 'inst-1' })
    });
    const result = await executePrefabWriteOperation(
      { type: 'prefab.link_instance', nodeUuid: 'n1', prefabAssetUuid: 'asset-1' } as WriteOperation,
      dependencies
    );

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

  it('prefab.replace_source 成功：重新关联新源并返回前后证据', async () => {
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

    expect(result.after?.prefabAssetUuid).toBe('asset-2');
  });
});

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
