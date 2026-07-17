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

  // 第二遍把实例归属到当前扫描文档。源 Prefab 自身的静态嵌套关系由其独立
  // 文档快照提供，不能把其它文档上下文中的嵌套实例回写到共享源 Prefab。
  for (let documentIndex = 0; documentIndex < snapshots.length; documentIndex += 1) {
    const snapshot = snapshots[documentIndex];
    const ownerAssetUuid = snapshot.document.assetUuid;
    if (!ownerAssetUuid || !snapshot.document.documentType) continue;
    const ownerDocument = documentsByAsset.get(ownerAssetUuid);
    if (!ownerDocument) continue;
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
      const instanceFileId = instance.instanceFileId ?? null;
      if (!instanceFileId) {
        diagnostics.push({
          code: 'PREFAB_INSTANCE_FILE_ID_MISSING',
          message: `${ownerAssetUuid} 的第 ${instanceIndex} 个 Prefab 记录缺少实例 FileID，未建立来源边`,
          severity: 'warning',
          details: {
            ownerAssetUuid,
            sourceAssetUuid,
            instanceIndex,
            hostNodePath: instance.hostNodePath ?? null
          }
        });
        continue;
      }
      const chain = instance.instanceChain ?? [];
      let sourceDepth = 1;
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        if (chain[index].assetUuid === sourceAssetUuid) {
          sourceDepth = chain[index].depth;
          break;
        }
      }
      const normalizedInstance: PrefabInstanceInput = {
        sourceAssetUuid,
        depth: sourceDepth,
        instanceRootObjectUuid: instance.instanceRootObjectUuid ?? null,
        instanceFileId,
        sourceObjectFileId: instance.sourceObjectFileId ?? null,
        hostNodePath: instance.hostNodePath ?? null,
        propertyOverrides: instance.propertyOverrides ?? [],
        targetOverrides: instance.targetOverrides ?? [],
        mountedChildren: instance.mountedChildren ?? [],
        mountedComponents: instance.mountedComponents ?? [],
        removedComponents: instance.removedComponents ?? []
      };
      const instances = ownerDocument.instances ?? [];
      const key = createInstanceKey(normalizedInstance);
      if (key === null || !instances.some((candidate) => createInstanceKey(candidate) === key)) {
        instances.push(normalizedInstance);
      }
      ownerDocument.instances = instances;
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

  detectGraphCycles(edges, diagnostics);
  const graph: PrefabGraph = {
    nodes: [...nodes.values()],
    edges,
    targetMaps,
    targetMapsByAsset,
    blocked: false,
    diagnostics
  };
  collectOverrideResolutionDiagnostics(documents, graph, diagnostics);
  graph.blocked = diagnostics.some((diagnostic) =>
    diagnostic.code === 'PREFAB_GRAPH_CYCLE'
    && diagnostic.severity === 'error'
  );
  return graph;
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
 * 使用按资产保存的直接 FileID 索引和 Prefab 来源边逐段解析 localID。
 *
 * 跨资源图只保存每个 Prefab 自己的直接索引；遇到实例段时根据来源边切换到源
 * Prefab，避免把同一源 Prefab 的完整 TargetMap 复制到每个实例路径。
 *
 * @param fromAssetUuid localID 路径所在的宿主 Scene 或 Prefab Asset UUID。
 * @param localIds Creator TargetInfo 中按层级排列的 localID 数组。
 * @param graph 包含直接 TargetMap 和实例来源边的 Prefab 图。
 * @returns 最终稳定目标，或带准确失败段索引的解析结果。
 */
