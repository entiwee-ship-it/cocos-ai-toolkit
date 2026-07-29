import type {
  DesignPlan,
  DesignPlanItem,
  DesignTargetDocument,
  DesignTargetNode,
  PrefabImpactAnalysis
} from '@cocos-ai/protocol';
import type { DesignDiffItem } from './design-diff.js';
import { analyzePrefabImpact, type PrefabImpactGraph } from './prefab-impact.js';

/** 声明式计划组装选项。 */
export interface BuildDesignPlanOptions {
  prefabGraph?: PrefabImpactGraph;
  sourceAssetPath?: string;
  documentEditMode?: 'scene' | 'prefab';
}

interface TargetLocation {
  depth: number;
  parentLogicalId: string | null;
  prefabRootLogicalId: string | null;
  insidePrefabInstance: boolean;
  nodePath: string | null;
}

interface InstanceOverrideTarget {
  instanceRootLogicalId: string;
  targetNodeLogicalId: string;
  targetNodePath: string | null;
}

interface PlanDraft {
  key: string;
  item: DesignPlanItem;
  logicalId: string | null;
  parentLogicalId: string | null;
  componentType: string | null;
  scriptUuid: string | null;
  rank: number;
  sourceIndex: number;
  dependencyKeys: Set<string>;
  humanDependencies: Set<string>;
}

/**
 * 把无序声明式差异组装为有序计划。
 *
 * 计划阶段保留逻辑 ID，不伪造 Cocos UUID；引用类计划项通过 params.resolveTo
 * 记录执行期需要回填的目标。父子创建、组件挂载与引用依赖会进入拓扑排序。
 *
 * @param diffItems Task 2 产生的无序差异。
 * @param target 完整声明式目标文档。
 * @param options Prefab 图、源资产路径和当前编辑模式。
 * @returns 经过依赖排序、影响分析和 Override 标注的计划。
 */
export function buildDesignPlan(
  diffItems: readonly DesignDiffItem[],
  target: DesignTargetDocument,
  options: BuildDesignPlanOptions = {}
): DesignPlan {
  const targetLocations = indexTargetLocations(target.tree);
  const unresolved: DesignPlan['unresolved'] = [];
  const risks: string[] = [];
  const drafts: PlanDraft[] = [];

  diffItems.forEach((diff, sourceIndex) => {
    const logicalId = diff.logicalId ?? null;
    const targetIdentity = logicalId ?? diff.targetUuid ?? null;
    if (!targetIdentity) {
      unresolved.push({ path: `diff[${sourceIndex}]`, reason: `${diff.kind} 缺少逻辑 ID 与当前对象 UUID` });
      return;
    }

    const location = logicalId ? targetLocations.get(logicalId) : undefined;
    if (isBlockedPrefabContentWrite(diff, location, options.documentEditMode)) {
      unresolved.push({
        path: `${targetIdentity}${diff.propertyPath ? `.${diff.propertyPath}` : ''}`,
        reason: 'Cocos Creator 3.8.8 的预制体编辑模式不允许写入嵌套实例内容'
      });
      return;
    }

    const override = createOverrideAnnotation(target.document.scope, diff, location);
    const instanceOverride = createInstanceOverrideTarget(diff, location);
    appendDiffDrafts(drafts, diff, sourceIndex, targetIdentity, override, instanceOverride, unresolved);
    if (override.producesOverride && override.overrideLayer) {
      risks.push(`写入 ${targetIdentity} 将产生 ${override.overrideLayer} Override`);
    }
  });

  appendImplicitLabelLayoutDrafts(drafts, target);
  inferDependencies(drafts);
  const sorted = topologicalSort(drafts, unresolved);
  const impactAnalysis = buildImpactAnalysis(target, diffItems, options, unresolved);
  if (impactAnalysis) risks.push(...impactAnalysis.risks);
  const items = sorted.map((draft) => ({
    ...draft.item,
    dependsOn: draft.humanDependencies.size > 0
      ? [...draft.humanDependencies].sort()
      : undefined
  }));
  appendDocumentOperations(items, target, risks);
  appendApplyToSourceItem(items, target, unresolved, risks);

  return {
    items,
    impactAnalysis,
    risks: [...new Set(risks)],
    unresolved
  };
}

