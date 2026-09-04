import { describe, expect, it, vi } from 'vitest';
import {
  readRuntimeWriteClassAttributes,
  readRuntimeWriteObjectConstructor,
  resolveRuntimeWriteValue
} from '../src/runtime-write-value.js';

class VmData {
  mode = 0;
  target: unknown = null;
}

class TestVec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0
  ) {}
}

class NestedVmData {
  kind = 'slot';
  position = new TestVec3();
  target: unknown = null;
}

class TestEventHandler {
  target: unknown = null;
  component = '';
  handler = '';
  customEventData = '';
}

describe('resolveRuntimeWriteValue', () => {
  it('递归物化引用数组和嵌套 ccclass 对象并保留 Enum 数值', async () => {
    const current = [new VmData(), new VmData()];
    const value = [
      { mode: 2, target: { kind: 'node', objectUuid: 'node-a', fileId: null, nodePath: null, available: true } },
      { mode: 3, target: { kind: 'asset', assetUuid: 'texture-a', subAssetUuid: 'frame-a', assetType: 'cc.SpriteFrame', path: null, available: true } }
    ];

    const result = await resolveRuntimeWriteValue(value, current, 'items', {
      resolveReference: async (reference, propertyPath) => ({ reference, propertyPath })
    }) as VmData[];

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(VmData);
    expect(result[0]).toMatchObject({
      mode: 2,
      target: { reference: { kind: 'node', objectUuid: 'node-a' }, propertyPath: 'items[0].target' }
    });
    expect(result[1]).toMatchObject({
      mode: 3,
      target: { reference: { kind: 'asset', subAssetUuid: 'frame-a' }, propertyPath: 'items[1].target' }
    });
  });

  it('当前数组为空时按声明类型创建 ccclass 元素实例', async () => {
    const result = await resolveRuntimeWriteValue(
      [{ mode: 1, target: null }],
      [],
      'items',
      {
        resolveReference: async () => null,
        createObject: (_value, propertyPath) => propertyPath === 'items[0]' ? new VmData() : undefined
      }
    ) as VmData[];

    expect(result[0]).toBeInstanceOf(VmData);
    expect(result[0]).toMatchObject({ mode: 1, target: null });
  });

  it('嵌套数组新建 ccclass 时保留 Vec3 原型并解析节点引用', async () => {
    const targetNode = { uuid: 'node-a' };
    const resolvedPaths: string[] = [];

    const result = await resolveRuntimeWriteValue(
      [[{
        kind: 'slot',
        position: { x: 1, y: 2, z: 3 },
        target: {
          kind: 'node',
          objectUuid: 'node-a',
          fileId: null,
          nodePath: null,
          available: true
        }
      }]],
      [],
      'groups',
      {
        resolveReference: async (reference, propertyPath) => {
          if (reference.kind !== 'node') throw new Error(`UNEXPECTED_REFERENCE:${reference.kind}`);
          resolvedPaths.push(propertyPath);
          return targetNode;
        },
        createObject: (_value, propertyPath) => (
          propertyPath === 'groups[0][0]' ? new NestedVmData() : undefined
        ),
        resolveSpecialValue: (value, currentValue) => (
          currentValue instanceof TestVec3
            ? new TestVec3(value.x as number, value.y as number, value.z as number)
            : undefined
        )
      }
    ) as NestedVmData[][];

    expect(result[0][0]).toBeInstanceOf(NestedVmData);
    expect(result[0][0].position).toBeInstanceOf(TestVec3);
    expect(result[0][0].position).toEqual(new TestVec3(1, 2, 3));
    expect(result[0][0].target).toBe(targetNode);
    expect(resolvedPaths).toEqual(['groups[0][0].target']);
  });

  it('保留引用 kind 缺少必要字段时在赋值前拒绝', async () => {
    const resolveReference = vi.fn();

    await expect(resolveRuntimeWriteValue(
      { kind: 'node', objectUuid: 'node-a' },
      null,
      'items[0].target',
      { resolveReference }
    )).rejects.toThrow('REFERENCE_VALUE_INVALID');

    expect(resolveReference).not.toHaveBeenCalled();
  });

  it('空事件数组可物化 EventHandler 并解析 target 节点引用', async () => {
    const targetNode = { uuid: 'node-a' };
    const result = await resolveRuntimeWriteValue(
      [{
        target: {
          kind: 'node',
          objectUuid: 'node-a',
          fileId: null,
          nodePath: null,
          available: true
        },
        component: 'LobbyView',
        handler: 'onClickStart',
        customEventData: 'quick'
      }],
      [],
      'clickEvents',
      {
        resolveReference: async () => targetNode,
        createObject: (_value, propertyPath) => (
          propertyPath === 'clickEvents[0]' ? new TestEventHandler() : undefined
        )
      }
    ) as TestEventHandler[];

    expect(result[0]).toBeInstanceOf(TestEventHandler);
    expect(result[0]).toMatchObject({
      target: targetNode,
      component: 'LobbyView',
      handler: 'onClickStart',
      customEventData: 'quick'
    });
  });

  it('从 Creator Class Attr 的 ctor 字段读取 ccclass 构造器', () => {
    const attributes = {
      'items$_$type': 'Object',
      'items$_$ctor': VmData
    };

    expect(readRuntimeWriteObjectConstructor(attributes, 'items')).toBe(VmData);
  });

  it('从函数形式的 cclegacy.Class 读取属性元数据', () => {
    const attributes = { 'items$_$ctor': VmData };
    const classApi = Object.assign(function ClassApi() {}, {
      Attr: { getClassAttrs: () => attributes }
    });

    expect(readRuntimeWriteClassAttributes(classApi, class Owner {})).toBe(attributes);
  });
});
