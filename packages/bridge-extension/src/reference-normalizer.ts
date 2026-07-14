import { readDumpValue, readObject } from './raw-reflection';

export type NormalizedReference =
  | {
      kind: 'node';
      objectUuid: string | null;
      fileId: string | null;
      nodePath: string | null;
      available: boolean;
    }
  | {
      kind: 'component';
      objectUuid: string | null;
      fileId: string | null;
      typeId: string | null;
      nodePath: string | null;
      available: boolean;
    }
  | {
      kind: 'asset';
      assetUuid: string;
      subAssetUuid: string | null;
      assetType: string | null;
      path: string | null;
      available: boolean;
    }
  | {
      kind: 'missing';
      expectedKind: 'node' | 'component' | 'asset' | 'unknown';
      serializedUuid: string | null;
      serializedFileId: string | null;
      reason: string;
    };

/**
 * 从 Creator Dump 属性中递归提取 Node、Component、Asset 和失效引用。
 *
 * @param value 单个属性 Dump 或嵌套属性结构。
 * @returns 按序保留的结构化引用；数组中的重复引用不会被合并。
 */
export function normalizeSerializedReferences(value: unknown): NormalizedReference[] {
  const references: NormalizedReference[] = [];
  const visited = new Set<unknown>();

  collectReferences(value, references, visited, 0, null);
  return references;
}

/**
 * 遍历 Creator 属性包装，识别标量引用、数组元素引用和嵌套对象引用。
 *
 * @param value 当前属性包装、数组元素或嵌套对象。
 * @param references 已收集的引用列表。
 * @param visited 已访问对象集合，用于避免循环结构。
 * @param depth 当前递归深度。
 * @param inheritedKind 数组外层声明但元素自身未重复声明的引用类型。
 */
function collectReferences(
  value: unknown,
  references: NormalizedReference[],
  visited: Set<unknown>,
  depth: number,
  inheritedKind: 'node' | 'component' | 'asset' | null
): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, references, visited, depth + 1, inheritedKind);
    }
    return;
  }

  const property = readObject(value);
  const expectedKind = readExpectedKind(property) ?? inheritedKind;
  const currentValue = readDumpValue(property);

  // Creator 数组的 type 表示元素类型，真正的引用位于 value 内每个属性包装中。
  if (property.isArray === true || Array.isArray(currentValue)) {
    if (Array.isArray(currentValue)) {
      for (const item of currentValue) {
        collectReferences(item, references, visited, depth + 1, expectedKind);
      }
    }
    return;
  }

  if (expectedKind) {
    references.push(createReference(expectedKind, property));
    return;
  }

  if (currentValue !== value) {
    collectReferences(currentValue, references, visited, depth + 1, null);
    return;
  }

  for (const [key, child] of Object.entries(property)) {
    // default 和 elementTypeData 都是声明元数据，不代表当前序列化引用。
    if (key === 'default' || key === 'elementTypeData') continue;
    collectReferences(child, references, visited, depth + 1, null);
  }
}

/**
 * 把单个 Creator 序列化引用包装转换为稳定 Reference 结构。
 *
 * @param expectedKind 属性声明对应的目标类型。
 * @param property Creator 当前属性或数组元素包装。
 * @returns 可用引用或保留序列化缺口的 missing 引用。
 */
function createReference(
  expectedKind: 'node' | 'component' | 'asset',
  property: Record<string, unknown>
): NormalizedReference {
  const declaredType = readString(property.type);
  const serialized = readObject(readDumpValue(property));
  const serializedUuid = readString(serialized.uuid);
  const serializedFileId = readString(serialized.fileId);
  if (!serializedUuid) {
    return {
      kind: 'missing',
      expectedKind,
      serializedUuid: null,
      serializedFileId,
      reason: 'serialized-target-empty'
    };
  }

  if (expectedKind === 'node') {
    return {
      kind: 'node',
      objectUuid: serializedUuid,
      fileId: serializedFileId,
      nodePath: readString(serialized.path),
      available: true
    };
  }
  if (expectedKind === 'component') {
    return {
      kind: 'component',
      objectUuid: serializedUuid,
      fileId: serializedFileId,
      typeId: readString(serialized.typeId) ?? readString(serialized.cid),
      nodePath: readString(serialized.path),
      available: true
    };
  }
  return {
    kind: 'asset',
    assetUuid: serializedUuid,
    subAssetUuid: readString(serialized.subAssetUuid),
    assetType: declaredType,
    path: readString(serialized.path) ?? readString(serialized.url),
    available: true
  };
}

/**
 * 根据属性声明类型和继承链判断引用目标类别。
 *
 * @param property Creator 属性包装。
 * @returns Node、Component、Asset 类别；普通值返回 null。
 */
function readExpectedKind(
  property: Record<string, unknown>
): 'node' | 'component' | 'asset' | null {
  const declaredType = readString(property.type);
  const inheritance = Array.isArray(property.extends)
    ? property.extends.filter((item): item is string => typeof item === 'string')
    : [];
  if (declaredType === 'cc.Node') return 'node';
  if (inheritance.includes('cc.Component')) return 'component';
  if (
    inheritance.includes('cc.Asset')
    || declaredType === 'cc.Script'
    || declaredType === 'cc.Prefab'
    || declaredType === 'cc.SpriteFrame'
    || declaredType === 'cc.RenderTexture'
  ) {
    return 'asset';
  }
  return null;
}

/**
 * 读取非空字符串字段。
 *
 * @param value 待读取值。
 * @returns 非空字符串；其它值返回 null。
 */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