export function resolveGraphTargetPath(
  fromAssetUuid: string,
  localIds: string[],
  graph: Pick<PrefabGraph, 'edges' | 'targetMapsByAsset'>
): PrefabTargetResolution {
  const input = [...localIds];
  if (input.length === 0) {
    return { target: null, localIds: input, failedSegmentIndex: 0 };
  }

  let currentAssetUuid = fromAssetUuid;
  let currentMap = graph.targetMapsByAsset[currentAssetUuid];
  for (let index = 0; index < input.length; index += 1) {
    const localId = input[index];
    if (index === input.length - 1) {
      const target = currentMap?.targets[localId];
      if (!target) {
        return { target: null, localIds: input, failedSegmentIndex: index };
      }
      return {
        target: { assetUuid: target.assetUuid, fileId: target.fileId },
        localIds: input,
        failedSegmentIndex: null
      };
    }

    const nextAssetUuid = resolveTransitionAssetUuid(graph, currentAssetUuid, localId);
    if (!nextAssetUuid) {
      return { target: null, localIds: input, failedSegmentIndex: index };
    }
    currentAssetUuid = nextAssetUuid;
    currentMap = graph.targetMapsByAsset[currentAssetUuid];
    if (!currentMap) {
      return { target: null, localIds: input, failedSegmentIndex: index + 1 };
    }
  }
  return { target: null, localIds: input, failedSegmentIndex: input.length - 1 };
}

interface PrefabTransitionIndex {
  byInstanceFileId: Map<string, Set<string>>;
  bySourceObjectFileId: Map<string, Set<string>>;
}

const transitionIndexCache = new WeakMap<object, PrefabTransitionIndex>();

/**
 * 在当前资产上下文中选择唯一的下一层 Prefab 资源。
 *
 * Creator 3.8.8 的多段 targetInfo.localID 使用 PrefabInstance FileID 作为中间
 * 段。旧样本中的源对象 FileID 仅作为无实例 FileID 命中时的兼容回退；任一索引
 * 指向多个源资源时保持失败，不能按边顺序猜测。
 *
 * @param graph Prefab 图。
 * @param fromAssetUuid 当前解析所在资产 UUID。
 * @param localId 当前中间 localID 段。
 * @returns 唯一下一层资源 UUID；缺失或歧义时返回 null。
 */
function resolveTransitionAssetUuid(
  graph: Pick<PrefabGraph, 'edges' | 'targetMapsByAsset'>,
  fromAssetUuid: string,
  localId: string
): string | null {
  const index = getTransitionIndex(graph);
  const key = createTransitionKey(fromAssetUuid, localId);
  const byInstance = index.byInstanceFileId.get(key);
  if (byInstance && byInstance.size > 0) {
    return byInstance.size === 1 ? [...byInstance][0] : null;
  }
  const bySourceObject = index.bySourceObjectFileId.get(key);
  return bySourceObject?.size === 1 ? [...bySourceObject][0] : null;
}

/**
 * 为单个 Prefab 图建立可复用的实例跳转索引。
 *
 * @param graph 待索引的 Prefab 图。
 * @returns 按宿主资产和 FileID 分组的目标资源集合。
 */
function getTransitionIndex(
  graph: Pick<PrefabGraph, 'edges' | 'targetMapsByAsset'>
): PrefabTransitionIndex {
  const cached = transitionIndexCache.get(graph);
  if (cached) return cached;
  const index: PrefabTransitionIndex = {
    byInstanceFileId: new Map(),
    bySourceObjectFileId: new Map()
  };
  for (const edge of graph.edges) {
    if (edge.instanceFileId) {
      addTransitionTarget(
        index.byInstanceFileId,
        createTransitionKey(edge.fromAssetUuid, edge.instanceFileId),
        edge.toAssetUuid
      );
    }
    if (edge.sourceObjectFileId) {
      addTransitionTarget(
        index.bySourceObjectFileId,
        createTransitionKey(edge.fromAssetUuid, edge.sourceObjectFileId),
        edge.toAssetUuid
      );
    }
  }
  transitionIndexCache.set(graph, index);
  return index;
}

function addTransitionTarget(
  index: Map<string, Set<string>>,
  key: string,
  assetUuid: string
): void {
  const targets = index.get(key) ?? new Set<string>();
  targets.add(assetUuid);
  index.set(key, targets);
}

