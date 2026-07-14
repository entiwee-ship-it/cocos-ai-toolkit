export interface PrefabTarget {
  assetUuid: string;
  fileId: string;
  nodePath: string | null;
}

export interface PrefabTargetMap {
  targets: Record<string, PrefabTarget>;
  children: Record<string, PrefabTargetMap>;
}

export interface PrefabOverrideSummary {
  propertyOverrideCount: number;
  targetOverrideCount: number;
  mountedChildrenCount: number;
  mountedComponentsCount: number;
  removedComponentsCount: number;
}

export interface PrefabGraphEdge {
  fromAssetUuid: string;
  toAssetUuid: string;
  kind: 'prefab-instance';
  hostNodePath: string | null;
  instanceFileId: string | null;
  sourceObjectFileId: string | null;
  depth: number;
  overrideCount: number;
  overrideSummary: PrefabOverrideSummary;
}

export interface PrefabGraphNode {
  assetUuid: string;
  path: string | null;
  documentType: 'scene' | 'prefab';
}

export interface PrefabGraphDiagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  details?: unknown;
}

export interface PrefabGraph {
  nodes: PrefabGraphNode[];
  edges: PrefabGraphEdge[];
  targetMaps: PrefabTargetMap;
  targetMapsByAsset: Record<string, PrefabTargetMap>;
  blocked: boolean;
  diagnostics: PrefabGraphDiagnostic[];
}

export interface PrefabTargetResolution {
  target: Pick<PrefabTarget, 'assetUuid' | 'fileId'> | null;
  localIds: string[];
  failedSegmentIndex: number | null;
}

export interface PrefabTargetInput {
  fileId: string;
  nodePath?: string | null;
}

export interface PrefabInstanceInput {
  sourceAssetUuid: string;
  depth?: number;
  instanceRootObjectUuid?: string | null;
  instanceFileId?: string | null;
  sourceObjectFileId?: string | null;
  hostNodePath?: string | null;
  propertyOverrides?: unknown[];
  targetOverrides?: unknown[];
  mountedChildren?: unknown[];
  mountedComponents?: unknown[];
  removedComponents?: unknown[];
  nestedInstances?: PrefabInstanceInput[];
  instances?: PrefabInstanceInput[];
}

export interface PrefabDocumentInput {
  assetUuid: string;
  path?: string | null;
  documentType: 'scene' | 'prefab';
  targets?: PrefabTargetInput[];
  instances?: PrefabInstanceInput[];
  prefabInstances?: PrefabInstanceInput[];
}

export interface PrefabDocumentSnapshotInput {
  document: {
    assetUuid: string | null;
    path: string | null;
    documentType: 'scene' | 'prefab' | null;
  };
  nodes?: Array<{
    identity?: { fileId?: string | null };
    path?: string | null;
  }>;
  componentSchemas?: Array<{
    componentFileId?: string | null;
    nodePath?: string | null;
  }>;
  prefabInstances?: Array<{
    sourceAssetUuid?: string | null;
    sourcePrefabAssetUuid?: string | null;
    instanceRootObjectUuid?: string | null;
    instanceFileId?: string | null;
    sourceObjectFileId?: string | null;
    hostNodePath?: string | null;
    propertyOverrides?: unknown[];
    targetOverrides?: unknown[];
    mountedChildren?: unknown[];
    mountedComponents?: unknown[];
    removedComponents?: unknown[];
    instanceChain?: Array<{
      depth: number;
      assetUuid: string;
      instanceNodeUuid?: string | null;
    }>;
  }>;
}

/**
 * 把 Creator 文档快照转换为跨资源 Prefab 图。
 *
 * @param snapshots 已由 Bridge 规范化的 Scene 或 Prefab 文档快照。
 * @returns 包含来源边、FileID TargetMap 和阻断诊断的 Prefab 图。
 */
