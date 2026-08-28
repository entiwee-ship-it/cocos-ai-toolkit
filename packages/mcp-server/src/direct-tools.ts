import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DocumentWriteOperationSchema,
  DirectWriteOutcomeSchema,
  LocalTransformSchema,
  type DocumentWriteOperation,
  type LocalTransform,
  type WriteOperation
} from '@cocos-ai/protocol';
import { z } from 'zod';
import {
  CocosReadonlyToolService,
  type CocosReadonlyToolServiceOptions,
  type EditorSession
} from './tools.js';

const ProjectSelectorInput = {
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional()
};

/** 节点寻址：会话 UUID 或当前文档内路径（Root/Panel/Button 形式，可带前导斜杠）。 */
const NodeAddressInput = {
  nodeUuid: z.string().min(1).optional(),
  path: z.string().min(1).optional()
};

const PrefabNameSchema = z.string().trim().min(1, 'PREFAB_NAME_INVALID').refine(
  (name) => !name.includes('/') && !name.includes('\\') && !name.toLowerCase().endsWith('.prefab'),
  'PREFAB_NAME_INVALID'
);

const BATCH_WRITE_ALLOWED_OPERATION_TYPES = new Set<DocumentWriteOperation['type']>([
  'node.create',
  'node.delete',
  'node.rename',
  'node.reparent',
  'node.duplicate',
  'node.set_active',
  'node.set_layer',
  'node.set_transform',
  'component.add',
  'component.remove',
  'component.enable',
  'component.set_property',
  'component.set_reference',
  'component.clear_reference',
  'component.resize_array'
]);

function assertExclusiveNodeAddress(address: NodeAddress, fieldName = 'NODE_ADDRESS'): void {
  const hasUuid = Boolean(address.nodeUuid);
  const hasPath = Boolean(address.path);
  if (hasUuid === hasPath) {
    throw new Error(`NODE_ADDRESS_EXCLUSIVE:${fieldName}`);
  }
}

const ToolOutputSchema = z.looseObject({});

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false
} as const;

const DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true
} as const;

export const COCOS_DIRECT_READONLY_TOOL_NAMES = [
  'cocos_editor_list',
  'cocos_editor_state',
  'cocos_asset_search',
  'cocos_asset_inspect',
  'cocos_hierarchy',
  'cocos_node_read',
  'cocos_nodes_read',
  'cocos_prefab_open',
  'cocos_scene_open'
] as const;

export const COCOS_DIRECT_WRITE_TOOL_NAMES = [
  'cocos_node_create',
  'cocos_node_rename',
  'cocos_node_set_transform',
  'cocos_node_select',
  'cocos_node_reparent',
  'cocos_node_delete',
  'cocos_component_add',
  'cocos_component_set_property',
  'cocos_prefab_instantiate',
  'cocos_prefab_unpack',
  'cocos_prefab_create',
  'cocos_prefab_rename',
  'cocos_document_save',
  'cocos_prefab_delete',
  'cocos_asset_import',
  'cocos_asset_refresh',
  'cocos_batch_write'
] as const;

interface ProjectSelector {
  projectId: string;
  editorInstanceId?: string;
}

interface NodeAddress {
  nodeUuid?: string;
  path?: string;
}

interface NodeReadInput extends NodeAddress {
  componentType?: string;
  includeRaw?: boolean;
  fields?: string[];
  propertyPaths?: string[];
  summary?: boolean;
  includeBounds?: boolean;
  includeDescendantVisualUnion?: boolean;
  relativeToPath?: string;
}

interface ResolvedNodeBoundsInput {
  includeBounds: true;
  includeDescendantVisualUnion?: boolean;
  relativeToUuid?: string;
  relativeToPath?: string;
}

const MAX_NODE_BATCH_ITEMS = 32;
const DEFAULT_NODE_BATCH_OUTPUT_BYTES = 512 * 1024;

/**
 * 直写场景工具服务：每个写工具映射为一到多个原子写操作，
 * 经 probe.directWrite 一次调用完成执行 + 保存 + 逐项重读验证。
 * 无事务、无回滚；失败即停，已生效的修改保留在文档中。
 */
export class CocosDirectToolService {
  constructor(
    private readonly options: CocosReadonlyToolServiceOptions,
    private readonly readonlyService: CocosReadonlyToolService
  ) {}

  async listEditors() {
    return { editors: await this.readonlyService.listEditors() };
  }

  async readEditorState(input: ProjectSelector) {
    return this.readonlyService.readEditorState(input);
  }

  async searchAssets(input: ProjectSelector & {
    pattern: string;
    pageSize?: number;
    cursor?: string;
    includeRaw?: boolean;
  }) {
    return this.readonlyService.searchAssets(input);
  }

  async inspectAsset(input: ProjectSelector & {
    uuid: string;
    pageSize?: number;
    cursor?: string;
    includeRaw?: boolean;
  }) {
    return this.readonlyService.inspectAsset(input);
  }

  async readHierarchy(input: ProjectSelector & {
    depth?: number;
    rootPath?: string;
    query?: string;
    fields?: string[];
    summary?: boolean;
  }) {
    assertProjectionFieldsSafe(input.fields);
    if (input.rootPath) {
      const editor = await this.readonlyService.resolveEditor(input);
      const root = await this.resolveNodeAddress(editor, { path: input.rootPath }, {
        notFoundCode: 'HIERARCHY_ROOT_NOT_FOUND',
        ambiguousCode: 'HIERARCHY_ROOT_AMBIGUOUS'
      });
      const result = await this.readonlyService.readHierarchy({
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId,
        depth: input.depth ?? 50,
        rootUuid: root.uuid
      });
      return projectHierarchyResult(result, input, root.path);
    }
    const depth = input.depth ?? (input.rootPath || input.query ? 50 : undefined);
    const result = await this.readonlyService.readHierarchy({ ...input, ...(depth === undefined ? {} : { depth }) });
    if (!usesHierarchyProjection(input)) return result;
    return projectHierarchyResult(result, input);
  }

  /** 读取节点详情；提供 componentType 时返回该组件的完整属性 Schema（改属性前看现值）。 */
  async readNode(input: ProjectSelector & NodeReadInput) {
    assertProjectionFieldsSafe(input.fields);
    if (input.propertyPaths?.length && !input.componentType) {
      throw new Error('PROPERTY_PATHS_REQUIRE_COMPONENT_TYPE');
    }
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    const bounds = await this.resolveNodeBoundsInput(editor, input);
    return this.readResolvedNode(editor, nodeUuid, input, bounds, false);
  }

