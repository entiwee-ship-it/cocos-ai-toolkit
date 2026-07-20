import type { DesignTargetNode } from '@cocos-ai/protocol';

/** 当前状态中的组件规整视图。uuid 在执行期用于把计划项降级为原子写操作。 */
export interface DesignCurrentComponent {
  uuid?: string | null;
  type: string;
  scriptUuid?: string | null;
  properties: Record<string, unknown>;
  references?: Record<string, unknown>;
}

/** 差异计算的当前状态节点视图（由 design-inspect 从文档快照规整）。 */
export interface DesignCurrentNode {
  uuid: string;
  fileId: string | null;
  name: string;
  path: string;
  prefabAssetUuid: string | null;
  components: DesignCurrentComponent[];
  references?: Record<string, unknown>;
  children: DesignCurrentNode[];
}

/** 无序差异项：kind 映射阶段二/三原子操作，targetUuid 为匹配到的当前节点。 */
export interface DesignDiffItem {
  kind: 'node.create' | 'node.delete' | 'component.add' | 'component.remove' | 'component.set_property' | 'prefab.instantiate' | 'reference.set';
  logicalId?: string;
  parentLogicalId?: string | null;
  targetUuid?: string;
  componentUuid?: string;
  name?: string;
  componentType?: string;
  scriptUuid?: string | null;
  properties?: Record<string, unknown>;
  references?: Record<string, unknown>;
  propertyPath?: string;
  value?: unknown;
  prefabAssetUuid?: string;
  reference?: unknown;
  matchBasis?: 'fileId' | 'name-path' | null;
}

interface MatchResult {
  node: DesignCurrentNode;
  basis: 'fileId' | 'name-path';
}

/**
 * 计算当前状态与目标文档的最小差异。
 * 匹配策略：fileId 优先；缺少 fileId 时按完整 path + name 兜底，
 * 没有 path 的旧快照才退化为同级 name 匹配。预制体实例额外校验资产 UUID。
 * 目标未声明的现有内容一律不动；prune 开启才产出多余节点/组件的删除。
 *
 * @param current 当前状态节点树（design-inspect 规整视图）。
 * @param targets 目标文档树（声明式逻辑 ID）。
 * @param prune 是否允许产出删除类差异。
 * @returns 无序差异项清单。
 */
export function computeDesignDiff(
  current: DesignCurrentNode[],
  targets: DesignTargetNode[],
  prune: boolean
): DesignDiffItem[] {
  const items: DesignDiffItem[] = [];
  diffLevel(current, targets, null, items, prune);
  return items;
}

function diffLevel(
  currentSiblings: DesignCurrentNode[],
  targetSiblings: DesignTargetNode[],
  parentLogicalId: string | null,
  items: DesignDiffItem[],
  prune: boolean
): void {
  const matchedCurrent = new Set<DesignCurrentNode>();
  for (const target of targetSiblings) {
    const match = findMatch(currentSiblings, target, matchedCurrent);
    if (match) {
      matchedCurrent.add(match.node);
      diffComponents(match.node, target, items, prune, match.basis);
      diffLevel(match.node.children, target.children ?? [], target.id, items, prune);
      continue;
    }

    emitCreate(target, parentLogicalId, items);
  }
  if (prune) {
    for (const extra of currentSiblings) {
      if (!matchedCurrent.has(extra)) {
        items.push({ kind: 'node.delete', targetUuid: extra.uuid, matchBasis: null });
      }
    }
  }
}

/** 在同级候选中按 fileId 优先、name+path 兜底找未占用匹配。 */
function findMatch(
  siblings: DesignCurrentNode[],
  target: DesignTargetNode,
  matched: Set<DesignCurrentNode>
): MatchResult | null {
  const prefabAssetUuid = target.prefabInstance?.assetUuid;
  const matchesPrefab = (candidate: DesignCurrentNode): boolean =>
    !prefabAssetUuid || candidate.prefabAssetUuid === prefabAssetUuid;

  if (target.fileId && target.match !== 'name-path') {
    const fileIdMatch = siblings.find((candidate) =>
      !matched.has(candidate) && candidate.fileId === target.fileId && matchesPrefab(candidate)
    );
    if (fileIdMatch) return { node: fileIdMatch, basis: 'fileId' };
    if (target.match === 'fileId') return null;
  }

  const targetName = target.prefabInstance?.name ?? target.name;
  if (!targetName) return null;
  const namePathMatch = siblings.find((candidate) => {
    if (matched.has(candidate) || candidate.name !== targetName || !matchesPrefab(candidate)) return false;
    return !target.path || candidate.path === target.path;
  });
  return namePathMatch ? { node: namePathMatch, basis: 'name-path' } : null;
}