export function buildPrefabGraphFromSnapshots(snapshots: PrefabDocumentSnapshotInput[]): PrefabGraph {
  const diagnostics: PrefabGraphDiagnostic[] = [];
  const documentsByAsset = new Map<string, PrefabDocumentInput>();

  // 第一遍只登记文档身份和节点、组件 FileID，避免实例链引用尚未登记的父 Prefab。
  for (let documentIndex = 0; documentIndex < snapshots.length; documentIndex += 1) {
    const snapshot = snapshots[documentIndex];
    const { assetUuid, path, documentType } = snapshot.document;
    if (!assetUuid || !documentType) {
      diagnostics.push({
        code: 'PREFAB_GRAPH_DOCUMENT_IDENTITY_MISSING',
        message: `第 ${documentIndex} 个文档快照缺少 Asset UUID 或文档类型`,
        severity: 'error',
        details: { documentIndex, document: snapshot.document }
      });
      continue;
    }
    const pageTargets = [
      ...(snapshot.nodes ?? []).flatMap((node) => {
        const fileId = node.identity?.fileId;
        return fileId ? [{ fileId, nodePath: node.path ?? null }] : [];
      }),
      ...(snapshot.componentSchemas ?? []).flatMap((component) => {
        const fileId = component.componentFileId;
        return fileId ? [{ fileId, nodePath: component.nodePath ?? null }] : [];
      })
    ];
    const existingDocument = documentsByAsset.get(assetUuid);
    if (existingDocument) {
      existingDocument.path ??= path;
      existingDocument.targets = mergeTargets(existingDocument.targets ?? [], pageTargets);
      continue;
    }
    documentsByAsset.set(assetUuid, {
      assetUuid,
      path,
      documentType,
      targets: pageTargets,
      instances: []
    });
  }

  // 第二遍按 instanceChain 把扁平实例重新归属到真实父 Prefab，并去除重复来源边。
  for (let documentIndex = 0; documentIndex < snapshots.length; documentIndex += 1) {
    const snapshot = snapshots[documentIndex];
    const ownerAssetUuid = snapshot.document.assetUuid;
    if (!ownerAssetUuid || !snapshot.document.documentType) continue;
    for (let instanceIndex = 0; instanceIndex < (snapshot.prefabInstances?.length ?? 0); instanceIndex += 1) {
      const instance = snapshot.prefabInstances?.[instanceIndex];
      if (!instance) continue;
      const sourceAssetUuid = instance.sourceAssetUuid ?? instance.sourcePrefabAssetUuid ?? null;
      if (!sourceAssetUuid) {
        diagnostics.push({
          code: 'PREFAB_SOURCE_ASSET_UUID_MISSING',
          message: `${ownerAssetUuid} 的第 ${instanceIndex} 个 Prefab 实例缺少源 Asset UUID`,
          severity: 'warning',
          details: { assetUuid: ownerAssetUuid, instanceIndex }
        });
        continue;
      }
      const chain = instance.instanceChain ?? [];
      let sourceIndex = -1;
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        if (chain[index].assetUuid === sourceAssetUuid) {
          sourceIndex = index;
          break;
        }
      }
      const parentAssetUuid = sourceIndex > 0
        ? chain[sourceIndex - 1].assetUuid
        : ownerAssetUuid;
      const parentDocument = documentsByAsset.get(parentAssetUuid) ?? {
        assetUuid: parentAssetUuid,
        path: null,
        documentType: 'prefab' as const,
        targets: [],
        instances: []
      };
      documentsByAsset.set(parentAssetUuid, parentDocument);
      const normalizedInstance: PrefabInstanceInput = {
        sourceAssetUuid,
        depth: sourceIndex >= 0 ? chain[sourceIndex].depth : 1,
        instanceRootObjectUuid: instance.instanceRootObjectUuid ?? null,
        instanceFileId: instance.instanceFileId ?? null,
        sourceObjectFileId: instance.sourceObjectFileId ?? null,
        hostNodePath: instance.hostNodePath ?? null,
        propertyOverrides: instance.propertyOverrides ?? [],
        targetOverrides: instance.targetOverrides ?? [],
        mountedChildren: instance.mountedChildren ?? [],
        mountedComponents: instance.mountedComponents ?? [],
        removedComponents: instance.removedComponents ?? []
      };
      const instances = parentDocument.instances ?? [];
      const key = createInstanceKey(normalizedInstance);
      if (key === null || !instances.some((candidate) => createInstanceKey(candidate) === key)) {
        instances.push(normalizedInstance);
      }
      parentDocument.instances = instances;
    }
  }
  const graph = buildPrefabGraph([...documentsByAsset.values()]);
  graph.diagnostics.unshift(...diagnostics);
  graph.blocked ||= diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return graph;
}

/**
 * 生成 Prefab 实例的稳定去重键。
 *
 * @param instance 单个已规范化 Prefab 实例。
 * @returns 由运行时实例根、实例 FileID、源 FileID 和宿主路径组成的扫描内去重键；无可用身份时返回 null。
 */