  /**
   * 批量读取节点，保留输入顺序并隔离单项寻址、组件和投影错误。
   *
   * @param input 项目、UUID/路径数组、统一投影和输出预算。
   * @returns 单一编辑器身份、逐项结果、计数和输出截断状态。
   */
  async readNodes(input: ProjectSelector & NodeReadInput & {
    nodeUuids?: string[];
    paths?: string[];
    maxOutputBytes?: number;
  }) {
    assertProjectionFieldsSafe(input.fields);
    if (input.propertyPaths?.length && !input.componentType) {
      throw new Error('PROPERTY_PATHS_REQUIRE_COMPONENT_TYPE');
    }
    const addresses: NodeAddress[] = [
      ...(input.nodeUuids ?? []).map((nodeUuid) => ({ nodeUuid })),
      ...(input.paths ?? []).map((path) => ({ path }))
    ];
    if (addresses.length === 0) throw new Error('NODE_BATCH_REQUIRED');
    if (addresses.length > MAX_NODE_BATCH_ITEMS) {
      throw new Error(`NODE_BATCH_LIMIT_EXCEEDED:${addresses.length}:max=${MAX_NODE_BATCH_ITEMS}`);
    }
    const editor = await this.readonlyService.resolveEditor(input);
    const bounds = await this.resolveNodeBoundsInput(editor, input);
    const pathEntries = input.paths?.length
      ? flattenHierarchy(readHierarchyRoot((await this.readonlyService.readHierarchy({
          projectId: editor.projectId,
          editorInstanceId: editor.editorInstanceId,
          depth: 50
        })).hierarchy))
      : [];
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_NODE_BATCH_OUTPUT_BYTES;
    const items: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (let requestIndex = 0; requestIndex < addresses.length; requestIndex += 1) {
      const requested = addresses[requestIndex];
      let item: Record<string, unknown>;
      try {
        const nodeUuid = requested.nodeUuid ?? resolveNodePathFromEntries(
          pathEntries,
          requested.path!,
          'NODE_NOT_FOUND',
          'NODE_PATH_AMBIGUOUS'
        ).uuid;
        const result = asRecord(await this.readResolvedNode(editor, nodeUuid, input, bounds, true));
        const { editor: _editor, ...payload } = result;
        item = { requestIndex, requested, nodeUuid, found: true, ...payload };
      } catch (error) {
        item = { requestIndex, requested, nodeUuid: requested.nodeUuid ?? null, found: false, error: toReadError(error) };
      }
      if (estimateToolTransportBytes({ editor, items: [...items, item] }) > maxOutputBytes) {
        truncated = true;
        break;
      }
      items.push(item);
    }
    const found = items.filter((item) => item.found === true).length;
    return {
      editor,
      items,
      count: {
        requested: addresses.length,
        returned: items.length,
        found,
        errors: items.length - found,
        omitted: addresses.length - items.length
      },
      output: {
        maxBytes: maxOutputBytes,
        estimatedTransportBytes: estimateToolTransportBytes({ editor, items }),
        truncated
      }
    };
  }

  private async readResolvedNode(
    editor: EditorSession,
    nodeUuid: string,
    input: ProjectSelector & NodeReadInput,
    bounds: ResolvedNodeBoundsInput | undefined,
    forceProjection: boolean
  ) {
    const { node } = await this.readonlyService.readNode({
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      uuid: nodeUuid,
      ...bounds
    });
    const nodeData = unwrapData(node);
    const prefabInstance = nodeData.prefabInstance ?? null;
    const writeCapabilities = nodeData.writeCapabilities ?? null;
    const nodeBounds = nodeData.bounds;
    if (!input.componentType) {
      const result = {
        editor,
        node,
        prefabInstance,
        writeCapabilities,
        ...(nodeBounds !== undefined ? { bounds: nodeBounds } : {})
      };
      return forceProjection || usesNodeProjection(input) ? projectNodeResult(result, input) : result;
    }
    const componentUuid = this.resolveComponentUuid(node, input.componentType);
    const component = await this.readonlyService.readComponentSchema({
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      uuid: componentUuid,
      includeRaw: input.includeRaw
    });
    const result = {
      editor,
      nodeUuid,
      componentUuid,
      component: component.schema,
      prefabInstance,
      writeCapabilities,
      ...(nodeBounds !== undefined ? { bounds: nodeBounds } : {}),
      ...(component.raw !== undefined ? { raw: component.raw } : {})
    };
    return forceProjection || usesNodeProjection(input) ? projectNodeResult({ ...result, node }, input) : result;
  }

  private async resolveNodeBoundsInput(
    editor: EditorSession,
    input: NodeReadInput
  ): Promise<ResolvedNodeBoundsInput | undefined> {
    const includeBounds = input.includeBounds === true
      || input.includeDescendantVisualUnion === true
      || Boolean(input.relativeToPath);
    if (!includeBounds) return undefined;
    const relativeToUuid = input.relativeToPath
      ? await this.resolveNodeUuid(editor, { path: input.relativeToPath }, 'relativeTo')
      : undefined;
    return {
      includeBounds: true,
      ...(input.includeDescendantVisualUnion === true ? { includeDescendantVisualUnion: true } : {}),
      ...(relativeToUuid ? { relativeToUuid, relativeToPath: input.relativeToPath } : {})
    };
  }

  /** 打开 Prefab 并等待编辑器当前文档身份切换到目标 UUID。 */
  async openPrefab(input: ProjectSelector & { uuid: string }) {
    return this.openDocument(input, 'cc.Prefab', 'ASSET_NOT_PREFAB', 'PREFAB_OPEN_NOT_READY');
  }

  /** 打开 Scene 并等待编辑器当前文档身份切换到目标 UUID。 */
  async openScene(input: ProjectSelector & { uuid: string }) {
    return this.openDocument(input, 'cc.SceneAsset', 'ASSET_NOT_SCENE', 'SCENE_OPEN_NOT_READY');
  }

  private async openDocument(
    input: ProjectSelector & { uuid: string },
    expectedType: 'cc.Prefab' | 'cc.SceneAsset',
    typeError: string,
    readinessError: string
  ) {
    const opened = await this.readonlyService.openAsset(input);
    if (opened.asset.type !== expectedType) {
      throw new Error(`${typeError}:${input.uuid}`);
    }
    const deadline = Date.now() + 5_000;
    do {
      const { state } = await this.readonlyService.readEditorState(input);
      if (state.document.assetUuid === input.uuid && state.ready.scene) {
        return { editor: opened.editor, asset: opened.asset, opened: true as const };
      }
      if (Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`${readinessError}:${input.uuid}`);
  }

  async createNode(input: ProjectSelector & {
    parentUuid?: string;
    parentPath?: string;
    name: string;
    active?: boolean;
    layer?: number;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const parentNodeUuid = await this.resolveNodeUuid(
      editor,
      { nodeUuid: input.parentUuid, path: input.parentPath },
      'parent'
    );
    const operation = {
      type: 'node.create' as const,
      parentNodeUuid,
      name: input.name,
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.layer !== undefined ? { layer: input.layer } : {})
    };
    return this.directWrite(editor, [operation]);
  }

  async renameNode(input: ProjectSelector & NodeAddress & { name: string }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    return this.directWrite(editor, [{ type: 'node.rename' as const, nodeUuid, name: input.name }]);
  }

  async deleteNode(input: ProjectSelector & NodeAddress) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    return this.directWrite(editor, [{ type: 'node.delete' as const, nodeUuid }]);
  }

  /** 修改节点局部位置、旋转或缩放；未提供的分量保持原值。 */
  async setNodeTransform(input: ProjectSelector & NodeAddress & { localTransform: LocalTransform }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    return this.directWrite(editor, [{
      type: 'node.set_transform' as const,
      nodeUuid,
      localTransform: input.localTransform
    }]);
  }

