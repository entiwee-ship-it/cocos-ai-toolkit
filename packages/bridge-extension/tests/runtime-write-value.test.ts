import { describe, expect, it } from 'vitest';
import {
  readRuntimeWriteClassAttributes,
  readRuntimeWriteObjectConstructor,
  resolveRuntimeWriteValue
} from '../src/runtime-write-value.js';

class VmData {
  mode = 0;
  target: unknown = null;
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

  it('从 Creator Class Attr 的 ctor 字段读取 ccclass 构造器', () => {
    const attributes = {
      'items$_$type': 'Object',
      'items$_$ctor': VmData
    };

    expect(readRuntimeWriteObjectConstructor(attributes, 'items')).toBe(VmData);
  });

  it('从函数形式的 cclegacy.Class 读取属性元数据', () => {
    const attributes = { 'items$_$ctor': VmData };
    const legacyClass = Object.assign(function LegacyClass() {}, {
      Attr: { getClassAttrs: () => attributes }
    });

    expect(readRuntimeWriteClassAttributes(legacyClass, class Owner {})).toBe(attributes);
  });
});
