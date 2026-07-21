import {
  DesignTargetDocumentSchema,
  type DesignReferenceValue,
  type DesignTargetDocument,
  type DesignTargetNode,
  type DesignVerifyReport
} from '@cocos-ai/protocol';
import { isDeepStrictEqual } from 'node:util';
import type { DesignCurrentComponent, DesignCurrentNode } from './design-diff.js';

/** 导出目标文档时的当前文档身份与 Prefab 实例根信息。 */
export interface DesignExportOptions {
  scope?: DesignTargetDocument['document']['scope'];
  assetUuid?: string | null;
  prefabInstances?: ReadonlyArray<{
    instanceRootObjectUuid: string | null;
    sourcePrefabAssetUuid: string | null;
  }>;
}

/**
 * 把当前状态树导出为可再次消费的声明式目标文档。
 *
 * @param current 当前文档的树形节点状态。
 * @param options 当前文档作用域、资产 UUID 和 Prefab 实例根信息。
 * @returns 通过协议校验、逻辑 ID 稳定且引用已回写的目标文档。
 */
export function exportDesignDocument(
  current: DesignCurrentNode[],
  options: DesignExportOptions = {}
): DesignTargetDocument {
  const logicalIds = assignLogicalIds(current);
  const prefabRoots = new Map(
    (options.prefabInstances ?? [])
      .filter((instance) => instance.instanceRootObjectUuid && instance.sourcePrefabAssetUuid)
      .map((instance) => [instance.instanceRootObjectUuid as string, instance.sourcePrefabAssetUuid as string])
  );
  return DesignTargetDocumentSchema.parse({
    document: {
      scope: options.scope ?? 'current-document',
      ...(options.assetUuid ? { assetUuid: options.assetUuid } : {})
    },
    tree: current.map((node) => exportNode(node, logicalIds, prefabRoots))
  });
}

/**
 * 独立重读当前树并逐项对照目标文档，生成稳定的 design_verify 报告。
 *
 * @param current 当前文档的最新树形状态。
 * @param target 待核对的声明式目标文档。
 * @returns 包含节点、组件、属性、引用和覆盖归属明细的验证报告。
 */
export function verifyDesignTarget(
  current: DesignCurrentNode[],
  target: DesignTargetDocument
): DesignVerifyReport {
  const normalizedTarget = DesignTargetDocumentSchema.parse(target);
  const resolutions = resolveTargetNodes(current, normalizedTarget.tree);
  const items: DesignVerifyReport['items'] = [];
  verifyLevel(
    current,
    normalizedTarget.tree,
    normalizedTarget.document.scope,
    resolutions,
    items,
    normalizedTarget.prune === true
  );
  return {
    passed: items.every((item) => item.passed),
    verifiedAt: new Date().toISOString(),
    items
  };
}