  /** 选择当前文档中的唯一目标节点，不修改文档内容。 */
  async selectNode(input: ProjectSelector & NodeAddress) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    const result = asRecord(await this.readonlyService.requestBridge(editor, 'probe.nodeSelect', { uuid: nodeUuid }));
    if (result.selected !== true) throw new Error(`NODE_SELECTION_VERIFY_FAILED:${nodeUuid}`);
    return { editor, ...result };
  }

  async addComponent(input: ProjectSelector & NodeAddress & {
    componentType: string;
    scriptUuid?: string;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    const operation = {
      type: 'component.add' as const,
      nodeUuid,
      componentType: input.componentType,
      scriptUuid: input.scriptUuid ?? null
    };
    return this.directWrite(editor, [operation]);
  }

  async setComponentProperty(input: ProjectSelector & NodeAddress & {
    componentType: string;
    propertyPath: string;
    value: unknown;
    expectedOldValue?: unknown;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    const { node } = await this.readonlyService.readNode({ ...input, uuid: nodeUuid });
    const componentUuid = this.resolveComponentUuid(node, input.componentType);
    const operation = {
      type: 'component.set_property' as const,
      componentUuid,
      propertyPath: input.propertyPath,
      value: input.value,
      ...(input.expectedOldValue !== undefined ? { expectedOldValue: input.expectedOldValue } : {})
    };
    return this.directWrite(editor, [operation]);
  }

  /** 在父节点下实例化 Prefab，并返回保存重开后的稳定实例身份。 */
  async instantiatePrefab(input: ProjectSelector & {
    prefabUuid: string;
    parentUuid?: string;
    parentPath?: string;
    name?: string;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const parentNodeUuid = await this.resolveNodeUuid(
      editor,
      { nodeUuid: input.parentUuid, path: input.parentPath },
      'parent'
    );
    const result = await this.directWrite(editor, [{
      type: 'prefab.instantiate' as const,
      prefabAssetUuid: input.prefabUuid,
      parentNodeUuid,
      ...(input.name ? { name: input.name } : {})
    }]);
    const verification = result.outcome.verification;
    const verificationItem = verification?.items.find((item) => item.operationIndex === 0);
    const actual = asRecord(verificationItem?.actual);
    const evidence = Array.isArray(result.outcome.evidence)
      ? asRecord(result.outcome.evidence[0])
      : {};
    const enrichedOperation = asRecord(evidence.operation);
    const nodeUuid = readNonEmptyString(actual.nodeUuid)
      ?? readNonEmptyString(enrichedOperation.resultNodeUuid);
    const prefabAssetUuid = readNonEmptyString(actual.prefabAssetUuid)
      ?? readNonEmptyString(enrichedOperation.resultPrefabAssetUuid);
    const instanceFileId = readNonEmptyString(actual.instanceFileId)
      ?? readNonEmptyString(enrichedOperation.resultPrefabInstanceFileId);
    const stablePath = readNonEmptyString(actual.stablePath)
      ?? readNonEmptyString(enrichedOperation.resultNodeStablePath);
    if (!nodeUuid || prefabAssetUuid !== input.prefabUuid || !instanceFileId || !stablePath || !verification) {
      throw new Error(`PREFAB_INSTANTIATE_RESULT_INVALID:${JSON.stringify({
        nodeUuid,
        prefabAssetUuid,
        instanceFileId,
        stablePath,
        verification: verification ?? null
      })}`);
    }
    return {
      ...result,
      nodeUuid,
      prefabAssetUuid,
      instanceFileId,
      stablePath,
      verification
    };
  }

  /** 移除当前或完整 Prefab 关联，并返回保存重开后的节点身份。 */
  async unpackPrefab(input: ProjectSelector & NodeAddress & {
    mode: 'current' | 'complete';
    expectedPrefabAssetUuid: string;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const oldNodeUuid = await this.resolveNodeUuid(editor, input);
    const result = await this.directWrite(editor, [{
      type: 'prefab.unlink_instance' as const,
      instanceRootUuid: oldNodeUuid,
      removeNested: input.mode === 'complete',
      expectedPrefabAssetUuid: input.expectedPrefabAssetUuid
    }]);
    const verification = result.outcome.verification;
    const verificationItem = verification?.items.find((item) => item.operationIndex === 0);
    const actual = asRecord(verificationItem?.actual);
    const evidence = Array.isArray(result.outcome.evidence)
      ? asRecord(result.outcome.evidence[0])
      : {};
    const enrichedOperation = asRecord(evidence.operation);
    const nodeUuid = readNonEmptyString(actual.nodeUuid) ?? oldNodeUuid;
    const stablePath = readNonEmptyString(actual.stablePath)
      ?? readNonEmptyString(enrichedOperation.resultNodeStablePath);
    if (!nodeUuid || !stablePath || !verification) {
      throw new Error(`PREFAB_UNPACK_RESULT_INVALID:${JSON.stringify({
        oldNodeUuid,
        nodeUuid,
        stablePath,
        verification: verification ?? null
      })}`);
    }
    return {
      ...result,
      oldNodeUuid,
      nodeUuid,
      uuidChanged: nodeUuid !== oldNodeUuid,
      stablePath,
      mode: input.mode,
      verification
    };
  }

  /** 将现有节点迁移到新父节点，保留节点 UUID，可选指定兄弟顺序。 */
  async reparentNode(input: ProjectSelector & NodeAddress & {
    newParentUuid?: string;
    newParentPath?: string;
    siblingIndex?: number;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    const newParentUuid = await this.resolveNodeUuid(editor, {
      nodeUuid: input.newParentUuid,
      path: input.newParentPath
    }, 'newParent');
    if (nodeUuid === newParentUuid) {
      throw new Error('REPARENT_CYCLE:self');
    }
    const operation = {
      type: 'node.reparent' as const,
      nodeUuid,
      newParentUuid,
      ...(input.siblingIndex === undefined ? {} : { siblingIndex: input.siblingIndex })
    };
    return this.directWrite(editor, [operation]);
  }

  /** 从当前文档节点生成 Prefab 资产。 */
  async createPrefab(input: ProjectSelector & {
    assetUrl: string;
    sourceNodeUuid?: string;
    sourcePath?: string;
  }) {
    assertAssetUrl(input.assetUrl, '.prefab');
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(
      editor,
      { nodeUuid: input.sourceNodeUuid, path: input.sourcePath },
      'sourceNode'
    );
    const result = await this.readonlyService.requestBridge(editor, 'probe.createPrefab', {
      nodeUuid,
      assetUrl: input.assetUrl
    });
    return { editor, result };
  }

  /** 通过 Creator AssetDB 在原目录内重命名 Prefab，并保持原 UUID。 */
  async renamePrefab(input: ProjectSelector & { uuid: string; newName: string }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const inspected = await this.readonlyService.inspectAsset({ ...input, pageSize: 1 });
    if (inspected.asset.type !== 'cc.Prefab') {
      throw new Error(`ASSET_NOT_PREFAB:${input.uuid}`);
    }
    const sourceUrl = inspected.asset.url ?? inspected.asset.path;
    if (!sourceUrl) throw new Error(`ASSET_URL_UNAVAILABLE:${input.uuid}`);
    assertAssetUrl(sourceUrl, '.prefab');
    const newName = PrefabNameSchema.parse(input.newName);
    const targetUrl = `${sourceUrl.slice(0, sourceUrl.lastIndexOf('/') + 1)}${newName}.prefab`;
    const result = await this.directWrite(editor, [{
      type: 'asset.move' as const,
      sourceUrl,
      targetUrl,
      expectedAssetUuid: input.uuid
    }]);
    return { ...result, assetUuid: input.uuid, sourceUrl, targetUrl };
  }

  /** 保存当前文档。 */
  async saveDocument(input: ProjectSelector) {
    const editor = await this.readonlyService.resolveEditor(input);
    const result = await this.readonlyService.requestBridge(editor, 'probe.saveDocument', {});
    return { editor, result };
  }

  /** 删除 Prefab 资产；要求精确 URL 确认，存在引用时要求二次确认。 */
  async deletePrefab(input: ProjectSelector & {
    uuid: string;
    confirmAssetUrl?: string;
    confirmReferenced?: boolean;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    let cursor: string | undefined;
    let inspected: Awaited<ReturnType<CocosReadonlyToolService['inspectAsset']>> | null = null;
    const users = new Set<string>();
    const dependencies = new Set<string>();
    const unresolved: Array<{ path: string; reason: string }> = [];
    do {
      const page = await this.readonlyService.inspectAsset({ ...input, pageSize: 500, ...(cursor ? { cursor } : {}) });
      inspected ??= page;
      for (const relation of page.page.items) {
        (relation.kind === 'user' ? users : dependencies).add(relation.assetUuid);
      }
      unresolved.push(...page.unresolved);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    if (!inspected) throw new Error(`ASSET_NOT_FOUND:${input.uuid}`);
    const assetUrl = inspected.asset.url ?? inspected.asset.path;
    if (!assetUrl) throw new Error(`ASSET_URL_UNAVAILABLE:${input.uuid}`);
    if (inspected.asset.type !== 'cc.Prefab') {
      throw new Error(`ASSET_NOT_PREFAB:${input.uuid}`);
    }
    if (input.confirmAssetUrl !== assetUrl) {
      throw new Error(`PREFAB_DELETE_CONFIRMATION_REQUIRED:${JSON.stringify({ assetUrl })}`);
    }
    const userQueryFailures = unresolved.filter((item) => item.path === 'query-asset-users');
    if (userQueryFailures.length) {
      throw new Error(`PREFAB_REFERENCES_UNRESOLVED:${JSON.stringify(userQueryFailures)}`);
    }
    const referencedBy = [...users].sort();
    if (referencedBy.length && input.confirmReferenced !== true) {
      throw new Error(`PREFAB_REFERENCES_CONFIRMATION_REQUIRED:${JSON.stringify({
        assetUrl,
        userCount: referencedBy.length,
        users: referencedBy
      })}`);
    }
    const result = await this.readonlyService.requestBridge(editor, 'probe.deleteAsset', { assetUrl });
    return {
      editor,
      assetUrl,
      references: { users: referencedBy, dependencies: [...dependencies].sort() },
      result
    };
  }

  /** 导入外部文件为项目资产并触发 AssetDB 导入。 */
  async importAsset(input: ProjectSelector & { sourceFilePath: string; assetUrl: string }) {
    assertAssetUrl(input.assetUrl);
    const editor = await this.readonlyService.resolveEditor(input);
    const result = await this.readonlyService.requestBridge(editor, 'probe.importAsset', {
      sourceFilePath: input.sourceFilePath,
      assetUrl: input.assetUrl
    });
    return { editor, result };
  }

  /** 重新导入资产并尝试驱动 TypeScript 编译。 */
  async refreshAsset(input: ProjectSelector & { assetUrl: string }) {
    assertAssetUrl(input.assetUrl);
    const editor = await this.readonlyService.resolveEditor(input);
    const result = await this.readonlyService.requestBridge(editor, 'probe.refreshAsset', {
      assetUrl: input.assetUrl
    });
    return { editor, result };
  }

  /**
   * 一次直写请求执行多项协议操作。它只减少 MCP 往返，不提供事务或回滚；
   * 任一操作失败时，executedOps 之前的修改可能已经保存。
   */
  async batchWrite(input: ProjectSelector & { operations: DocumentWriteOperation[] }) {
    const blockedTypes = [...new Set(
      input.operations
        .map((operation) => operation.type)
        .filter((type) => !BATCH_WRITE_ALLOWED_OPERATION_TYPES.has(type))
    )];
    if (blockedTypes.length) {
      throw new Error(`BATCH_WRITE_OPERATION_NOT_ALLOWED:${JSON.stringify(blockedTypes)}`);
    }
    const editor = await this.readonlyService.resolveEditor(input);
    return this.directWrite(editor, input.operations);
  }

  /**
   * 经直写通道执行一批原子写操作：Scene 写执行器逐操作执行、保存文档并逐项重读验证。
   * 操作级失败或重读不符一律抛错，错误文本携带失败明细。
   */
  private async directWrite(
    editor: EditorSession,
    operations: WriteOperation[]
  ) {
    const raw = await this.readonlyService.requestBridge(editor, 'probe.directWrite', {
      operations,
      save: true
    });
    const parsed = DirectWriteOutcomeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`DIRECT_WRITE_OUTCOME_INVALID:${parsed.error.message}`);
    }
    const outcome = parsed.data;
    if (outcome.kind === 'unknown') {
      if (!outcome.failure) {
        throw new Error('DIRECT_WRITE_OUTCOME_INVALID:MISSING_FAILURE');
      }
      throw new Error(`DIRECT_WRITE_OUTCOME_UNKNOWN:${JSON.stringify({
        executedOps: outcome.executedOps,
        failure: outcome.failure,
        evidence: outcome.evidence ?? {}
      })}`);
    }
    if (outcome.kind === 'operation-failed') {
      if (!outcome.failure) {
        throw new Error('DIRECT_WRITE_OUTCOME_INVALID:MISSING_FAILURE');
      }
      throw new Error(`DIRECT_WRITE_OPERATION_FAILED:${JSON.stringify({
        executedOps: outcome.executedOps,
        failure: outcome.failure,
        evidence: outcome.evidence ?? {}
      })}`);
    }
    const verification = outcome.verification;
    const expectedIndexes = operations.map((_, index) => index);
    const actualIndexes = verification?.items.map((item) => item.operationIndex).sort((left, right) => left - right) ?? [];
    const verificationComplete = Boolean(
      verification
      && verification.passed
      && outcome.executedOps === operations.length
      && verification.items.length === operations.length
      && verification.items.every((item) => item.passed)
      && actualIndexes.length === expectedIndexes.length
      && actualIndexes.every((value, index) => value === expectedIndexes[index])
    );
    if (!verificationComplete) {
      throw new Error(`DIRECT_WRITE_VERIFY_FAILED:${JSON.stringify({
        expectedOps: operations.length,
        executedOps: outcome.executedOps,
        verification: verification ?? null,
        evidence: outcome.evidence ?? {}
      })}`);
    }
    return { editor, outcome };
  }

  /**
   * 解析节点寻址：优先直接使用会话 UUID；否则按路径在当前文档层级树中查找。
   * 路径支持 Root/A/B 与 /Root/A/B 形式；多个匹配或零匹配都抛错并给出候选。
   */
  private async resolveNodeUuid(
    editor: EditorSession,
    address: NodeAddress,
    fieldName = 'NODE_ADDRESS'
  ): Promise<string> {
    return (await this.resolveNodeAddress(editor, address, { fieldName })).uuid;
  }

  private async resolveNodeAddress(
    editor: EditorSession,
    address: NodeAddress,
    options: {
      fieldName?: string;
      notFoundCode?: string;
      ambiguousCode?: string;
    } = {}
  ): Promise<{ uuid: string; path: string | null }> {
    assertExclusiveNodeAddress(address, options.fieldName ?? 'NODE_ADDRESS');
    if (address.nodeUuid) return { uuid: address.nodeUuid, path: null };
    if (!address.path) throw new Error('NODE_ADDRESS_REQUIRED');
    const { hierarchy } = await this.readonlyService.readHierarchy({
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      depth: 50
    });
    return resolveNodePathFromEntries(
      flattenHierarchy(readHierarchyRoot(hierarchy)),
      address.path,
      options.notFoundCode ?? 'NODE_NOT_FOUND',
      options.ambiguousCode ?? 'NODE_PATH_AMBIGUOUS'
    );
  }

  /**
   * 在节点详情的组件清单中按类型解析组件 UUID。
   * 类型匹配兼容 cc. 前缀（Label 与 cc.Label 等价）；零匹配给出可用组件清单。
   */
  private resolveComponentUuid(node: unknown, componentType: string): string {
    const record = node && typeof node === 'object' && !Array.isArray(node)
      ? node as Record<string, unknown>
      : {};
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : record;
    const components = Array.isArray(data.components) ? data.components : [];
    const candidates: Array<{ uuid: string; className: string }> = [];
    for (const component of components) {
      const entry = component && typeof component === 'object' && !Array.isArray(component)
        ? component as Record<string, unknown>
        : {};
      const identity = entry.identity && typeof entry.identity === 'object'
        ? entry.identity as Record<string, unknown>
        : {};
      const klass = entry.class && typeof entry.class === 'object'
        ? entry.class as Record<string, unknown>
        : {};
      const className = typeof klass.className === 'string'
        ? klass.className
        : typeof klass.typeId === 'string' ? klass.typeId : '';
      if (typeof identity.objectUuid !== 'string' || !identity.objectUuid) continue;
      if (componentTypeMatches(className, componentType)) {
        candidates.push({ uuid: identity.objectUuid, className });
      }
    }
    if (candidates.length === 0) {
      const available = components
        .map((component) => {
          const entry = component && typeof component === 'object' && !Array.isArray(component)
            ? component as Record<string, unknown>
            : {};
          const klass = entry.class && typeof entry.class === 'object'
            ? entry.class as Record<string, unknown>
            : {};
          return typeof klass.className === 'string' ? klass.className : null;
        })
        .filter((name): name is string => Boolean(name));
      throw new Error(`COMPONENT_NOT_FOUND:${componentType}:available=${JSON.stringify(available)}`);
    }
    if (candidates.length > 1) {
      throw new Error(`COMPONENT_AMBIGUOUS:${componentType}:count=${candidates.length}`);
    }
    return candidates[0].uuid;
  }
}

interface HierarchyProjectionInput {
  rootPath?: string;
  query?: string;
  fields?: string[];
  summary?: boolean;
}

interface NodeProjectionInput {
  fields?: string[];
  propertyPaths?: string[];
  summary?: boolean;
}

function usesHierarchyProjection(input: HierarchyProjectionInput): boolean {
  return Boolean(input.rootPath || input.query || input.fields?.length || input.summary === true);
}

function usesNodeProjection(input: NodeProjectionInput): boolean {
  return Boolean(input.fields?.length || input.propertyPaths?.length || input.summary === true);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function toReadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(':');
  return {
    code: separator > 0 ? message.slice(0, separator) : message || 'NODE_READ_FAILED',
    message
  };
}

function estimateToolTransportBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') * 2;
}

const RAW_VALUE_FIELDS = new Set(['currentValue', 'defaultValue', 'value', 'expectedOldValue']);
const FORBIDDEN_FIELD_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD_PATH_PATTERN = /^[^.[\]]+(?:(?:\.[^.[\]]+)|(?:\[\d+\]))*$/;

function assertProjectionFieldsSafe(fields?: string[]): void {
  for (const field of fields ?? []) {
    const segments = pathSegments(field);
    if (
      !FIELD_PATH_PATTERN.test(field)
      || !segments.length
      || segments.some((segment) => typeof segment === 'string' && FORBIDDEN_FIELD_SEGMENTS.has(segment))
    ) {
      throw new Error(`FIELD_PATH_FORBIDDEN:${field}`);
    }
  }
}

/** 紧凑返回移除结构元数据 raw，但保留 Inspector 业务值内部合法的 raw 字段。 */
function stripRawDeep(value: unknown, preserveRaw = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stripRawDeep(item, preserveRaw));
  if (!value || typeof value !== 'object') return value;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'raw' && !preserveRaw) continue;
    output[key] = stripRawDeep(nested, preserveRaw || RAW_VALUE_FIELDS.has(key));
  }
  return output;
}

