import { describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../src/probe-errors.js';
import {
  executeComponentWriteOperation,
  type ComponentWriterDependencies,
  type ScriptMountGuardDependencies
} from '../src/component-writer.js';

describe('自定义脚本挂载守卫', () => {
  it('拒绝挂载未注册的脚本类，不产生 MissingScript', async () => {
    const addComponent = vi.fn(async () => 'comp-new-1');
    const dependencies = createDependencies({
      guard: {
        scriptAssetExists: async () => true,
        isScriptClassRegistered: async () => false,
        waitForScriptCompilation: async () => null,
        isComponentSchemaAvailable: async () => true
      },
      addComponent
    });

    await expect(executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'MyScript', scriptUuid: 'script-uuid-1' },
      dependencies
    )).rejects.toThrow('SCRIPT_CLASS_NOT_REGISTERED');
    expect(addComponent).not.toHaveBeenCalled();
  });

  it('脚本刚变更时等待编译和类注册完成再挂载，不靠固定延时', async () => {
    const order: string[] = [];
    let registered = false;
    const dependencies = createDependencies({
      guard: {
        scriptAssetExists: async () => true,
        isScriptClassRegistered: async () => {
          order.push('check-registered');
          return registered;
        },
        waitForScriptCompilation: async () => {
          order.push('wait-compilation');
          registered = true;
          return { success: true, diagnostics: [] };
        },
        isComponentSchemaAvailable: async () => true
      },
      addComponent: async () => {
        order.push('add-component');
        return 'comp-new-1';
      }
    });

    const result = await executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'MyScript', scriptUuid: 'script-uuid-1' },
      dependencies
    );

    expect(result.componentUuid).toBe('comp-new-1');
    expect(order).toEqual(['check-registered', 'wait-compilation', 'check-registered', 'add-component']);
  });

  it('编译失败返回完整诊断且不挂载，事务按策略回滚', async () => {
    const addComponent = vi.fn(async () => 'comp-new-1');
    const dependencies = createDependencies({
      guard: {
        scriptAssetExists: async () => true,
        isScriptClassRegistered: async () => false,
        waitForScriptCompilation: async () => ({
          success: false,
          diagnostics: ['assets/scripts/MyScript.ts(3,5): error TS2322: Type string is not assignable to type number.']
        }),
        isComponentSchemaAvailable: async () => true
      },
      addComponent
    });

    const error = await executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'MyScript', scriptUuid: 'script-uuid-1' },
      dependencies
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProbeError);
    expect((error as ProbeError).code).toBe('SCRIPT_COMPILATION_FAILED');
    expect((error as ProbeError).details.diagnostics).toEqual([
      'assets/scripts/MyScript.ts(3,5): error TS2322: Type string is not assignable to type number.'
    ]);
    expect(addComponent).not.toHaveBeenCalled();
  });

  it('scriptUuid 不在资产索引时拒绝挂载', async () => {
    const addComponent = vi.fn(async () => 'comp-new-1');
    const dependencies = createDependencies({
      guard: {
        scriptAssetExists: async () => false,
        isScriptClassRegistered: async () => true,
        waitForScriptCompilation: async () => null,
        isComponentSchemaAvailable: async () => true
      },
      addComponent
    });

    await expect(executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'MyScript', scriptUuid: 'missing-script' },
      dependencies
    )).rejects.toThrow('SCRIPT_ASSET_NOT_FOUND');
    expect(addComponent).not.toHaveBeenCalled();
  });

  it('Phase 1 组件 Schema 不可取时拒绝挂载', async () => {
    const addComponent = vi.fn(async () => 'comp-new-1');
    const dependencies = createDependencies({
      guard: {
        scriptAssetExists: async () => true,
        isScriptClassRegistered: async () => true,
        waitForScriptCompilation: async () => null,
        isComponentSchemaAvailable: async () => false
      },
      addComponent
    });

    await expect(executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'MyScript', scriptUuid: 'script-uuid-1' },
      dependencies
    )).rejects.toThrow('SCRIPT_SCHEMA_UNAVAILABLE');
    expect(addComponent).not.toHaveBeenCalled();
  });

  it('自定义脚本未配置守卫时拒绝挂载，不允许绕过', async () => {
    const addComponent = vi.fn(async () => 'comp-new-1');
    const dependencies = createDependencies({ addComponent });

    await expect(executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'MyScript', scriptUuid: 'script-uuid-1' },
      dependencies
    )).rejects.toThrow('SCRIPT_MOUNT_GUARD_UNAVAILABLE');
    expect(addComponent).not.toHaveBeenCalled();
  });

  it('内置组件（scriptUuid 为 null）跳过守卫直接挂载', async () => {
    const guard = {
      scriptAssetExists: vi.fn(async () => true),
      isScriptClassRegistered: vi.fn(async () => true),
      waitForScriptCompilation: vi.fn(async () => null),
      isComponentSchemaAvailable: vi.fn(async () => true)
    };
    const dependencies = createDependencies({ guard });

    const result = await executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'cc.Button', scriptUuid: null },
      dependencies
    );

    expect(result.componentUuid).toBe('comp-new-1');
    expect(guard.scriptAssetExists).not.toHaveBeenCalled();
    expect(guard.isScriptClassRegistered).not.toHaveBeenCalled();
  });
});

function createDependencies(options: {
  guard?: ScriptMountGuardDependencies;
  addComponent?: (nodeUuid: string, componentType: string, scriptUuid: string | null) => Promise<string>;
} = {}): ComponentWriterDependencies {
  return {
    getComponentInfo: async (componentUuid) => componentUuid === 'comp-new-1'
      ? {
          uuid: 'comp-new-1',
          type: 'MyScript',
          nodeUuid: 'node-1',
          enabled: true,
          scriptUuid: 'script-uuid-1',
          properties: {},
          schema: []
        }
      : null,
    nodeExists: async () => true,
    addComponent: options.addComponent ?? (async () => 'comp-new-1'),
    removeComponent: async () => {},
    setComponentEnabled: async () => {},
    getComponentProperty: async () => undefined,
    setComponentProperty: async () => {},
    resizeComponentArray: async () => {},
    resolveReference: async () => true,
    scriptGuard: options.guard
  };
}
