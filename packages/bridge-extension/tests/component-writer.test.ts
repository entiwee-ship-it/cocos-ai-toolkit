import { describe, expect, it, vi } from 'vitest';
import { ProbeError } from '../src/probe-errors.js';
import {
  executeComponentWriteOperation,
  parsePropertyPath,
  type ComponentInfo,
  type ComponentWriterDependencies
} from '../src/component-writer.js';

describe('parsePropertyPath', () => {
  it('解析嵌套属性路径与数组下标', () => {
    expect(parsePropertyPath('items[2]')).toEqual(['items', 2]);
    expect(parsePropertyPath('settings.colors[0]')).toEqual(['settings', 'colors', 0]);
    expect(parsePropertyPath('clickEvents[0].handler')).toEqual(['clickEvents', 0, 'handler']);
    expect(parsePropertyPath('enabled')).toEqual(['enabled']);
  });

  it('拒绝非法路径', () => {
    expect(() => parsePropertyPath('')).toThrow('INVALID_PROPERTY_PATH');
    expect(() => parsePropertyPath('items[]')).toThrow('INVALID_PROPERTY_PATH');
    expect(() => parsePropertyPath('items[-1]')).toThrow('INVALID_PROPERTY_PATH');
  });
});

describe('component.add / remove / enable', () => {
  it('挂载内置组件并返回新组件 UUID', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      { type: 'component.add', nodeUuid: 'node-1', componentType: 'cc.Button', scriptUuid: null },
      dependencies
    );

    expect(result.componentUuid).toBe('comp-new-1');
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({ type: 'cc.Button', enabled: true });
    expect(result.inverse).toEqual([{ type: 'component.remove', componentUuid: 'comp-new-1' }]);
    expect(dependencies.calls).toContain('addComponent:node-1:cc.Button');
  });

  it('移除组件并保留 before 证据', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      { type: 'component.remove', componentUuid: 'comp-1' },
      dependencies
    );

    expect(result.before).toMatchObject({ type: 'cc.Label', enabled: true });
    expect(result.after).toBeNull();
    expect(result.inverse).toEqual([{
      type: 'component.add',
      nodeUuid: 'node-1',
      componentType: 'cc.Label',
      scriptUuid: null
    }]);
  });

  it('移除不存在的组件返回稳定错误码', async () => {
    const dependencies = createDependencies();
    await expect(executeComponentWriteOperation(
      { type: 'component.remove', componentUuid: 'missing' },
      dependencies
    )).rejects.toThrow('COMPONENT_NOT_FOUND');
  });

  it('component.enable 返回 before/after 和逆操作', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      { type: 'component.enable', componentUuid: 'comp-1', enabled: false },
      dependencies
    );

    expect(result.before).toMatchObject({ enabled: true });
    expect(result.after).toMatchObject({ enabled: false });
    expect(result.inverse).toEqual([{ type: 'component.enable', componentUuid: 'comp-1', enabled: true }]);
  });
});