function pathSegments(propertyPath: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const match of propertyPath.matchAll(/([^[.\]]+)|\[(\d+)\]/g)) {
    if (match[1]) segments.push(match[1]);
    else if (match[2]) segments.push(Number(match[2]));
  }
  return segments;
}

function readPath(value: unknown, propertyPath: string): { found: boolean; value?: unknown } {
  let current = value;
  for (const segment of pathSegments(propertyPath)) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return { found: false };
      current = current[segment];
      continue;
    }
    if (
      !current
      || typeof current !== 'object'
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

type ProjectionContainer = Record<string, unknown> | unknown[];

function writePath(target: Record<string, unknown>, propertyPath: string, value: unknown): void {
  const segments = pathSegments(propertyPath);
  if (!segments.length) return;
  if (typeof segments[0] === 'number') throw new Error(`FIELD_PATH_INVALID:${propertyPath}`);
  let current: ProjectionContainer = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === segments.length - 1) {
      if (typeof segment === 'number') {
        if (!Array.isArray(current)) throw new Error(`FIELD_PATH_INVALID:${propertyPath}`);
        current[segment] = value;
      } else {
        if (Array.isArray(current)) throw new Error(`FIELD_PATH_INVALID:${propertyPath}`);
        current[segment] = value;
      }
      return;
    }
    const wantsArray = typeof segments[index + 1] === 'number';
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) throw new Error(`FIELD_PATH_INVALID:${propertyPath}`);
      const next = Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined;
      if (!next || typeof next !== 'object' || Array.isArray(next) !== wantsArray) {
        current[segment] = wantsArray ? [] : Object.create(null);
      }
      current = current[segment] as ProjectionContainer;
    } else {
      if (Array.isArray(current)) throw new Error(`FIELD_PATH_INVALID:${propertyPath}`);
      const next = Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined;
      if (!next || typeof next !== 'object' || Array.isArray(next) !== wantsArray) {
        current[segment] = wantsArray ? [] : Object.create(null);
      }
      current = current[segment] as ProjectionContainer;
    }
  }
}