/** apply-to-source 必须以显式原子操作收口，不能只靠 scope 标签暗示。 */
function appendApplyToSourceItem(
  items: DesignPlanItem[],
  target: DesignTargetDocument,
  unresolved: DesignPlan['unresolved'],
  risks: string[]
): void {
  if (target.document.scope !== 'apply-to-source') return;
  const sourceAssetUuid = target.document.assetUuid;
  const instanceRoot = target.tree.length === 1 ? target.tree[0] : undefined;
  if (!sourceAssetUuid || !instanceRoot || instanceRoot.prefabInstance?.assetUuid !== sourceAssetUuid) {
    unresolved.push({
      path: 'document.applyToSource',
      reason: 'apply-to-source 要求目标树恰好一个根，且根 prefabInstance.assetUuid 必须等于 document.assetUuid'
    });
    return;
  }
  items.push({
    kind: 'prefab.apply_to_source',
    target: instanceRoot.id,
    params: {
      instanceRootLogicalId: instanceRoot.id,
      sourcePrefabAssetUuid: sourceAssetUuid
    },
    overrideLayer: 'apply-to-source',
    dependsOn: [...new Set(items.map((item) => item.target))]
  });
  risks.push(`将实例 ${instanceRoot.id} 的 Override 应用到源 Prefab ${sourceAssetUuid}`);
}

/** 为每个逻辑节点记录父子层级和最近的 Prefab 实例根。 */
function indexTargetLocations(nodes: DesignTargetNode[]): Map<string, TargetLocation> {
  const result = new Map<string, TargetLocation>();
  const visit = (
    currentNodes: DesignTargetNode[],
    parentLogicalId: string | null,
    depth: number,
    inheritedPrefabRoot: string | null
  ): void => {
    for (const node of currentNodes) {
      const insidePrefabInstance = inheritedPrefabRoot !== null;
      const prefabRootLogicalId = node.prefabInstance ? node.id : inheritedPrefabRoot;
      result.set(node.id, {
        depth,
        parentLogicalId,
        prefabRootLogicalId,
        insidePrefabInstance,
        nodePath: node.path ?? null
      });
      visit(node.children ?? [], node.id, depth + 1, prefabRootLogicalId);
    }
  };
  visit(nodes, null, 0, null);
  return result;
}

/** 预制体编辑模式只封闭实例内容；实例根挂载点仍允许产生覆盖。 */
function isBlockedPrefabContentWrite(
  diff: DesignDiffItem,
  location: TargetLocation | undefined,
  editMode: BuildDesignPlanOptions['documentEditMode']
): boolean {
  if (editMode !== 'prefab' || !location?.insidePrefabInstance) return false;
  return diff.kind !== 'component.set_property' && diff.kind !== 'reference.set';
}

/** 根据目标 scope 与 Prefab 层级标注 Override。 */
function createOverrideAnnotation(
  scope: DesignTargetDocument['document']['scope'],
  diff: DesignDiffItem,
  location: TargetLocation | undefined
): Pick<DesignPlanItem, 'producesOverride' | 'overrideLayer'> {
  if (location?.insidePrefabInstance
    && (diff.kind === 'component.set_property' || diff.kind === 'reference.set')
    && location.prefabRootLogicalId) {
    return {
      producesOverride: true,
      overrideLayer: `instance:${location.prefabRootLogicalId}`
    };
  }
  if (scope === 'source-prefab') return { producesOverride: false, overrideLayer: 'source-prefab' };
  if (scope === 'apply-to-source') return { producesOverride: false, overrideLayer: 'apply-to-source' };
  if (!location?.prefabRootLogicalId || diff.kind === 'prefab.instantiate') return {};
  return {
    producesOverride: true,
    overrideLayer: `instance:${location.prefabRootLogicalId}`
  };
}

function createInstanceOverrideTarget(
  diff: DesignDiffItem,
  location: TargetLocation | undefined
): InstanceOverrideTarget | null {
  if (!location?.insidePrefabInstance || !location.prefabRootLogicalId || !diff.logicalId) return null;
  if (diff.kind !== 'component.set_property' && diff.kind !== 'reference.set') return null;
  return {
    instanceRootLogicalId: location.prefabRootLogicalId,
    targetNodeLogicalId: diff.logicalId,
    targetNodePath: location.nodePath
  };
}