function createTransitionKey(assetUuid: string, fileId: string): string {
  return `${assetUuid}\u0000${fileId}`;
}

/**
 * 逐条验证 Property Override 的 localID，并把覆盖率和失败段写入图诊断。
 *
 * @param documents 已归一化的文档和实例输入。
 * @param graph 已建立完成的 Prefab 图。
 * @param diagnostics 图诊断收集器。
 */
function collectOverrideResolutionDiagnostics(
  documents: PrefabDocumentInput[],
  graph: PrefabGraph,
  diagnostics: PrefabGraphDiagnostic[]
): void {
  let total = 0;
  let singleSegment = 0;
  let multiSegment = 0;
  let resolved = 0;
  let failed = 0;

  for (const document of documents) {
    const pending = [...readInstances(document)];
    while (pending.length > 0) {
      const instance = pending.shift();
      if (!instance) continue;
      pending.push(...readInstances(instance));
      for (let overrideIndex = 0; overrideIndex < (instance.propertyOverrides?.length ?? 0); overrideIndex += 1) {
        const localIds = readOverrideTargetLocalIds(instance.propertyOverrides?.[overrideIndex]);
        total += 1;
        if (localIds.length === 1) singleSegment += 1;
        if (localIds.length > 1) multiSegment += 1;
        const resolution = resolveGraphTargetPath(instance.sourceAssetUuid, localIds, graph);
        if (resolution.target) {
          resolved += 1;
          continue;
        }
        failed += 1;
        diagnostics.push({
          code: 'PREFAB_TARGET_LOCAL_ID_UNRESOLVED',
          message: `${document.assetUuid} 的 Prefab Override 无法解析 targetInfo.localID`,
          severity: 'warning',
          details: {
            ownerAssetUuid: document.assetUuid,
            sourceAssetUuid: instance.sourceAssetUuid,
            instanceFileId: instance.instanceFileId ?? null,
            hostNodePath: instance.hostNodePath ?? null,
            overrideIndex,
            localIds: resolution.localIds,
            failedSegmentIndex: resolution.failedSegmentIndex
          }
        });
      }
    }
  }

  if (total === 0) return;
  diagnostics.push({
    code: 'PREFAB_TARGET_LOCAL_ID_RESOLUTION_SUMMARY',
    message: `Prefab Override localID 已解析 ${resolved}/${total}`,
    severity: 'info',
    details: { total, singleSegment, multiSegment, resolved, failed }
  });
}

function readOverrideTargetLocalIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const localIds = (value as { targetLocalIds?: unknown }).targetLocalIds;
  if (!Array.isArray(localIds) || !localIds.every((item) => typeof item === 'string')) {
    return [];
  }
  return [...localIds];
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
    if (!instance.instanceFileId) {
      diagnostics.push({
        code: 'PREFAB_INSTANCE_FILE_ID_MISSING',
        message: `${fromAssetUuid} 中指向 ${instance.sourceAssetUuid} 的 Prefab 记录缺少实例 FileID，未建立来源边`,
        severity: 'warning',
        details: {
          ownerAssetUuid: fromAssetUuid,
          sourceAssetUuid: instance.sourceAssetUuid,
          hostNodePath: instance.hostNodePath ?? null
        }
      });
      continue;
    }
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
  const instanceFileId = instance.instanceFileId;
  if (!instanceFileId) return;
  const sourceObjectFileId = instance.sourceObjectFileId ?? instanceFileId;
  const target: PrefabTarget = {
    assetUuid: instance.sourceAssetUuid,
    fileId: sourceObjectFileId,
    nodePath: instance.hostNodePath ?? null
  };
  addTarget(map, instanceFileId, target, diagnostics, ownerAssetUuid);
  const childMap = map.children[instanceFileId] ?? createTargetMap();
  map.children[instanceFileId] = childMap;
  for (const nested of readInstances(instance)) {
    addInstanceTarget(childMap, nested, diagnostics, instance.sourceAssetUuid);
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