/** 比较已匹配节点的组件与引用：缺失产挂载，声明属性/引用不同才产修改。 */
function diffComponents(
  current: DesignCurrentNode,
  target: DesignTargetNode,
  items: DesignDiffItem[],
  prune: boolean,
  matchBasis: 'fileId' | 'name-path'
): void {
  const targetComponents = target.components ?? [];
  const usedCurrent = new Set<number>();
  targetComponents.forEach((component) => {
    const currentIndex = current.components.findIndex((candidate, candidateIndex) =>
      !usedCurrent.has(candidateIndex) && candidate.type === component.type
    );
    if (currentIndex < 0) {
      items.push({
        kind: 'component.add',
        logicalId: target.id,
        targetUuid: current.uuid,
        componentType: component.type,
        scriptUuid: component.scriptUuid ?? null,
        properties: component.properties ?? {},
        references: component.references ?? {},
        matchBasis
      });
      return;
    }

    usedCurrent.add(currentIndex);
    const currentComponent = current.components[currentIndex];
    const currentProperties = currentComponent.properties;
    for (const [propertyPath, value] of Object.entries(component.properties ?? {})) {
      if (!deepEqual(currentProperties[propertyPath], value)) {
        items.push({
          kind: 'component.set_property',
          logicalId: target.id,
          targetUuid: current.uuid,
          componentUuid: currentComponent.uuid ?? undefined,
          componentType: component.type,
          propertyPath,
          value,
          matchBasis
        });
      }
    }
    for (const [propertyPath, reference] of Object.entries(component.references ?? {})) {
      if (!deepEqual(currentComponent.references?.[propertyPath], reference)) {
        items.push({
          kind: 'reference.set',
          logicalId: target.id,
          targetUuid: current.uuid,
          componentUuid: currentComponent.uuid ?? undefined,
          componentType: component.type,
          propertyPath,
          reference,
          matchBasis
        });
      }
    }
  });

  for (const [propertyPath, reference] of Object.entries(target.references ?? {})) {
    if (!deepEqual(current.references?.[propertyPath], reference)) {
      items.push({
        kind: 'reference.set',
        logicalId: target.id,
        targetUuid: current.uuid,
        propertyPath,
        reference,
        matchBasis
      });
    }
  }

  if (prune) {
    current.components.forEach((component, currentIndex) => {
      if (!usedCurrent.has(currentIndex)) {
        items.push({
          kind: 'component.remove',
          logicalId: target.id,
          targetUuid: current.uuid,
          componentUuid: component.uuid ?? undefined,
          componentType: component.type,
          matchBasis
        });
      }
    });
  }
}

/** 输出未匹配节点及其声明内容；新建节点的组件负载一次性挂在 component.add 上。 */
function emitCreate(target: DesignTargetNode, parentLogicalId: string | null, items: DesignDiffItem[]): void {
  if (target.prefabInstance) {
    items.push({
      kind: 'prefab.instantiate',
      logicalId: target.id,
      parentLogicalId,
      prefabAssetUuid: target.prefabInstance.assetUuid,
      name: target.prefabInstance.name ?? target.name,
      matchBasis: null
    });
  } else {
    items.push({
      kind: 'node.create',
      logicalId: target.id,
      parentLogicalId,
      name: target.name ?? target.id,
      matchBasis: null
    });
  }

  const isPrefabInstance = Boolean(target.prefabInstance);
  for (const component of target.components ?? []) {
    if (isPrefabInstance) {
      for (const [propertyPath, value] of Object.entries(component.properties ?? {})) {
        items.push({
          kind: 'component.set_property',
          logicalId: target.id,
          componentType: component.type,
          propertyPath,
          value,
          matchBasis: null
        });
      }
      for (const [propertyPath, reference] of Object.entries(component.references ?? {})) {
        items.push({
          kind: 'reference.set',
          logicalId: target.id,
          componentType: component.type,
          propertyPath,
          reference,
          matchBasis: null
        });
      }
    } else {
      items.push({
        kind: 'component.add',
        logicalId: target.id,
        componentType: component.type,
        scriptUuid: component.scriptUuid ?? null,
        properties: component.properties ?? {},
        references: component.references ?? {},
        matchBasis: null
      });
    }
  }
  for (const [propertyPath, reference] of Object.entries(target.references ?? {})) {
    items.push({
      kind: 'reference.set',
      logicalId: target.id,
      propertyPath,
      reference,
      matchBasis: null
    });
  }
  for (const child of target.children ?? []) {
    emitCreate(child, target.id, items);
  }
}

/** JSON 值深比较（顺序敏感数组、对象按键）。 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key]
    ));
  }
  return false;
}