function appendImplicitLabelLayoutDrafts(
  drafts: PlanDraft[],
  target: DesignTargetDocument
): void {
  const visit = (nodes: readonly DesignTargetNode[]): void => {
    for (const node of nodes) {
      const label = node.components?.find((component) => component.type === 'cc.Label');
      const transform = node.components?.find((component) => component.type === 'cc.UITransform');
      const hasExplicitSize = Boolean(
        transform?.properties
        && Object.prototype.hasOwnProperty.call(transform.properties, 'contentSize')
      );
      const hasExplicitOverflow = Boolean(
        label?.properties
        && Object.prototype.hasOwnProperty.call(label.properties, 'overflow')
      );
      const createsLabel = drafts.some((draft) => (
        draft.logicalId === node.id
        && draft.componentType === 'cc.Label'
        && draft.item.kind === 'component.add'
      ));
      const alreadyPlansOverflow = drafts.some((draft) => (
        draft.logicalId === node.id
        && draft.componentType === 'cc.Label'
        && draft.item.kind === 'component.set_property'
        && draft.item.propertyPath === 'overflow'
      ));
      if (label && hasExplicitSize && !hasExplicitOverflow && createsLabel && !alreadyPlansOverflow) {
        const sourceIndex = drafts.reduce((maximum, draft) => Math.max(maximum, draft.sourceIndex), 0) + 0.01;
        drafts.push(createDraft({
          key: `implicit:label-overflow:${node.id}`,
          item: {
            kind: 'component.set_property',
            target: node.id,
            propertyPath: 'overflow',
            value: 1,
            params: { componentType: 'cc.Label', resolveComponentOf: node.id }
          },
          logicalId: node.id,
          parentLogicalId: null,
          componentType: 'cc.Label',
          scriptUuid: null,
          rank: componentPropertyRank('cc.Label'),
          sourceIndex
        }));
      }
      visit(node.children ?? []);
    }
  };
  visit(target.tree);
}

/** 把单个差异展开为一到多个原子计划草稿。 */
function appendDiffDrafts(
  drafts: PlanDraft[],
  diff: DesignDiffItem,
  sourceIndex: number,
  targetIdentity: string,
  override: Pick<DesignPlanItem, 'producesOverride' | 'overrideLayer'>,
  instanceOverride: InstanceOverrideTarget | null,
  unresolved: DesignPlan['unresolved']
): void {
  const logicalId = diff.logicalId ?? null;
  const baseParams = compactParams({
    targetUuid: diff.targetUuid,
    componentUuid: diff.componentUuid,
    componentType: diff.componentType,
    parentLogicalId: diff.parentLogicalId,
    name: diff.name,
    prefabAssetUuid: diff.prefabAssetUuid,
    scriptUuid: diff.scriptUuid
  });

  if (diff.kind === 'component.add' && diff.scriptUuid) {
    drafts.push(createDraft({
      key: `script-wait:${sourceIndex}`,
      item: {
        kind: 'script.wait_for_compile',
        target: diff.scriptUuid,
        params: { scriptUuid: diff.scriptUuid }
      },
      logicalId: null,
      parentLogicalId: null,
      componentType: null,
      scriptUuid: diff.scriptUuid,
      rank: 40,
      sourceIndex
    }));
  }

  const rankByKind: Record<DesignDiffItem['kind'], number> = {
    'node.create': 10,
    'prefab.instantiate': 20,
    'component.add': diff.scriptUuid ? 80 : 30,
    'component.set_property': componentPropertyRank(diff.componentType),
    'reference.set': 60,
    'component.remove': 90,
    'node.delete': 100
  };
  const planKind = instanceOverride
    ? 'prefab.instance_override'
    : diff.kind === 'reference.set' ? 'component.set_reference' : diff.kind;

  if (diff.kind === 'reference.set' && !diff.componentType && !diff.componentUuid) {
    unresolved.push({
      path: `${targetIdentity}${diff.propertyPath ? `.${diff.propertyPath}` : ''}`,
      reason: '引用差异缺少所属组件身份，无法降级为 component.set_reference'
    });
    return;
  }

  const params = {
    ...baseParams,
    ...(instanceOverride
      ? compactParams({
          instanceRootLogicalId: instanceOverride.instanceRootLogicalId,
          targetNodeLogicalId: instanceOverride.targetNodeLogicalId,
          targetNodePath: instanceOverride.targetNodePath,
          targetObjectUuid: diff.componentUuid ?? (!diff.componentType ? diff.targetUuid : undefined)
        })
      : {})
  };
  if (diff.kind === 'reference.set') {
    if (typeof diff.reference === 'string' && diff.reference.startsWith('$')) {
      params.resolveTo = diff.reference;
    } else {
      params.reference = diff.reference;
    }
  }

  const mainDraft = createDraft({
    key: `diff:${sourceIndex}`,
    item: {
      kind: planKind,
      target: targetIdentity,
      propertyPath: diff.propertyPath,
      value: diff.value,
      params: Object.keys(params).length > 0 ? params : undefined,
      ...override
    },
    logicalId,
    parentLogicalId: diff.parentLogicalId ?? null,
    componentType: diff.componentType ?? null,
    scriptUuid: diff.scriptUuid ?? null,
    rank: rankByKind[diff.kind],
    sourceIndex
  });
  drafts.push(mainDraft);

  if (diff.kind === 'component.add') {
    let childIndex = 0;
    for (const [propertyPath, value] of Object.entries(diff.properties ?? {})) {
      drafts.push(createDraft({
        key: `diff:${sourceIndex}:property:${childIndex++}`,
        item: {
          kind: 'component.set_property',
          target: targetIdentity,
          propertyPath,
          value,
          params: compactParams({ componentType: diff.componentType, resolveComponentOf: targetIdentity }),
          ...override
        },
        logicalId,
        parentLogicalId: null,
        componentType: diff.componentType ?? null,
        scriptUuid: null,
        rank: componentPropertyRank(diff.componentType),
        sourceIndex: sourceIndex + childIndex / 100
      }));
    }
    for (const [propertyPath, reference] of Object.entries(diff.references ?? {})) {
      const referenceParams = compactParams({ componentType: diff.componentType, resolveComponentOf: targetIdentity });
      if (typeof reference === 'string' && reference.startsWith('$')) referenceParams.resolveTo = reference;
      else referenceParams.reference = reference;
      drafts.push(createDraft({
        key: `diff:${sourceIndex}:reference:${childIndex++}`,
        item: {
          kind: 'component.set_reference',
          target: targetIdentity,
          propertyPath,
          params: referenceParams,
          ...override
        },
        logicalId,
        parentLogicalId: null,
        componentType: diff.componentType ?? null,
        scriptUuid: null,
        rank: 60,
        sourceIndex: sourceIndex + childIndex / 100
      }));
    }
  }
}