function assignLogicalIds(nodes: DesignCurrentNode[]): Map<string, string> {
  const logicalIds = new Map<string, string>();
  const usedIds = new Set<string>();
  const visit = (entries: DesignCurrentNode[]): void => {
    for (const node of entries) {
      const source = node.fileId ?? node.path ?? node.uuid;
      const slug = sanitizeIdPart(source);
      let logicalId = `$node-${slug}`;
      let suffix = 2;
      while (usedIds.has(logicalId)) {
        logicalId = `$node-${slug}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(logicalId);
      logicalIds.set(node.uuid, logicalId);
      visit(node.children);
    }
  };
  visit(nodes);
  return logicalIds;
}

function sanitizeIdPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'object';
}

function exportNode(
  node: DesignCurrentNode,
  logicalIds: Map<string, string>,
  prefabRoots: Map<string, string>
): DesignTargetNode {
  const prefabAssetUuid = prefabRoots.get(node.uuid);
  const components = node.components.map((component) => exportComponent(component, logicalIds));
  return {
    id: logicalIds.get(node.uuid) ?? `$node-${sanitizeIdPart(node.uuid)}`,
    ...(node.fileId ? { fileId: node.fileId } : {}),
    ...(node.path ? { path: node.path } : {}),
    name: node.name,
    ...(prefabAssetUuid ? { prefabInstance: { assetUuid: prefabAssetUuid, name: node.name } } : {}),
    ...(components.length > 0 ? { components } : {}),
    ...(node.references && Object.keys(node.references).length > 0
      ? { references: exportReferences(node.references, logicalIds) }
      : {}),
    ...(node.children.length > 0
      ? { children: node.children.map((child) => exportNode(child, logicalIds, prefabRoots)) }
      : {}),
    match: node.fileId ? 'fileId' : 'name-path'
  };
}

function exportComponent(
  component: DesignCurrentComponent,
  logicalIds: Map<string, string>
): NonNullable<DesignTargetNode['components']>[number] {
  const references = exportReferences(component.references ?? {}, logicalIds);
  return {
    type: component.type,
    ...(component.scriptUuid !== undefined ? { scriptUuid: component.scriptUuid } : {}),
    ...(Object.keys(component.properties).length > 0 ? { properties: component.properties } : {}),
    ...(Object.keys(references).length > 0 ? { references } : {})
  };
}

function exportReferences(
  references: Record<string, unknown>,
  logicalIds: Map<string, string>
): Record<string, DesignReferenceValue> {
  const exported: Record<string, DesignReferenceValue> = {};
  for (const [propertyPath, value] of Object.entries(references)) {
    if (isNodeReference(value)) {
      const logicalId = value.objectUuid ? logicalIds.get(value.objectUuid) : undefined;
      if (logicalId) {
        exported[propertyPath] = logicalId;
        continue;
      }
    }
    exported[propertyPath] = value as DesignReferenceValue;
  }
  return exported;
}

function isNodeReference(value: unknown): value is { kind: 'node'; objectUuid: string | null } {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'node'
    && ('objectUuid' in value)
  );
}

interface NodeResolution {
  target: DesignTargetNode;
  current: DesignCurrentNode | null;
}

function resolveTargetNodes(
  current: DesignCurrentNode[],
  targets: DesignTargetNode[]
): Map<string, DesignCurrentNode | null> {
  const resolutions = new Map<string, DesignCurrentNode | null>();
  const visit = (currentSiblings: DesignCurrentNode[], targetSiblings: DesignTargetNode[]): void => {
    const used = new Set<DesignCurrentNode>();
    for (const target of targetSiblings) {
      const matched = findMatchingNode(currentSiblings, target, used);
      if (matched) used.add(matched);
      resolutions.set(target.id, matched ?? null);
      visit(matched?.children ?? [], target.children ?? []);
    }
  };
  visit(current, targets);
  return resolutions;
}

function findMatchingNode(
  siblings: DesignCurrentNode[],
  target: DesignTargetNode,
  used: Set<DesignCurrentNode>
): DesignCurrentNode | undefined {
  const prefabAssetUuid = target.prefabInstance?.assetUuid;
  const matchesPrefab = (candidate: DesignCurrentNode): boolean =>
    !prefabAssetUuid || candidate.prefabAssetUuid === prefabAssetUuid;
  if (target.fileId && target.match !== 'name-path') {
    const byFileId = siblings.find((candidate) =>
      !used.has(candidate) && candidate.fileId === target.fileId && matchesPrefab(candidate)
    );
    if (byFileId) return byFileId;
    if (target.match === 'fileId') return undefined;
  }
  const targetName = target.prefabInstance?.name ?? target.name;
  return siblings.find((candidate) =>
    !used.has(candidate)
    && candidate.name === targetName
    && (!target.path || candidate.path === target.path)
    && matchesPrefab(candidate)
  );
}

function verifyLevel(
  currentSiblings: DesignCurrentNode[],
  targets: DesignTargetNode[],
  scope: DesignTargetDocument['document']['scope'],
  resolutions: Map<string, DesignCurrentNode | null>,
  items: DesignVerifyReport['items'],
  prune: boolean
): void {
  const used = new Set<DesignCurrentNode>();
  for (const target of targets) {
    const current = resolutions.get(target.id) ?? null;
    if (current) used.add(current);
    items.push(verificationItem(
      target.id,
      'node',
      { fileId: target.fileId ?? null, name: target.name ?? null, path: target.path ?? null },
      current
        ? { fileId: current.fileId, name: current.name, path: current.path, uuid: current.uuid }
        : null,
      Boolean(current)
    ));
    verifyComponents(current, target, scope, resolutions, items, prune);
    verifyLevel(current?.children ?? [], target.children ?? [], scope, resolutions, items, prune);
  }
  if (prune) {
    for (const extra of currentSiblings) {
      if (!used.has(extra)) {
        items.push(verificationItem(
          `$node-${sanitizeIdPart(extra.uuid)}`,
          'unexpected-node',
          null,
          { uuid: extra.uuid, name: extra.name, path: extra.path },
          false
        ));
      }
    }
  }
}

function verifyComponents(
  current: DesignCurrentNode | null,
  target: DesignTargetNode,
  scope: DesignTargetDocument['document']['scope'],
  resolutions: Map<string, DesignCurrentNode | null>,
  items: DesignVerifyReport['items'],
  prune: boolean
): void {
  const currentComponents = current?.components ?? [];
  const used = new Set<DesignCurrentComponent>();
  for (const targetComponent of target.components ?? []) {
    const component = currentComponents.find((candidate) =>
      !used.has(candidate) && candidate.type === targetComponent.type
    );
    if (component) used.add(component);
    const componentTarget = `${target.id}::${targetComponent.type}`;
    items.push(verificationItem(
      componentTarget,
      'component',
      { type: targetComponent.type },
      component ? { type: component.type, uuid: component.uuid ?? null } : null,
      Boolean(component)
    ));
    for (const [propertyPath, expected] of Object.entries(targetComponent.properties ?? {})) {
      const actual = component?.properties[propertyPath];
      const present = component ? Object.prototype.hasOwnProperty.call(component.properties, propertyPath) : false;
      items.push(verificationItem(
        componentTarget,
        `property:${propertyPath}`,
        expected,
        actual,
        present && isDeepStrictEqual(actual, expected)
      ));
      appendOverrideVerification(scope, current, component, componentTarget, propertyPath, items);
    }
    for (const [propertyPath, expected] of Object.entries(targetComponent.references ?? {})) {
      const actual = component?.references?.[propertyPath];
      items.push(verificationItem(
        componentTarget,
        `reference:${propertyPath}`,
        expected,
        actual,
        Boolean(component) && referenceMatches(actual, expected, resolutions)
      ));
      appendOverrideVerification(scope, current, component, componentTarget, propertyPath, items);
    }
  }
  if (prune) {
    for (const extra of currentComponents) {
      if (!used.has(extra)) {
        items.push(verificationItem(
          `${target.id}::${extra.type}`,
          'unexpected-component',
          null,
          { type: extra.type, uuid: extra.uuid ?? null },
          false
        ));
      }
    }
  }
}

function appendOverrideVerification(
  scope: DesignTargetDocument['document']['scope'],
  current: DesignCurrentNode | null,
  component: DesignCurrentComponent | undefined,
  target: string,
  propertyPath: string,
  items: DesignVerifyReport['items']
): void {
  if (!current?.prefabAssetUuid || !component) return;
  const expected = scope === 'current-document' ? 'override' : 'source';
  const actualSource = component.propertySources?.[propertyPath];
  const actual = actualSource === 'override' ? 'override' : 'source';
  items.push(verificationItem(target, `override:${propertyPath}`, expected, actual, expected === actual));
}

function referenceMatches(
  actual: unknown,
  expected: unknown,
  resolutions: Map<string, DesignCurrentNode | null>
): boolean {
  if (typeof expected === 'string' && expected.startsWith('$')) {
    const resolved = resolutions.get(expected);
    return Boolean(
      actual
      && typeof actual === 'object'
      && (actual as { objectUuid?: unknown }).objectUuid === resolved?.uuid
    );
  }
  return isDeepStrictEqual(actual, expected);
}

function verificationItem(
  target: string,
  description: string,
  expected: unknown,
  actual: unknown,
  passed: boolean
): DesignVerifyReport['items'][number] {
  return { target, description, expected, actual, passed };
}