function createInstanceKey(instance: PrefabInstanceInput): string | null {
  const identityParts = [
    instance.instanceRootObjectUuid,
    instance.instanceFileId,
    instance.sourceObjectFileId,
    instance.hostNodePath
  ];
  if (!identityParts.some((value) => Boolean(value))) return null;
  return [
    instance.sourceAssetUuid,
    instance.instanceRootObjectUuid ?? '',
    instance.instanceFileId ?? '',
    instance.sourceObjectFileId ?? '',
    instance.hostNodePath ?? ''
  ].join('\u0000');
}

/**
 * 合并同一文档不同分页返回的节点和组件 FileID。
 *
 * @param current 已从较早页面收集的 FileID 目标。
 * @param incoming 当前页面新增的 FileID 目标。
 * @returns 按 FileID 去重并保留最新节点路径的目标数组。
 */
function mergeTargets(
  current: PrefabTargetInput[],
  incoming: PrefabTargetInput[]
): PrefabTargetInput[] {
  const targets = new Map(current.map((target) => [target.fileId, target]));
  for (const target of incoming) targets.set(target.fileId, target);
  return [...targets.values()];
}

/**
 * 从规范化文档输入建立 Prefab 资产图和逐层 TargetMap。
 *
 * @param documents 已按 Asset UUID 分组的 Scene 或 Prefab 文档。
 * @returns 可序列化的 Prefab 图、来源边、TargetMap 和诊断。
 */
export function buildPrefabGraph(documents: PrefabDocumentInput[]): PrefabGraph {
  const nodes = new Map<string, PrefabGraphNode>();
  const documentByAsset = new Map<string, PrefabDocumentInput>();
  const edges: PrefabGraphEdge[] = [];
  const diagnostics: PrefabGraphDiagnostic[] = [];
  const targetMapsByAsset: Record<string, PrefabTargetMap> = {};
  const targetMaps = createTargetMap();

  // 先登记所有已扫描文档，后续遇到未扫描源 Prefab 时再补充占位节点。
  for (const document of documents) {
    documentByAsset.set(document.assetUuid, document);
    nodes.set(document.assetUuid, {
      assetUuid: document.assetUuid,
      path: document.path ?? null,
      documentType: document.documentType
    });
  }

  // 为每个文档建立直接 FileID 索引，并收集当前已知的实例来源边。
  for (const document of documents) {
    const documentMap = createTargetMap();
    for (const target of document.targets ?? []) {
      addTarget(documentMap, target.fileId, {
        assetUuid: document.assetUuid,
        fileId: target.fileId,
        nodePath: target.nodePath ?? null
      }, diagnostics, document.assetUuid);
    }
    const instances = readInstances(document);
    for (const instance of instances) {
      addInstanceTarget(documentMap, instance, diagnostics, document.assetUuid);
      addInstanceTarget(targetMaps, instance, diagnostics, document.assetUuid);
    }
    targetMapsByAsset[document.assetUuid] = documentMap;
    collectEdges(
      document.assetUuid,
      instances,
      1,
      [document.assetUuid],
      edges,
      diagnostics,
      nodes,
      documentByAsset
    );
  }

  const directTargetMapsByAsset = Object.fromEntries(
    Object.entries(targetMapsByAsset).map(([assetUuid, map]) => [
      assetUuid,
      cloneTargetMap(map)
    ])
  );

  // 使用未展开的直接索引递归连接跨文档 TargetMap，避免共享依赖导致指数级复制。
  for (const document of documents) {
    attachReferencedTargetMaps(
      targetMapsByAsset[document.assetUuid],
      readInstances(document),
      [document.assetUuid],
      documentByAsset,
      directTargetMapsByAsset,
      diagnostics,
      document.assetUuid
    );
    attachReferencedTargetMaps(
      targetMaps,
      readInstances(document),
      [document.assetUuid],
      documentByAsset,
      directTargetMapsByAsset,
      diagnostics,
      document.assetUuid
    );
  }

  detectGraphCycles(edges, diagnostics);

  return {
    nodes: [...nodes.values()],
    edges,
    targetMaps,
    targetMapsByAsset,
    blocked: diagnostics.some((diagnostic) => diagnostic.code === 'PREFAB_GRAPH_CYCLE' && diagnostic.severity === 'error'),
    diagnostics
  };
}