describe('component.set_property', () => {
  it('写入嵌套数组路径并返回 before/after 证据', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'items[2]', value: 'c' },
      dependencies
    );

    expect(result.before).toMatchObject({ value: 'old-2' });
    expect(result.after).toMatchObject({ value: 'c' });
    expect(result.inverse).toEqual([{
      type: 'component.set_property',
      componentUuid: 'comp-1',
      propertyPath: 'items[2]',
      value: 'old-2'
    }]);
    expect(dependencies.calls).toContain('setComponentProperty:comp-1:items[2]:"c"');
  });

  it('写入深层嵌套对象路径', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'settings.colors[0]', value: '#fff' },
      dependencies
    );

    expect(result.before).toMatchObject({ value: '#000' });
    expect(result.after).toMatchObject({ value: '#fff' });
  });

  it('readonly 属性拒绝写入', async () => {
    const dependencies = createDependencies();
    await expect(executeComponentWriteOperation(
      { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'readonlyFlag', value: 1 },
      dependencies
    )).rejects.toThrow('PROPERTY_READONLY');
  });

  it('Schema 中不存在的属性拒绝写入', async () => {
    const dependencies = createDependencies();
    await expect(executeComponentWriteOperation(
      { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'unknownProp', value: 1 },
      dependencies
    )).rejects.toThrow('PROPERTY_NOT_FOUND');
  });

  it('expectedOldValue 不一致时按乐观锁拒绝', async () => {
    const dependencies = createDependencies();
    const error = await executeComponentWriteOperation(
      { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'items[0]', value: 'x', expectedOldValue: 'not-old-0' },
      dependencies
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProbeError);
    expect((error as ProbeError).code).toBe('PROPERTY_VALUE_CONFLICT');
    expect((error as ProbeError).details).toMatchObject({
      propertyPath: 'items[0]',
      expected: 'not-old-0',
      actual: 'old-0'
    });
    expect(dependencies.calls.some((call) => call.startsWith('setComponentProperty'))).toBe(false);
  });

  it('数组下标越界时拒绝写入', async () => {
    const dependencies = createDependencies();
    await expect(executeComponentWriteOperation(
      { type: 'component.set_property', componentUuid: 'comp-1', propertyPath: 'items[9]', value: 'x' },
      dependencies
    )).rejects.toThrow('ARRAY_INDEX_OUT_OF_BOUNDS');
  });
});

describe('component.set_reference / clear_reference', () => {
  it('按 ReferenceSchema 写入节点引用', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      {
        type: 'component.set_reference',
        componentUuid: 'comp-1',
        propertyPath: 'clickEvents[0].target',
        reference: { kind: 'node', objectUuid: 'node-9', fileId: null, nodePath: '/root/btn', available: true }
      },
      dependencies
    );

    expect(result.after).toMatchObject({ reference: { kind: 'node', objectUuid: 'node-9' } });
    expect(result.inverse).toEqual([{
      type: 'component.clear_reference',
      componentUuid: 'comp-1',
      propertyPath: 'clickEvents[0].target'
    }]);
  });

  it('失效引用（missing / unavailable）拒绝写入', async () => {
    const dependencies = createDependencies();
    await expect(executeComponentWriteOperation(
      {
        type: 'component.set_reference',
        componentUuid: 'comp-1',
        propertyPath: 'clickEvents[0].target',
        reference: { kind: 'missing', expectedKind: 'node', serializedUuid: 'node-9', serializedFileId: null, reason: 'NODE_REMOVED' }
      },
      dependencies
    )).rejects.toThrow('REFERENCE_NOT_AVAILABLE');

    await expect(executeComponentWriteOperation(
      {
        type: 'component.set_reference',
        componentUuid: 'comp-1',
        propertyPath: 'clickEvents[0].target',
        reference: { kind: 'node', objectUuid: 'node-9', fileId: null, nodePath: null, available: false }
      },
      dependencies
    )).rejects.toThrow('REFERENCE_NOT_AVAILABLE');
  });

  it('引用目标在编辑器中不可解析时拒绝写入', async () => {
    const dependencies = createDependencies({ resolvableReferences: false });
    await expect(executeComponentWriteOperation(
      {
        type: 'component.set_reference',
        componentUuid: 'comp-1',
        propertyPath: 'clickEvents[0].target',
        reference: { kind: 'asset', assetUuid: 'missing-asset', subAssetUuid: null, assetType: null, path: null, available: true }
      },
      dependencies
    )).rejects.toThrow('REFERENCE_TARGET_NOT_FOUND');
  });

  it('clear_reference 置空并保留旧引用作逆操作', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      { type: 'component.clear_reference', componentUuid: 'comp-2', propertyPath: 'spriteFrame' },
      dependencies
    );

    expect(result.before).toMatchObject({ reference: { kind: 'asset', assetUuid: 'asset-1' } });
    expect(result.after).toMatchObject({ reference: null });
    expect(result.inverse).toEqual([{
      type: 'component.set_reference',
      componentUuid: 'comp-2',
      propertyPath: 'spriteFrame',
      reference: { kind: 'asset', assetUuid: 'asset-1', subAssetUuid: null, assetType: 'cc.SpriteFrame', path: null, available: true }
    }]);
  });

  it('set_reference 逆操作按旧 Dump 引用归一化为 set_reference（阶段二回滚未干净复现修复）', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      {
        type: 'component.set_reference',
        componentUuid: 'comp-3',
        propertyPath: 'targetNode',
        reference: { kind: 'node', objectUuid: 'node-new', fileId: null, nodePath: null, available: true }
      },
      dependencies
    );

    // 旧值为 Dump 形态 { uuid: 'node-9' }：逆操作必须是 set_reference 的归一化引用，
    // 而不是阶段二的 set_property + 原始 Dump（运行时会把 {uuid} 当普通对象赋值，回滚后验证不通过）。
    expect(result.inverse).toEqual([{
      type: 'component.set_reference',
      componentUuid: 'comp-3',
      propertyPath: 'targetNode',
      reference: { kind: 'node', objectUuid: 'node-9', fileId: null, nodePath: null, available: true }
    }]);
  });

  it('set_reference 旧值为空或空引用时逆操作为 clear_reference', async () => {
    const dependencies = createDependencies();
    const nullCase = await executeComponentWriteOperation(
      {
        type: 'component.set_reference',
        componentUuid: 'comp-1',
        propertyPath: 'clickEvents[0].target',
        reference: { kind: 'node', objectUuid: 'node-9', fileId: null, nodePath: null, available: true }
      },
      dependencies
    );
    expect(nullCase.inverse).toEqual([{
      type: 'component.clear_reference',
      componentUuid: 'comp-1',
      propertyPath: 'clickEvents[0].target'
    }]);

    const emptyDumpCase = await executeComponentWriteOperation(
      {
        type: 'component.set_reference',
        componentUuid: 'comp-3',
        propertyPath: 'emptyRef',
        reference: { kind: 'node', objectUuid: 'node-new', fileId: null, nodePath: null, available: true }
      },
      dependencies
    );
    expect(emptyDumpCase.inverse).toEqual([{
      type: 'component.clear_reference',
      componentUuid: 'comp-3',
      propertyPath: 'emptyRef'
    }]);
  });
});

