import Module from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestPropertyOverride {
  targetInfo: TestTargetInfo | null;
  propertyPath: string[];
  value: unknown;
  isTarget(localIds: string[], propertyPath: string[]): boolean;
}

class TestTargetInfo {
  localID: string[] = [];
}

class TestPropertyOverrideInfo implements TestPropertyOverride {
  targetInfo: TestTargetInfo | null = null;
  propertyPath: string[] = [];
  value: unknown;

  isTarget(localIds: string[], propertyPath: string[]): boolean {
    return arraysEqual(this.targetInfo?.localID ?? [], localIds)
      && arraysEqual(this.propertyPath, propertyPath);
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

describe('write-creator-deps Creator 3.8.8 Prefab Override 兼容', () => {
  const targetNode = {
    uuid: 'target-node',
    name: 'Label',
    string: 'Source',
    children: [],
    _components: []
  };
  const instance = {
    propertyOverrides: [] as TestPropertyOverride[],
    targetMap: { 'target-file-id': targetNode },
    findPropertyOverride(localIds: string[], propertyPath: string[]) {
      return this.propertyOverrides.find((entry) => entry.isTarget(localIds, propertyPath)) ?? null;
    },
    removePropertyOverride(localIds: string[], propertyPath: string[]) {
      const index = this.propertyOverrides.findIndex((entry) => entry.isTarget(localIds, propertyPath));
      if (index >= 0) this.propertyOverrides.splice(index, 1);
    }
  };
  const instanceRoot = {
    uuid: 'instance-root',
    name: 'OverrideFixture',
    prefab: { instance },
    children: [targetNode],
    _components: []
  };
  const scene = {
    uuid: 'scene-root',
    name: 'Scene',
    children: [instanceRoot],
    _components: []
  };
  const generateTargetMap = vi.fn();
  class TestPrefab {}
  Object.defineProperty(TestPrefab, '_utils', {
    value: {
      TargetInfo: TestTargetInfo,
      PropertyOverrideInfo: TestPropertyOverrideInfo,
      generateTargetMap
    }
  });

  let buildPrefabWriterDependencies: typeof import('../src/write-creator-deps').buildPrefabWriterDependencies;
  let buildWriteVerifierDependencies: typeof import('../src/write-creator-deps').buildWriteVerifierDependencies;
  const originalEditor = (globalThis as Record<string, unknown>).Editor;
  const originalCce = (globalThis as Record<string, unknown>).cce;
  const resetOrder: string[] = [];
  const editorRequest = vi.fn();
  const resetProperty = vi.fn(async () => {
    resetOrder.push('reset');
    targetNode.string = instance.propertyOverrides.length === 0 ? 'Source' : 'Override Applied';
  });
  const softReloadScene = vi.fn(async () => true);

  beforeAll(async () => {
    const moduleWithLoad = Module as unknown as {
      _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const originalLoad = moduleWithLoad._load;
    moduleWithLoad._load = function patchedLoad(request, parent, isMain) {
      if (request === 'cc') {
        return {
          director: { getScene: () => scene },
          js: { getClassByName: () => null },
          instantiate: (value: unknown) => value,
          Prefab: TestPrefab
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    (globalThis as Record<string, unknown>).Editor = {
      Selection: { select: vi.fn() },
      log: vi.fn(),
      Message: { request: editorRequest }
    };
    (globalThis as Record<string, unknown>).cce = {
      Node: { resetProperty },
      SceneFacadeManager: { softReloadScene }
    };
    try {
      ({ buildPrefabWriterDependencies, buildWriteVerifierDependencies } = await import('../src/write-creator-deps'));
    } finally {
      moduleWithLoad._load = originalLoad;
    }
  });

  afterAll(() => {
    if (originalEditor === undefined) {
      delete (globalThis as Record<string, unknown>).Editor;
    } else {
      (globalThis as Record<string, unknown>).Editor = originalEditor;
    }
    if (originalCce === undefined) {
      delete (globalThis as Record<string, unknown>).cce;
    } else {
      (globalThis as Record<string, unknown>).cce = originalCce;
    }
  });

  beforeEach(() => {
    instance.propertyOverrides.length = 0;
    targetNode.string = 'Source';
    resetOrder.length = 0;
    resetProperty.mockClear();
    softReloadScene.mockClear();
    editorRequest.mockReset();
  });

  it('实例化 Prefab 必须向 scene/create-node 传递 cc.Prefab 类型', async () => {
    editorRequest.mockResolvedValueOnce('created-prefab-node');
    const dependencies = buildPrefabWriterDependencies();

    const nodeUuid = await dependencies.instantiatePrefab(
      'parent-node',
      'prefab-asset',
      'Avatar'
    );

    expect(nodeUuid).toBe('created-prefab-node');
    expect(editorRequest).toHaveBeenCalledWith('scene', 'create-node', {
      parent: 'parent-node',
      assetUuid: 'prefab-asset',
      name: 'Avatar',
      type: 'cc.Prefab'
    });
  });

  it('Prefab 是 class 时仍从静态 _utils 创建并回查新的属性覆盖', async () => {
    const dependencies = buildPrefabWriterDependencies();

    await dependencies.setPrefabInstanceOverride(
      'instance-root',
      'target-node',
      'string',
      'Override Applied'
    );

    expect(targetNode.string).toBe('Override Applied');
    expect(instance.propertyOverrides).toHaveLength(1);
    expect(instance.propertyOverrides[0]).toBeInstanceOf(TestPropertyOverrideInfo);
    expect(instance.propertyOverrides[0].targetInfo).toBeInstanceOf(TestTargetInfo);
    expect(instance.propertyOverrides[0].targetInfo?.localID).toEqual(['target-file-id']);
    expect(instance.findPropertyOverride(['target-file-id'], ['string']))
      .toBe(instance.propertyOverrides[0]);
    expect(generateTargetMap).not.toHaveBeenCalled();
  });

  it('精确还原只删除 Override，不调用会写入组件默认值的 Node.resetProperty', async () => {
    const override = new TestPropertyOverrideInfo();
    const targetInfo = new TestTargetInfo();
    targetInfo.localID = ['target-file-id'];
    override.targetInfo = targetInfo;
    override.propertyPath = ['string'];
    override.value = 'Override Applied';
    instance.propertyOverrides.push(override);
    targetNode.string = 'Override Applied';
    const originalRemove = instance.removePropertyOverride.bind(instance);
    instance.removePropertyOverride = (localIds, propertyPath) => {
      resetOrder.push('remove');
      originalRemove(localIds, propertyPath);
    };

    const dependencies = buildPrefabWriterDependencies();
    await dependencies.removePrefabInstanceOverride(
      'instance-root',
      'target-node',
      'string'
    );

    expect(resetOrder).toEqual(['remove']);
    expect(resetProperty).not.toHaveBeenCalled();
    expect(targetNode.string).toBe('Override Applied');
    expect(instance.propertyOverrides).toHaveLength(0);
  });

  it('文档重载调用 Creator SceneFacadeManager.softReloadScene', async () => {
    const dependencies = buildWriteVerifierDependencies();

    await dependencies.reloadDocument();

    expect(softReloadScene).toHaveBeenCalledTimes(1);
  });
});