function componentPropertyRank(componentType: string | undefined): number {
  return componentType === 'cc.UITransform' ? 70 : 50;
}

function createDraft(input: Omit<PlanDraft, 'dependencyKeys' | 'humanDependencies'>): PlanDraft {
  return {
    ...input,
    dependencyKeys: new Set<string>(),
    humanDependencies: new Set<string>()
  };
}

/** 推断节点、组件、脚本和引用目标之间的依赖。 */
function inferDependencies(drafts: PlanDraft[]): void {
  const nodeProducers = new Map<string, string>();
  const componentProducers = new Map<string, string>();
  const scriptWaits = new Map<string, string>();

  for (const draft of drafts) {
    if (draft.logicalId && (draft.item.kind === 'node.create' || draft.item.kind === 'prefab.instantiate')) {
      nodeProducers.set(draft.logicalId, draft.key);
    }
    if (draft.logicalId && draft.componentType && draft.item.kind === 'component.add') {
      componentProducers.set(componentKey(draft.logicalId, draft.componentType), draft.key);
    }
    if (draft.item.kind === 'script.wait_for_compile' && draft.scriptUuid) {
      scriptWaits.set(draft.scriptUuid, draft.key);
    }
  }

  for (const draft of drafts) {
    if (draft.parentLogicalId) {
      addDependency(draft, nodeProducers.get(draft.parentLogicalId), draft.parentLogicalId);
    }
    if (draft.logicalId && draft.item.kind !== 'node.create' && draft.item.kind !== 'prefab.instantiate') {
      addDependency(draft, nodeProducers.get(draft.logicalId), draft.logicalId);
    }
    if (draft.logicalId && draft.componentType && draft.item.kind !== 'component.add') {
      addDependency(draft, componentProducers.get(componentKey(draft.logicalId, draft.componentType)), draft.logicalId);
    }
    if (draft.item.kind === 'component.add' && draft.scriptUuid) {
      addDependency(draft, scriptWaits.get(draft.scriptUuid), draft.scriptUuid);
    }
    const resolveTo = draft.item.params?.resolveTo;
    if (typeof resolveTo === 'string' && resolveTo.startsWith('$')) {
      addDependency(draft, nodeProducers.get(resolveTo), resolveTo);
    }
    for (const referenceId of collectLogicalReferenceIds(draft.item.params?.reference)) {
      addDependency(draft, nodeProducers.get(referenceId), referenceId);
    }
  }
}