/**
 * 把源 Prefab 的直接 TargetMap 接到当前实例的 FileID 路径下。
 *
 * @param ownerMap 当前宿主文档或上级实例的 TargetMap。
 * @param instances 当前层的 Prefab 实例。
 * @param assetPath 当前递归资产链，用于阻止循环展开。
 * @param documentByAsset Asset UUID 到文档输入的映射。
 * @param targetMapsByAsset Asset UUID 到未展开直接 TargetMap 的映射。
 * @param diagnostics TargetMap 冲突诊断收集器。
 * @param ownerAssetUuid 当前 TargetMap 所属资产 UUID。
 */
function attachReferencedTargetMaps(
  ownerMap: PrefabTargetMap,
  instances: PrefabInstanceInput[],
  assetPath: string[],
  documentByAsset: Map<string, PrefabDocumentInput>,
  targetMapsByAsset: Record<string, PrefabTargetMap>,
  diagnostics: PrefabGraphDiagnostic[],
  ownerAssetUuid: string
): void {
  for (const instance of instances) {
    const createsCycle = assetPath.includes(instance.sourceAssetUuid);
    const aliases = [instance.sourceObjectFileId, instance.instanceFileId]
      .filter((value): value is string => Boolean(value));
    const sourceMap = targetMapsByAsset[instance.sourceAssetUuid];
    const childMaps: PrefabTargetMap[] = [];
    for (const alias of aliases) {
      const childMap = ownerMap.children[alias] ?? createTargetMap();
      ownerMap.children[alias] = childMap;
      if (!childMaps.includes(childMap)) childMaps.push(childMap);
      if (sourceMap && !createsCycle) {
        mergeTargetMaps(childMap, sourceMap, diagnostics, ownerAssetUuid);
      }
    }
    if (createsCycle) continue;
    const sourceDocument = documentByAsset.get(instance.sourceAssetUuid);
    if (!sourceDocument) continue;
    for (const childMap of childMaps) {
      attachReferencedTargetMaps(
        childMap,
        readInstances(sourceDocument),
        [...assetPath, instance.sourceAssetUuid],
        documentByAsset,
        targetMapsByAsset,
        diagnostics,
        instance.sourceAssetUuid
      );
    }
  }
}

/**
 * 把一个 TargetMap 的内容递归合并到另一个 TargetMap。
 *
 * @param destination 接收目标条目的 TargetMap。
 * @param source 提供目标条目的 TargetMap。
 * @param diagnostics FileID 冲突诊断收集器。
 * @param ownerAssetUuid 当前合并目标所属资产 UUID。
 */
function mergeTargetMaps(
  destination: PrefabTargetMap,
  source: PrefabTargetMap,
  diagnostics: PrefabGraphDiagnostic[],
  ownerAssetUuid: string
): void {
  for (const [fileId, target] of Object.entries(source.targets)) {
    addTarget(destination, fileId, target, diagnostics, ownerAssetUuid);
  }
  for (const [fileId, sourceChild] of Object.entries(source.children)) {
    const destinationChild = destination.children[fileId] ?? createTargetMap();
    destination.children[fileId] = destinationChild;
    mergeTargetMaps(destinationChild, sourceChild, diagnostics, ownerAssetUuid);
  }
}

/**
 * 解析 localID 路径并仅返回最终稳定目标。
 *
 * @param localIds Creator TargetInfo 中按层级排列的 localID 数组。
 * @param targetMaps 当前宿主上下文的 TargetMap。
 * @returns 成功时返回最终 Asset UUID 和 FileID；失败时返回 null。
 */
export function resolveTarget(localIds: string[], targetMaps: PrefabTargetMap): Pick<PrefabTarget, 'assetUuid' | 'fileId'> | null {
  return resolveTargetPath(localIds, targetMaps).target;
}

/**
 * 逐段解析 localID，并在失败时保留完整输入和失败段索引。
 *
 * @param localIds Creator TargetInfo 中按层级排列的 localID 数组。
 * @param targetMaps 当前宿主上下文的 TargetMap。
 * @returns 最终目标或带失败段索引的稳定解析结果。
 */
export function resolveTargetPath(localIds: string[], targetMaps: PrefabTargetMap): PrefabTargetResolution {
  const input = [...localIds];
  if (input.length === 0) return { target: null, localIds: input, failedSegmentIndex: 0 };
  let current = targetMaps;
  for (let index = 0; index < input.length; index += 1) {
    const localId = input[index];
    const target = current.targets[localId];
    const child = current.children[localId];
    if (!target) return { target: null, localIds: input, failedSegmentIndex: index };
    if (index === input.length - 1) {
      return {
        target: { assetUuid: target.assetUuid, fileId: target.fileId },
        localIds: input,
        failedSegmentIndex: null
      };
    }
    if (!child) return { target: null, localIds: input, failedSegmentIndex: index + 1 };
    current = child;
  }
  return { target: null, localIds: input, failedSegmentIndex: input.length - 1 };
}