describe('component.resize_array', () => {
  it('扩容数组并返回新旧长度', async () => {
    const dependencies = createDependencies();
    const result = await executeComponentWriteOperation(
      { type: 'component.resize_array', componentUuid: 'comp-1', propertyPath: 'items', length: 5 },
      dependencies
    );

    expect(result.before).toMatchObject({ length: 3 });
    expect(result.after).toMatchObject({ length: 5 });
    expect(result.inverse).toEqual([{
      type: 'component.resize_array',
      componentUuid: 'comp-1',
      propertyPath: 'items',
      length: 3
    }]);
  });

  it('非数组属性拒绝 resize', async () => {
    const dependencies = createDependencies();
    await expect(executeComponentWriteOperation(
      { type: 'component.resize_array', componentUuid: 'comp-1', propertyPath: 'title', length: 2 },
      dependencies
    )).rejects.toThrow('PROPERTY_NOT_ARRAY');
  });
});

interface MockDependencies extends ComponentWriterDependencies {
  calls: string[];
}

function createDependencies(options: {
  resolvableReferences?: boolean;
} = {}): MockDependencies {
  const calls: string[] = [];
  const components = new Map<string, ComponentInfo>();
  components.set('comp-1', {
    uuid: 'comp-1',
    type: 'cc.Label',
    nodeUuid: 'node-1',
    enabled: true,
    properties: {
      items: ['old-0', 'old-1', 'old-2'],
      title: 'hello',
      readonlyFlag: false,
      settings: { colors: ['#000', '#111'] },
      clickEvents: [{ target: null, handler: '' }]
    },
    schema: [
      { propertyPath: 'items', declaredType: 'cc.String[]', readonly: false, isArray: true },
      { propertyPath: 'title', declaredType: 'cc.String', readonly: false, isArray: false },
      { propertyPath: 'readonlyFlag', declaredType: 'cc.Boolean', readonly: true, isArray: false },
      { propertyPath: 'settings', declaredType: 'cc.Object', readonly: false, isArray: false },
      { propertyPath: 'clickEvents', declaredType: 'cc.ClickEvent[]', readonly: false, isArray: true }
    ]
  });
  components.set('comp-2', {
    uuid: 'comp-2',
    type: 'cc.Sprite',
    nodeUuid: 'node-2',
    enabled: true,
    properties: {
      spriteFrame: { kind: 'asset', assetUuid: 'asset-1', subAssetUuid: null, assetType: 'cc.SpriteFrame', path: null, available: true }
    },
    schema: [
      { propertyPath: 'spriteFrame', declaredType: 'cc.SpriteFrame', readonly: false, isArray: false }
    ]
  });
  components.set('comp-3', {
    uuid: 'comp-3',
    type: 'Phase2Probe',
    nodeUuid: 'node-1',
    enabled: true,
    properties: {
      // 生产形态：引用旧值为 Creator Dump 形态（{uuid}），非归一化 ReferenceSchema。
      targetNode: { uuid: 'node-9' },
      emptyRef: { uuid: '' }
    },
    schema: [
      { propertyPath: 'targetNode', declaredType: 'cc.Node', readonly: false, isArray: false },
      { propertyPath: 'emptyRef', declaredType: 'cc.Node', readonly: false, isArray: false }
    ]
  });

  const readPath = (value: unknown, segments: Array<string | number>): unknown => {
    let current = value;
    for (const segment of segments) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string | number, unknown>)[segment];
    }
    return current;
  };

  const writePath = (container: Record<string, unknown>, segments: Array<string | number>, value: unknown): void => {
    let current: Record<string | number, unknown> = container;
    for (let index = 0; index < segments.length - 1; index += 1) {
      current = current[segments[index]] as Record<string | number, unknown>;
    }
    current[segments[segments.length - 1]] = value;
  };

  return {
    calls,
    getComponentInfo: async (componentUuid) => components.get(componentUuid) ?? null,
    nodeExists: async (nodeUuid) => nodeUuid === 'node-1' || nodeUuid === 'node-2',
    addComponent: async (nodeUuid, componentType) => {
      calls.push(`addComponent:${nodeUuid}:${componentType}`);
      const component: ComponentInfo = {
        uuid: 'comp-new-1',
        type: componentType,
        nodeUuid,
        enabled: true,
        properties: {},
        schema: []
      };
      components.set(component.uuid, component);
      return component.uuid;
    },
    removeComponent: async (componentUuid) => {
      calls.push(`removeComponent:${componentUuid}`);
      components.delete(componentUuid);
    },
    setComponentEnabled: async (componentUuid, enabled) => {
      calls.push(`setComponentEnabled:${componentUuid}:${enabled}`);
      const component = components.get(componentUuid);
      if (component) components.set(componentUuid, { ...component, enabled });
    },
    getComponentProperty: async (componentUuid, propertyPath) => {
      const component = components.get(componentUuid);
      if (!component) return undefined;
      return readPath(component.properties, parsePropertyPath(propertyPath));
    },
    setComponentProperty: async (componentUuid, propertyPath, value) => {
      calls.push(`setComponentProperty:${componentUuid}:${propertyPath}:${JSON.stringify(value)}`);
      const component = components.get(componentUuid);
      if (component) writePath(component.properties, parsePropertyPath(propertyPath), value);
    },
    resizeComponentArray: async (componentUuid, propertyPath, length) => {
      calls.push(`resizeComponentArray:${componentUuid}:${propertyPath}:${length}`);
      const component = components.get(componentUuid);
      if (!component) return;
      const current = readPath(component.properties, parsePropertyPath(propertyPath));
      if (Array.isArray(current)) {
        current.length = length;
      }
    },
    resolveReference: async (reference) => {
      calls.push(`resolveReference:${reference.kind}`);
      return options.resolvableReferences ?? true;
    }
  };
}
