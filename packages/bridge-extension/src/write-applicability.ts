export interface NodeWriteApplicabilityInput {
  documentAssetUuid: string | null;
  documentMode: string | null;
  nodeFileId: string | null;
  prefabAssetUuid: string | null;
  sourceUrl: string | null;
  isInstanceRoot: boolean;
}

/**
 * 根据当前文档和节点 Prefab 来源生成写入能力。
 *
 * @param input 当前文档身份、节点 FileID、Prefab 来源和实例根标记。
 * @returns 节点各类公开写操作是否可在当前文档直接执行，以及源 Prefab 路由。
 */
export function buildNodeWriteCapabilities(input: NodeWriteApplicabilityInput) {
  const identityKnown = Boolean(input.documentAssetUuid && input.documentMode);
  const isNestedPrefabContent = Boolean(
    identityKnown
    && input.documentMode === 'prefab'
    && input.prefabAssetUuid
    && input.prefabAssetUuid !== input.documentAssetUuid
  );
  const unrestricted = !isNestedPrefabContent;
  const rootOperationAllowed = unrestricted || input.isInstanceRoot;
  const reasonCode = !identityKnown
    ? 'DOCUMENT_IDENTITY_UNAVAILABLE'
    : !isNestedPrefabContent
      ? null
      : input.isInstanceRoot
        ? 'NESTED_PREFAB_INSTANCE_ROOT_LIMITED'
        : 'NESTED_PREFAB_CONTENT_CLOSED';
  return {
    assessment: identityKnown ? 'confirmed' as const : 'unknown' as const,
    documentMode: input.documentMode,
    ownerDocumentUuid: input.documentAssetUuid,
    ownerPrefabUuid: input.prefabAssetUuid,
    ownerSourceUrl: input.sourceUrl,
    sourceFileId: input.nodeFileId,
    isNestedPrefabContent,
    isInstanceRoot: input.isInstanceRoot,
    canRename: rootOperationAllowed,
    canSetTransform: rootOperationAllowed,
    canDelete: rootOperationAllowed,
    canReparent: rootOperationAllowed,
    canDuplicate: rootOperationAllowed,
    canSetActive: unrestricted,
    canSetLayer: unrestricted,
    canCreateChild: unrestricted,
    canAddComponent: unrestricted,
    canRemoveComponent: unrestricted,
    canSetComponentProperty: unrestricted,
    reasonCode,
    nextAction: isNestedPrefabContent && input.prefabAssetUuid ? {
      tool: 'cocos_prefab_open' as const,
      arguments: { uuid: input.prefabAssetUuid }
    } : null
  };
}

export type NodeWriteCapabilities = ReturnType<typeof buildNodeWriteCapabilities>;