/**
 * 检测资产来源边中的循环引用并生成阻断诊断。
 *
 * @param edges 已收集的 Prefab 实例来源边。
 * @param diagnostics 追加循环错误的诊断收集器。
 */
function detectGraphCycles(edges: PrefabGraphEdge[], diagnostics: PrefabGraphDiagnostic[]): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.fromAssetUuid) ?? [];
    targets.push(edge.toAssetUuid);
    adjacency.set(edge.fromAssetUuid, targets);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (assetUuid: string): void => {
    if (active.has(assetUuid)) {
      const start = stack.indexOf(assetUuid);
      const cycle = [...stack.slice(start), assetUuid];
      if (!diagnostics.some((diagnostic) => diagnostic.code === 'PREFAB_GRAPH_CYCLE' && JSON.stringify(diagnostic.details) === JSON.stringify({ cycle }))) {
        diagnostics.push({
          code: 'PREFAB_GRAPH_CYCLE',
          message: `Prefab 引用形成循环：${cycle.join(' -> ')}`,
          severity: 'error',
          details: { cycle }
        });
      }
      return;
    }
    if (visited.has(assetUuid)) return;
    visited.add(assetUuid);
    active.add(assetUuid);
    stack.push(assetUuid);
    for (const target of adjacency.get(assetUuid) ?? []) visit(target);
    stack.pop();
    active.delete(assetUuid);
  };

  for (const assetUuid of adjacency.keys()) visit(assetUuid);
}

/**
 * 递归收集当前文档及其内联嵌套实例的来源边。
 *
 * @param fromAssetUuid 当前实例宿主 Prefab 的 Asset UUID。
 * @param instances 当前层 Prefab 实例。
 * @param depth 当前默认嵌套深度。
 * @param path 当前递归资产链。
 * @param edges 来源边收集器。
 * @param diagnostics 循环引用诊断收集器。
 * @param nodes 图节点收集器。
 * @param documentByAsset Asset UUID 到文档输入的映射。
 */
function collectEdges(
  fromAssetUuid: string,
  instances: PrefabInstanceInput[],
  depth: number,
  path: string[],
  edges: PrefabGraphEdge[],
  diagnostics: PrefabGraphDiagnostic[],
  nodes: Map<string, PrefabGraphNode>,
  documentByAsset: Map<string, PrefabDocumentInput>
): void {
  for (const instance of instances) {
    const toAssetUuid = instance.sourceAssetUuid;
    if (!nodes.has(toAssetUuid)) {
      const referencedDocument = documentByAsset.get(toAssetUuid);
      nodes.set(toAssetUuid, {
        assetUuid: toAssetUuid,
        path: referencedDocument?.path ?? null,
        documentType: referencedDocument?.documentType ?? 'prefab'
      });
    }
    const overrideSummary = summarizeOverrides(instance);
    const edgeDepth = instance.depth ?? depth;
    edges.push({
      fromAssetUuid,
      toAssetUuid,
      kind: 'prefab-instance',
      hostNodePath: instance.hostNodePath ?? null,
      instanceFileId: instance.instanceFileId ?? null,
      sourceObjectFileId: instance.sourceObjectFileId ?? null,
      depth: edgeDepth,
      overrideCount: overrideSummary.propertyOverrideCount,
      overrideSummary
    });

    if (path.includes(toAssetUuid)) {
      const cycle = [...path, toAssetUuid];
      diagnostics.push({
        code: 'PREFAB_GRAPH_CYCLE',
        message: `Prefab 引用形成循环：${cycle.join(' -> ')}`,
        severity: 'error',
        details: { cycle }
      });
      continue;
    }

    const nested = readInstances(instance);
    if (nested.length > 0) {
      collectEdges(
        toAssetUuid,
        nested,
        edgeDepth + 1,
        [...path, toAssetUuid],
        edges,
        diagnostics,
        nodes,
        documentByAsset
      );
    }
  }
}

/**
 * 把实例 FileID、源对象 FileID 和内联嵌套实例写入 TargetMap。
 *
 * @param map 当前宿主上下文的 TargetMap。
 * @param instance 待登记的 Prefab 实例。
 * @param diagnostics FileID 冲突诊断收集器。
 * @param ownerAssetUuid 当前 TargetMap 所属资产 UUID。
 */
