import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DirectWriteOutcomeSchema } from '@cocos-ai/protocol';
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
  'cocos_asset_search',
  'cocos_hierarchy',
  'cocos_node_read',
  'cocos_prefab_open'
] as const;

export const COCOS_DIRECT_WRITE_TOOL_NAMES = [
  'cocos_node_create',
  'cocos_node_delete',
  'cocos_component_add',
  'cocos_component_set_property',
  'cocos_prefab_create',
  'cocos_prefab_save',
  'cocos_prefab_delete',
  'cocos_asset_import',
  'cocos_asset_refresh'
] as const;

interface ProjectSelector {
  projectId: string;
  editorInstanceId?: string;
}

interface NodeAddress {
  nodeUuid?: string;
  path?: string;
}

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

  async searchAssets(input: ProjectSelector & {
    pattern: string;
    pageSize?: number;
    cursor?: string;
    includeRaw?: boolean;
  }) {
    return this.readonlyService.searchAssets(input);
  }

  async readHierarchy(input: ProjectSelector & { depth?: number }) {
    return this.readonlyService.readHierarchy(input);
  }

  /** 读取节点详情；提供 componentType 时返回该组件的完整属性 Schema（改属性前看现值）。 */
  async readNode(input: ProjectSelector & {
    nodeUuid?: string;
    path?: string;
    componentType?: string;
    includeRaw?: boolean;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    const { node } = await this.readonlyService.readNode({ ...input, uuid: nodeUuid });
    if (!input.componentType) return { editor, node };
    const componentUuid = this.resolveComponentUuid(node, input.componentType);
    const component = await this.readonlyService.readComponentSchema({
      ...input,
      uuid: componentUuid,
      includeRaw: input.includeRaw
    });
    return { editor, nodeUuid, componentUuid, component: component.schema, ...(component.raw !== undefined ? { raw: component.raw } : {}) };
  }

  /** 打开 Prefab 并等待编辑器当前文档身份切换到目标 UUID。 */
  async openPrefab(input: ProjectSelector & { uuid: string }) {
    const opened = await this.readonlyService.openAsset(input);
    if (opened.asset.type !== 'cc.Prefab') {
      throw new Error(`ASSET_NOT_PREFAB:${input.uuid}`);
    }
    const deadline = Date.now() + 5_000;
    do {
      const { state } = await this.readonlyService.readEditorState(input);
      if (state.document.assetUuid === input.uuid && state.ready.scene) {
        return { editor: opened.editor, asset: opened.asset, opened: true as const };
      }
      if (Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`PREFAB_OPEN_NOT_READY:${input.uuid}`);
  }

  async createNode(input: ProjectSelector & {
    parentUuid?: string;
    parentPath?: string;
    name: string;
    active?: boolean;
    layer?: number;
  }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const parentNodeUuid = await this.resolveNodeUuid(editor, { nodeUuid: input.parentUuid, path: input.parentPath });
    const operation = {
      type: 'node.create' as const,
      parentNodeUuid,
      name: input.name,
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.layer !== undefined ? { layer: input.layer } : {})
    };
    return this.directWrite(editor, [operation], 'node-create');
  }

  async deleteNode(input: ProjectSelector & NodeAddress) {
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, input);
    return this.directWrite(editor, [{ type: 'node.delete' as const, nodeUuid }], 'node-delete');
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
    return this.directWrite(editor, [operation], 'component-add');
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
    return this.directWrite(editor, [operation], 'component-set-property');
  }

  /** 从当前文档节点生成 Prefab 资产。 */
  async createPrefab(input: ProjectSelector & {
    assetUrl: string;
    sourceNodeUuid?: string;
    sourcePath?: string;
  }) {
    assertAssetUrl(input.assetUrl, '.prefab');
    const editor = await this.readonlyService.resolveEditor(input);
    const nodeUuid = await this.resolveNodeUuid(editor, { nodeUuid: input.sourceNodeUuid, path: input.sourcePath });
    const result = await this.readonlyService.requestBridge(editor, 'probe.createPrefab', {
      nodeUuid,
      assetUrl: input.assetUrl
    });
    return { editor, result };
  }

  /** 保存当前文档。 */
  async savePrefab(input: ProjectSelector) {
    const editor = await this.readonlyService.resolveEditor(input);
    const result = await this.readonlyService.requestBridge(editor, 'probe.saveDocument', {});
    return { editor, result };
  }

  /** 删除 Prefab 资产（不可回滚；不做反向引用检查）。 */
  async deletePrefab(input: ProjectSelector & { uuid: string }) {
    const editor = await this.readonlyService.resolveEditor(input);
    const inspected = await this.readonlyService.inspectAsset({ ...input, pageSize: 1 });
    const assetUrl = inspected.asset.url ?? inspected.asset.path;
    if (!assetUrl) throw new Error(`ASSET_URL_UNAVAILABLE:${input.uuid}`);
    if (inspected.asset.type !== 'cc.Prefab') {
      throw new Error(`ASSET_NOT_PREFAB:${input.uuid}`);
    }
    const result = await this.readonlyService.requestBridge(editor, 'probe.deleteAsset', { assetUrl });
    return { editor, assetUrl, result };
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
   * 经直写通道执行一批原子写操作：Scene 写执行器逐操作执行、保存文档并逐项重读验证。
   * 操作级失败或重读不符一律抛错，错误文本携带失败明细。
   */
  private async directWrite(
    editor: EditorSession,
    operations: Array<Record<string, unknown>>,
    undoLabel: string
  ) {
    const raw = await this.readonlyService.requestBridge(editor, 'probe.directWrite', {
      operations,
      save: true,
      undoGroup: `mcp-direct-${undoLabel}-${randomUUID()}`
    });
    const parsed = DirectWriteOutcomeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`DIRECT_WRITE_OUTCOME_INVALID:${parsed.error.message}`);
    }
    const outcome = parsed.data;
    if (outcome.kind === 'operation-failed') {
      throw new Error(`DIRECT_WRITE_OPERATION_FAILED:${JSON.stringify(outcome.failure)}`);
    }
    if (outcome.verification && !outcome.verification.passed) {
      throw new Error(`DIRECT_WRITE_VERIFY_FAILED:${JSON.stringify(outcome.verification.items)}`);
    }
    return { editor, outcome };
  }

  /**
   * 解析节点寻址：优先直接使用会话 UUID；否则按路径在当前文档层级树中查找。
   * 路径支持 Root/A/B 与 /Root/A/B 形式；多个匹配或零匹配都抛错并给出候选。
   */
  private async resolveNodeUuid(editor: EditorSession, address: NodeAddress): Promise<string> {
    if (address.nodeUuid) return address.nodeUuid;
    if (!address.path) throw new Error('NODE_ADDRESS_REQUIRED');
    const wanted = address.path.replace(/^\/+/, '');
    const { hierarchy } = await this.readonlyService.readHierarchy({
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      depth: 50
    });
    const matches: Array<{ uuid: string; path: string }> = [];
    const visit = (node: unknown, parentPath: string): void => {
      const record = node && typeof node === 'object' && !Array.isArray(node)
        ? node as Record<string, unknown>
        : {};
      const identity = record.identity && typeof record.identity === 'object'
        ? record.identity as Record<string, unknown>
        : {};
      const name = typeof record.name === 'string' ? record.name : '';
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      const declaredPath = typeof record.path === 'string' ? record.path.replace(/^\/+/, '') : '';
      if (
        (fullPath === wanted || declaredPath === wanted || fullPath.endsWith(`/${wanted}`))
        && typeof identity.objectUuid === 'string'
        && identity.objectUuid
      ) {
        matches.push({ uuid: identity.objectUuid, path: fullPath });
      }
      const children = Array.isArray(record.children) ? record.children : [];
      for (const child of children) visit(child, fullPath);
    };
    visit(readHierarchyRoot(hierarchy), '');
    if (matches.length === 0) throw new Error(`NODE_NOT_FOUND:${address.path}`);
    if (matches.length > 1) {
      throw new Error(`NODE_PATH_AMBIGUOUS:${JSON.stringify(matches.map((match) => match.path))}`);
    }
    return matches[0].uuid;
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

  server.registerTool('cocos_hierarchy', {
    description: '读取当前文档节点树（uuid、名称、路径、组件清单），供寻址；depth 默认 4，最大 50。',
    inputSchema: {
      ...ProjectSelectorInput,
      depth: z.number().int().min(1).max(50).optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readHierarchy(input)));

  server.registerTool('cocos_node_read', {
    description: '按 nodeUuid 或 path 读取节点详情；提供 componentType 时返回该组件完整属性（改属性前看现值）。',
    inputSchema: {
      ...ProjectSelectorInput,
      ...NodeAddressInput,
      componentType: z.string().min(1).optional(),
      includeRaw: z.boolean().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readNode(input)));

  server.registerTool('cocos_prefab_open', {
    description: '通过 Creator 打开 Prefab 并等待文档身份就绪；PREFAB_OPEN_NOT_READY 时核对 UUID 后重试。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.openPrefab(input)));
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

  server.registerTool('cocos_prefab_save', {
    description: '保存当前文档（直写工具已自动保存，此入口用于手工修改后的落盘）。',
    inputSchema: ProjectSelectorInput,
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.savePrefab(input)));

  server.registerTool('cocos_prefab_delete', {
    description: '按 UUID 删除 Prefab 资产；不可回滚且不检查引用，删除前确认不再使用。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1)
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