function pickFields(value: Record<string, unknown>, fields: string[], always: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = { ...always };
  for (const field of fields) {
    const selected = readPath(value, field);
    const preserveRaw = pathSegments(field).some((segment) => (
      typeof segment === 'string' && RAW_VALUE_FIELDS.has(segment)
    ));
    if (selected.found) writePath(output, field, stripRawDeep(selected.value, preserveRaw));
  }
  return output;
}

function componentLabel(component: unknown): string {
  const record = asRecord(component);
  const klass = asRecord(record.class);
  return String(klass.className || klass.typeId || record.type || record.name || '');
}

function compactHierarchyComponent(component: unknown): unknown {
  const record = asRecord(stripRawDeep(component));
  return {
    ...(record.identity !== undefined ? { identity: record.identity } : {}),
    ...(record.class !== undefined ? { class: record.class } : {}),
    ...(record.enabled !== undefined ? { enabled: record.enabled } : {})
  };
}

interface FlatHierarchyNode {
  node: Record<string, unknown>;
  path: string;
}

function flattenHierarchy(root: unknown, parentPath = ''): FlatHierarchyNode[] {
  const record = asRecord(root);
  if (!Object.keys(record).length) return [];
  const name = typeof record.name === 'string' ? record.name : '';
  const declaredPath = typeof record.path === 'string' ? record.path.replace(/^\/+/, '') : '';
  const computedPath = parentPath ? `${parentPath}/${name}` : name;
  const nodePath = declaredPath || computedPath;
  const output: FlatHierarchyNode[] = [{ node: record, path: nodePath }];
  for (const child of Array.isArray(record.children) ? record.children : []) {
    output.push(...flattenHierarchy(child, nodePath));
  }
  return output;
}