function appendDocumentOperations(
  items: DesignPlanItem[],
  target: DesignTargetDocument,
  risks: string[]
): void {
  const locations = indexTargetLocations(target.tree);
  for (const operation of target.operations ?? []) {
    if (operation.type === 'document.extract_subtree') {
      items.push({
        kind: operation.type,
        target: operation.nodeId,
        params: { nodeLogicalId: operation.nodeId, assetUrl: operation.assetUrl },
        dependsOn: [operation.nodeId]
      });
      risks.push(`将节点 ${operation.nodeId} 抽取为 Prefab ${operation.assetUrl}`);
      continue;
    }
    const targetLocation = locations.get(operation.targetId);
    items.push({
      kind: operation.type,
      target: operation.targetId,
      propertyPath: operation.propertyPath,
      params: compactParams({
        instanceRootLogicalId: operation.instanceRootId,
        targetObjectLogicalId: operation.targetId,
        componentType: operation.componentType,
        targetNodePath: targetLocation?.nodePath
      }),
      dependsOn: [operation.instanceRootId, operation.targetId]
    });
    risks.push(`将实例 ${operation.instanceRootId} 的 ${operation.targetId}.${operation.propertyPath} 覆盖精确还原`);
  }
}

function collectLogicalReferenceIds(reference: unknown): string[] {
  if (typeof reference === 'string' && reference.startsWith('$')) return [reference];
  if (!Array.isArray(reference)) return [];
  return reference.flatMap((item) => collectLogicalReferenceIds(item));
}

function addDependency(draft: PlanDraft, key: string | undefined, humanDependency: string): void {
  if (!key || key === draft.key) return;
  draft.dependencyKeys.add(key);
  draft.humanDependencies.add(humanDependency);
}

/** 稳定拓扑排序；无依赖时按阶段 rank 与原差异顺序排列。 */
function topologicalSort(drafts: PlanDraft[], unresolved: DesignPlan['unresolved']): PlanDraft[] {
  const remaining = new Map(drafts.map((draft) => [draft.key, draft]));
  const completed = new Set<string>();
  const result: PlanDraft[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((draft) => [...draft.dependencyKeys].every((key) => completed.has(key) || !remaining.has(key)))
      .sort(compareDrafts);
    if (ready.length === 0) {
      unresolved.push({
        path: 'plan.dependencies',
        reason: `声明式计划存在循环依赖：${[...remaining.keys()].join(', ')}`
      });
      result.push(...[...remaining.values()].sort(compareDrafts));
      break;
    }
    for (const draft of ready) {
      result.push(draft);
      completed.add(draft.key);
      remaining.delete(draft.key);
    }
  }
  return result;
}

function compareDrafts(left: PlanDraft, right: PlanDraft): number {
  return left.rank - right.rank || left.sourceIndex - right.sourceIndex || left.key.localeCompare(right.key);
}

/** source-prefab / apply-to-source 必须带阶段三影响分析。 */
function buildImpactAnalysis(
  target: DesignTargetDocument,
  diffItems: readonly DesignDiffItem[],
  options: BuildDesignPlanOptions,
  unresolved: DesignPlan['unresolved']
): PrefabImpactAnalysis | undefined {
  const needsImpact = target.document.scope === 'source-prefab'
    || target.document.scope === 'apply-to-source'
    || diffItems.some((diff) => diff.kind === 'prefab.instantiate' && target.document.scope !== 'current-document');
  if (!needsImpact) return undefined;

  const sourceAssetUuid = target.document.assetUuid;
  if (!sourceAssetUuid || !options.sourceAssetPath || !options.prefabGraph) {
    unresolved.push({
      path: 'document.impactAnalysis',
      reason: '源预制体相关计划缺少 assetUuid、sourceAssetPath 或 prefabGraph，不能安全执行'
    });
    return undefined;
  }
  return analyzePrefabImpact(options.prefabGraph, sourceAssetUuid, options.sourceAssetPath);
}

function componentKey(logicalId: string, componentType: string): string {
  return `${logicalId}::${componentType}`;
}

/** 去掉 undefined，避免把“缺字段”编码成显式 undefined。 */
function compactParams(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