function addInstanceTarget(
  map: PrefabTargetMap,
  instance: PrefabInstanceInput,
  diagnostics: PrefabGraphDiagnostic[],
  ownerAssetUuid: string
): void {
  const sourceObjectFileId = instance.sourceObjectFileId;
  if (!sourceObjectFileId) return;
  const target: PrefabTarget = {
    assetUuid: instance.sourceAssetUuid,
    fileId: sourceObjectFileId,
    nodePath: instance.hostNodePath ?? null
  };
  addTarget(map, sourceObjectFileId, target, diagnostics, ownerAssetUuid);
  if (instance.instanceFileId) addTarget(map, instance.instanceFileId, target, diagnostics, ownerAssetUuid);
  const childMap = map.children[sourceObjectFileId] ?? createTargetMap();
  map.children[sourceObjectFileId] = childMap;
  if (instance.instanceFileId) map.children[instance.instanceFileId] = childMap;
  for (const nested of readInstances(instance)) {
    addInstanceTarget(childMap, nested, diagnostics, ownerAssetUuid);
  }
}

/**
 * 向 TargetMap 登记单个 FileID，并保留映射冲突诊断。
 *
 * @param map 当前宿主上下文的 TargetMap。
 * @param key 用作索引的源对象或实例 FileID。
 * @param target FileID 对应的稳定资产目标。
 * @param diagnostics FileID 冲突诊断收集器。
 * @param ownerAssetUuid 当前 TargetMap 所属资产 UUID。
 */
function addTarget(
  map: PrefabTargetMap,
  key: string,
  target: PrefabTarget,
  diagnostics: PrefabGraphDiagnostic[],
  ownerAssetUuid: string
): void {
  const existing = map.targets[key];
  if (existing && (existing.assetUuid !== target.assetUuid || existing.fileId !== target.fileId)) {
    diagnostics.push({
      code: 'PREFAB_TARGET_MAP_COLLISION',
      message: `Prefab localID ${key} 在 ${ownerAssetUuid} 中映射冲突`,
      severity: 'warning',
      details: { existing, target }
    });
    return;
  }
  map.targets[key] = target;
}

/**
 * 汇总当前实例的 Property、Target、挂载和移除覆盖数量。
 *
 * @param instance 待统计的 Prefab 实例。
 * @returns 可直接写入来源边的 Override 摘要。
 */
function summarizeOverrides(instance: PrefabInstanceInput): PrefabOverrideSummary {
  return {
    propertyOverrideCount: instance.propertyOverrides?.length ?? 0,
    targetOverrideCount: instance.targetOverrides?.length ?? 0,
    mountedChildrenCount: instance.mountedChildren?.length ?? 0,
    mountedComponentsCount: instance.mountedComponents?.length ?? 0,
    removedComponentsCount: instance.removedComponents?.length ?? 0
  };
}

/**
 * 按规范化优先级读取文档或实例包含的子实例数组。
 *
 * @param value 可能包含 instances、prefabInstances 或 nestedInstances 的对象。
 * @returns 当前对象直接包含的 Prefab 实例数组。
 */
function readInstances(value: { instances?: PrefabInstanceInput[]; prefabInstances?: PrefabInstanceInput[]; nestedInstances?: PrefabInstanceInput[] }): PrefabInstanceInput[] {
  if (Array.isArray(value.nestedInstances)) return value.nestedInstances;
  if (Array.isArray(value.prefabInstances)) return value.prefabInstances;
  if (Array.isArray(value.instances)) return value.instances;
  return [];
}

/**
 * 创建空的可序列化 TargetMap。
 *
 * @returns 不包含目标和子映射的新 TargetMap。
 */
function createTargetMap(): PrefabTargetMap {
  return { targets: {}, children: {} };
}

/**
 * 深复制未展开的 TargetMap，隔离后续跨文档合并产生的修改。
 *
 * @param source 待复制的直接 TargetMap。
 * @returns 与源内容一致但不共享对象引用的新 TargetMap。
 */
function cloneTargetMap(source: PrefabTargetMap): PrefabTargetMap {
  return {
    targets: Object.fromEntries(
      Object.entries(source.targets).map(([fileId, target]) => [fileId, { ...target }])
    ),
    children: Object.fromEntries(
      Object.entries(source.children).map(([fileId, child]) => [fileId, cloneTargetMap(child)])
    )
  };
}