function resolveNodePathFromEntries(
  entries: FlatHierarchyNode[],
  path: string,
  notFoundCode: string,
  ambiguousCode: string
): { uuid: string; path: string } {
  const wanted = path.replace(/^\/+/, '');
  const matches = entries.flatMap((entry) => {
    const uuid = readNonEmptyString(asRecord(entry.node.identity).objectUuid);
    return uuid && (entry.path === wanted || entry.path.endsWith(`/${wanted}`))
      ? [{ uuid, path: entry.path }]
      : [];
  });
  if (matches.length === 0) throw new Error(`${notFoundCode}:${path}`);
  if (matches.length > 1) {
    throw new Error(`${ambiguousCode}:${JSON.stringify(matches.map((match) => match.path))}`);
  }
  return matches[0];
}

function rebaseHierarchyPaths(entries: FlatHierarchyNode[], rootPath: string): FlatHierarchyNode[] {
  const sourceRootPath = entries[0]?.path;
  if (!rootPath || !sourceRootPath || sourceRootPath === rootPath) return entries;
  return entries.map((entry) => ({
    ...entry,
    path: entry.path === sourceRootPath
      ? rootPath
      : entry.path.startsWith(`${sourceRootPath}/`)
        ? `${rootPath}${entry.path.slice(sourceRootPath.length)}`
        : entry.path
  }));
}

function hierarchyNodeMatches(entry: FlatHierarchyNode, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  const components = Array.isArray(entry.node.components) ? entry.node.components : [];
  return entry.path.toLowerCase().includes(wanted)
    || String(entry.node.name || '').toLowerCase().includes(wanted)
    || components.some((component) => componentLabel(component).toLowerCase().includes(wanted));
}

function compactHierarchyNode(entry: FlatHierarchyNode, fields?: string[]): Record<string, unknown> {
  const clean = asRecord(stripRawDeep(entry.node));
  clean.path = entry.path;
  if (fields?.length) return pickFields(clean, fields, {
    path: entry.path,
    ...(clean.truncated === true ? { truncated: true } : {})
  });
  const components = Array.isArray(clean.components) ? clean.components : [];
  return {
    ...(clean.identity !== undefined ? { identity: clean.identity } : {}),
    ...(clean.name !== undefined ? { name: clean.name } : {}),
    path: entry.path,
    ...(clean.active !== undefined ? { active: clean.active } : {}),
    ...(clean.layer !== undefined ? { layer: clean.layer } : {}),
    ...(clean.truncated === true ? { truncated: true } : {}),
    components: components.map(compactHierarchyComponent)
  };
}

function projectHierarchyResult(
  result: { editor: EditorSession; hierarchy: unknown },
  input: HierarchyProjectionInput,
  nativeRootPath?: string | null
) {
  const allNodes = rebaseHierarchyPaths(
    flattenHierarchy(readHierarchyRoot(result.hierarchy)),
    nativeRootPath ?? ''
  );
  let scopedNodes = allNodes;
  let resolvedRootPath = nativeRootPath ?? allNodes[0]?.path ?? '';
  if (input.rootPath && !nativeRootPath) {
    const wanted = input.rootPath.replace(/^\/+/, '');
    const roots = allNodes.filter((entry) => entry.path === wanted || entry.path.endsWith(`/${wanted}`));
    if (roots.length === 0) {
      throw new Error(`HIERARCHY_ROOT_NOT_FOUND:${input.rootPath}:available=${JSON.stringify(allNodes.slice(0, 30).map((entry) => entry.path))}`);
    }
    if (roots.length > 1) {
      throw new Error(`HIERARCHY_ROOT_AMBIGUOUS:${input.rootPath}:matches=${JSON.stringify(roots.map((entry) => entry.path))}`);
    }
    resolvedRootPath = roots[0].path;
    scopedNodes = allNodes.filter((entry) => entry.path === resolvedRootPath || entry.path.startsWith(`${resolvedRootPath}/`));
  }
  const matchedNodes = input.query
    ? scopedNodes.filter((entry) => hierarchyNodeMatches(entry, input.query!))
    : scopedNodes;
  const componentCount = scopedNodes.reduce(
    (total, entry) => total + (Array.isArray(entry.node.components) ? entry.node.components.length : 0),
    0
  );
  const hierarchy = {
    rootPath: resolvedRootPath,
    query: input.query || null,
    fields: input.fields || null,
    truncated: scopedNodes.some((entry) => entry.node.truncated === true),
    summary: {
      totalNodeCount: allNodes.length,
      scopedNodeCount: scopedNodes.length,
      matchedNodeCount: matchedNodes.length,
      componentCount
    },
    ...(
      input.summary === true && !input.rootPath && !input.query && !input.fields?.length
        ? {}
        : { nodes: matchedNodes.map((entry) => compactHierarchyNode(entry, input.fields)) }
    )
  };
  return stripRawDeep({ editor: result.editor, hierarchy });
}

function unwrapData(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return asRecord(record.data ?? value);
}

function compactNodeData(node: Record<string, unknown>, fields?: string[]): Record<string, unknown> {
  const clean = asRecord(stripRawDeep(node));
  if (fields?.length) return pickFields(clean, fields);
  const components = Array.isArray(clean.components) ? clean.components : [];
  return {
    ...(clean.identity !== undefined ? { identity: clean.identity } : {}),
    ...(clean.name !== undefined ? { name: clean.name } : {}),
    ...(clean.type !== undefined ? { type: clean.type } : {}),
    ...(clean.active !== undefined ? { active: clean.active } : {}),
    ...(clean.layer !== undefined ? { layer: clean.layer } : {}),
    ...(clean.siblingIndex !== undefined ? { siblingIndex: clean.siblingIndex } : {}),
    ...(clean.parentUuid !== undefined ? { parentUuid: clean.parentUuid } : {}),
    ...(clean.childUuids !== undefined ? { childUuids: clean.childUuids } : {}),
    ...(clean.transform !== undefined ? { transform: clean.transform } : {}),
    ...(clean.prefabInstance !== undefined ? { prefabInstance: clean.prefabInstance } : {}),
    ...(clean.writeCapabilities !== undefined ? { writeCapabilities: clean.writeCapabilities } : {}),
    ...(clean.bounds !== undefined ? { bounds: clean.bounds } : {}),
    components: components.map(compactHierarchyComponent),
    ...(clean.unresolved !== undefined ? { unresolved: clean.unresolved } : {})
  };
}

function compactPropertyDescriptor(property: unknown): Record<string, unknown> {
  const record = asRecord(stripRawDeep(property));
  return {
    propertyPath: record.propertyPath,
    currentValue: record.currentValue,
    declaredType: record.declaredType,
    actualType: record.actualType,
    valueKind: record.valueKind,
    readonly: record.readonly,
    visible: record.visible,
    references: record.references
  };
}

function compactComponentSchema(component: unknown, propertyPaths?: string[]): Record<string, unknown> {
  const clean = asRecord(stripRawDeep(component));
  const properties = Array.isArray(clean.properties) ? clean.properties : [];
  let selected = properties;
  if (propertyPaths?.length) {
    const byPath = new Map(properties.map((property) => [String(asRecord(property).propertyPath || ''), property]));
    const missing = propertyPaths.filter((propertyPath) => !byPath.has(propertyPath));
    if (missing.length) {
      throw new Error(`PROPERTY_PATH_NOT_FOUND:${JSON.stringify(missing)}:available=${JSON.stringify(Array.from(byPath.keys()).filter(Boolean).sort())}`);
    }
    selected = propertyPaths.map((propertyPath) => byPath.get(propertyPath));
  } else {
    selected = [];
  }
  return {
    className: clean.className,
    qualifiedName: clean.qualifiedName,
    typeId: clean.typeId,
    scriptUuid: clean.scriptUuid,
    scriptPath: clean.scriptPath,
    componentUuid: clean.componentUuid,
    nodeUuid: clean.nodeUuid,
    nodePath: clean.nodePath,
    propertyCount: properties.length,
    ...(propertyPaths?.length ? { properties: selected.map(compactPropertyDescriptor) } : {})
  };
}

function projectNodeResult(
  result: {
    editor: EditorSession;
    node: unknown;
    nodeUuid?: string;
    componentUuid?: string;
    component?: unknown;
    prefabInstance?: unknown;
    writeCapabilities?: unknown;
    bounds?: unknown;
    raw?: unknown;
  },
  input: NodeProjectionInput
) {
  const node = unwrapData(result.node);
  const components = Array.isArray(node.components) ? node.components : [];
  const summary = {
    name: node.name ?? null,
    nodeUuid: result.nodeUuid || asRecord(node.identity).objectUuid || null,
    childCount: Array.isArray(node.childUuids)
      ? node.childUuids.length
      : (Array.isArray(node.children) ? node.children.length : 0),
    componentCount: components.length,
    componentTypes: components.map(componentLabel).filter(Boolean),
    unresolvedCount: Array.isArray(node.unresolved) ? node.unresolved.length : 0,
    prefabInstance: result.prefabInstance ?? node.prefabInstance ?? null,
    writeCapabilities: result.writeCapabilities ?? node.writeCapabilities ?? null,
    ...(result.component !== undefined ? {
      selectedComponent: String(asRecord(result.component).className || asRecord(result.component).qualifiedName || ''),
      selectedPropertyCount: Array.isArray(asRecord(result.component).properties)
        ? (asRecord(result.component).properties as unknown[]).length
        : 0
    } : {})
  };
  const summaryOnly = input.summary === true && !input.fields?.length && !input.propertyPaths?.length;
  return stripRawDeep({
    editor: result.editor,
    nodeUuid: result.nodeUuid || asRecord(node.identity).objectUuid || null,
    ...(result.componentUuid ? { componentUuid: result.componentUuid } : {}),
    prefabInstance: result.prefabInstance ?? node.prefabInstance ?? null,
    writeCapabilities: result.writeCapabilities ?? node.writeCapabilities ?? null,
    ...(result.bounds !== undefined || node.bounds !== undefined ? { bounds: result.bounds ?? node.bounds } : {}),
    summary,
    ...(!summaryOnly ? { node: compactNodeData(node, input.fields) } : {}),
    ...(result.component !== undefined && !summaryOnly
      ? { component: compactComponentSchema(result.component, input.propertyPaths) }
      : {})
  });
}

/** probe.hierarchy 响应信封解包：优先 data 字段，兼容无信封形状。 */
function readHierarchyRoot(hierarchy: unknown): unknown {
  const record = hierarchy && typeof hierarchy === 'object' && !Array.isArray(hierarchy)
    ? hierarchy as Record<string, unknown>
    : {};
  return record.data ?? hierarchy;
}

function componentTypeMatches(actual: string, wanted: string): boolean {
  if (!actual) return false;
  if (actual === wanted) return true;
  const stripPrefix = (value: string) => value.replace(/^cc\./, '');
  return stripPrefix(actual) === stripPrefix(wanted);
}

function assertAssetUrl(assetUrl: string, extension?: string): void {
  if (!assetUrl.startsWith('db://assets/') || assetUrl.includes('\\') || assetUrl.split('/').includes('..')) {
    throw new Error(`ASSET_URL_INVALID:${assetUrl}`);
  }
  if (extension && !assetUrl.toLowerCase().endsWith(extension)) {
    throw new Error(`ASSET_URL_TYPE_INVALID:${assetUrl}`);
  }
}

/** 注册直写档只读工具。 */
export function registerCocosDirectReadonlyTools(
  server: McpServer,
  service: CocosDirectToolService
): void {
  server.registerTool('cocos_editor_list', {
    description: '列出当前连接 Probe Server 的 Creator；空列表时启动 Creator/Bridge 后重试。',
    inputSchema: {},
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async () => toToolResult(await service.listEditors()));

  server.registerTool('cocos_editor_state', {
    description: '读取目标 Creator 当前文档 UUID、dirty、Scene/AssetDB 就绪状态、选择与 Preview 状态。',
    inputSchema: ProjectSelectorInput,
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readEditorState(input)));

  server.registerTool('cocos_asset_search', {
    description: '在 Creator AssetDB 索引中按文本搜索资产（找 Prefab/脚本 UUID），按 cursor 分页。',
    inputSchema: {
      ...ProjectSelectorInput,
      pattern: z.string().min(1),
      pageSize: z.number().int().min(1).max(200).optional(),
      cursor: z.string().min(1).optional(),
      includeRaw: z.boolean().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.searchAssets(input)));

  server.registerTool('cocos_asset_inspect', {
    description: '按 UUID 读取资产详情、可选原始 Meta、依赖和反向使用者，关系按 cursor 分页。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      pageSize: z.number().int().min(1).max(500).optional(),
      cursor: z.string().min(1).optional(),
      includeRaw: z.boolean().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.inspectAsset(input)));

  server.registerTool('cocos_hierarchy', {
    description: '读取当前文档节点树；rootPath 会先解析 UUID，再由 Creator 原生读取目标子树并保留 truncated。query/fields/summary 可启用紧凑投影，去除结构/信封层重复 raw，但保留 Inspector 业务值内部的 raw。',
    inputSchema: {
      ...ProjectSelectorInput,
      depth: z.number().int().min(1).max(50).optional(),
      rootPath: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      fields: z.array(z.string().min(1)).min(1).optional(),
      summary: z.boolean().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readHierarchy(input)));

  server.registerTool('cocos_node_read', {
    description: '按 nodeUuid 或 path 读取节点详情；缺省保持完整旧返回。fields/propertyPaths/summary 启用紧凑投影：去除结构/信封层重复 raw，但保留 Inspector 业务值内部的 raw；propertyPaths 必须配合 componentType。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      componentType: z.string().min(1).optional(),
      includeRaw: z.boolean().optional(),
      fields: z.array(z.string().min(1)).min(1).optional(),
      propertyPaths: z.array(z.string().min(1)).min(1).optional(),
      summary: z.boolean().optional(),
      includeBounds: z.boolean().optional(),
      includeDescendantVisualUnion: z.boolean().optional(),
      relativeToPath: z.string().min(1).optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readNode(input)));

  server.registerTool('cocos_nodes_read', {
    description: '批量读取最多 32 个节点；nodeUuids 后接 paths，逐项返回 found/error，并统一应用组件、字段和编辑态 bounds 投影。',
    inputSchema: {
      ...ProjectSelectorInput,
      nodeUuids: z.array(z.string().min(1)).max(MAX_NODE_BATCH_ITEMS).optional(),
      paths: z.array(z.string().min(1)).max(MAX_NODE_BATCH_ITEMS).optional(),
      componentType: z.string().min(1).optional(),
      fields: z.array(z.string().min(1)).min(1).optional(),
      propertyPaths: z.array(z.string().min(1)).min(1).optional(),
      summary: z.boolean().optional(),
      includeBounds: z.boolean().optional(),
      includeDescendantVisualUnion: z.boolean().optional(),
      relativeToPath: z.string().min(1).optional(),
      maxOutputBytes: z.number().int().min(16 * 1024).max(2 * 1024 * 1024).optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readNodes(input)));

  server.registerTool('cocos_prefab_open', {
    description: '通过 Creator 打开 Prefab 并等待文档身份就绪；PREFAB_OPEN_NOT_READY 时核对 UUID 后重试。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.openPrefab(input)));

  server.registerTool('cocos_scene_open', {
    description: '通过 Creator 打开 Scene 并等待文档身份就绪；ASSET_NOT_SCENE 时核对 UUID。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.openScene(input)));
}

/** 注册直写档写工具（仅显式 --enable-writes 时可见；每次写入自动保存并逐项重读回显）。 */
export function registerCocosDirectWriteTools(
  server: McpServer,
  service: CocosDirectToolService
): void {
  server.registerTool('cocos_node_create', {
    description: '在父节点下创建节点并保存；parentUuid 或 parentPath 二选一。',
    inputSchema: {
      ...ProjectSelectorInput,
      parentUuid: z.string().min(1).optional(),
      parentPath: z.string().min(1).optional(),
      name: z.string().min(1),
      active: z.boolean().optional(),
      layer: z.number().int().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.createNode(input)));

  server.registerTool('cocos_node_rename', {
    description: '按 nodeUuid 或 path 重命名节点并保存回读；二者必须且只能提供一个。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      name: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.renameNode(input)));

  server.registerTool('cocos_node_set_transform', {
    description: '修改节点局部 position/rotation/scale 并保存回读；nodeUuid 或 path 二选一，至少提供一个 transform 分量。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      localTransform: LocalTransformSchema
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.setNodeTransform(input)));

  server.registerTool('cocos_node_select', {
    description: '按 nodeUuid 或 path 清空旧节点选择并选中唯一目标；不修改或保存文档。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.selectNode(input)));

  server.registerTool('cocos_node_reparent', {
    description: '把现有节点迁移到新父节点并保存；源节点和新父节点分别支持 UUID/路径二选一，可选 siblingIndex。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      newParentUuid: z.string().min(1).optional(),
      newParentPath: z.string().min(1).optional(),
      siblingIndex: z.number().int().nonnegative().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.reparentNode(input)));

  server.registerTool('cocos_node_delete', {
    description: '按 nodeUuid 或 path 删除节点及其子树并保存；不可回滚。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput
    },
    outputSchema: ToolOutputSchema,
    annotations: DELETE_ANNOTATIONS
  }, async (input) => toToolResult(await service.deleteNode(input)));

  server.registerTool('cocos_component_add', {
    description: '在节点上挂载组件并保存；自定义脚本组件必须提供 scriptUuid（可用 cocos_asset_search 查）。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      componentType: z.string().min(1),
      scriptUuid: z.string().min(1).optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.addComponent(input)));

  server.registerTool('cocos_component_set_property', {
    description: '修改节点上某组件的属性值并保存回读；propertyPath 支持 items[2] 嵌套路径；expectedOldValue 不一致时拒绝写入。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      componentType: z.string().min(1),
      propertyPath: z.string().min(1),
      value: z.unknown(),
      expectedOldValue: z.unknown().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.setComponentProperty(input)));

  server.registerTool('cocos_prefab_instantiate', {
    description: '在父节点下实例化 Prefab 并保存重开验证；parentUuid 或 parentPath 二选一，unknown 时先重读当前文档且不要重试。',
    inputSchema: {
      ...ProjectSelectorInput,
      prefabUuid: z.string().min(1),
      parentUuid: z.string().min(1).optional(),
      parentPath: z.string().min(1).optional(),
      name: z.string().min(1).optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.instantiatePrefab(input)));

  server.registerTool('cocos_prefab_unpack', {
    description: '按 nodeUuid 或 path 移除 Prefab 关联；current 仅移除当前关联，complete 递归移除嵌套关联，expectedPrefabAssetUuid 用于锁定源资产。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      mode: z.enum(['current', 'complete']),
      expectedPrefabAssetUuid: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.unpackPrefab(input)));

  server.registerTool('cocos_prefab_create', {
    description: '把当前文档中的节点生成为 Prefab 资产；ASSET_ALREADY_EXISTS 时换 URL。',
    inputSchema: {
      ...ProjectSelectorInput,
      assetUrl: z.string().min(1),
      sourceNodeUuid: z.string().min(1).optional(),
      sourcePath: z.string().min(1).optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.createPrefab(input)));

  server.registerTool('cocos_prefab_rename', {
    description: '按 UUID 在原目录内重命名 Prefab；newName 不含路径或 .prefab 后缀，Creator AssetDB 会保持 UUID 并拒绝覆盖。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      newName: PrefabNameSchema
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.renamePrefab(input)));

  server.registerTool('cocos_document_save', {
    description: '保存当前文档（直写工具已自动保存，此入口用于手工修改后的落盘）。',
    inputSchema: ProjectSelectorInput,
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.saveDocument(input)));

  server.registerTool('cocos_prefab_delete', {
    description: '按 UUID 删除 Prefab 资产；不可回滚。必须传精确 confirmAssetUrl；存在引用时还需 confirmReferenced=true。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      confirmAssetUrl: z.string().min(1).optional(),
      confirmReferenced: z.boolean().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: DELETE_ANNOTATIONS
  }, async (input) => toToolResult(await service.deletePrefab(input)));

  server.registerTool('cocos_asset_import', {
    description: '把磁盘文件（图片/音频等）导入为项目资产并触发 AssetDB 导入；ASSET_ALREADY_EXISTS 时换 URL。',
    inputSchema: {
      ...ProjectSelectorInput,
      sourceFilePath: z.string().min(1),
      assetUrl: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.importAsset(input)));

  server.registerTool('cocos_asset_refresh', {
    description: '重新导入资产并尝试触发 TypeScript 编译；脚本改动后调用。',
    inputSchema: {
      ...ProjectSelectorInput,
      assetUrl: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.refreshAsset(input)));

  server.registerTool('cocos_batch_write', {
    description: '一次请求仅执行多项 node.* / component.* 写操作并保存回读；asset.* / prefab.* 不在公开输入契约内。只减少往返，不提供事务或回滚，失败时 executedOps 之前的修改可能已生效。',
    inputSchema: {
      ...ProjectSelectorInput,
      operations: z.array(DocumentWriteOperationSchema).min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: DELETE_ANNOTATIONS
  }, async (input) => toToolResult(await service.batchWrite(input)));
}

function toToolResult(value: unknown) {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent
  };
}
