import { createHash } from 'node:crypto';
import type { CreatorClientStatus } from '@cocos-ai/client';
import { z } from 'zod';
import {
  AssetRecordSchema,
  ComponentTypeSchemaSchema,
  UnresolvedItemSchema
} from '@cocos-ai/protocol';

const SUPPORTED_CREATOR_VERSION = '3.8.8';
const ASSET_SEARCH_PAGE_SIZE_MAX = 200;
const ASSET_INSPECT_PAGE_SIZE_MAX = 500;

/** MCP 侧 Creator 本机直连客户端抽象。 */
export interface ReadonlyCreatorClient {
  request(method: string, payload: unknown): Promise<unknown>;
  getStatus?(): CreatorClientStatus;
}

const EditorSessionSchema = z.object({
  editorInstanceId: z.string().min(1),
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  creatorVersion: z.string().min(1),
  bridgeVersion: z.string().min(1),
  bridgeBuildId: z.string().min(1).optional(),
  capabilities: z.array(z.string())
});

const EditorStateSchema = z.object({
  creatorVersion: z.string().min(1),
  projectPath: z.string().min(1),
  projectId: z.string().min(1),
  document: z.object({
    assetUuid: z.string().nullable(),
    dirty: z.boolean().nullable(),
    // Scene 进程实测身份成功时附带的编辑模式与来源；未解析时缺省。
    mode: z.string().nullable().optional(),
    source: z.string().nullable().optional()
  }),
  ready: z.object({
    scene: z.boolean(),
    assetDatabase: z.boolean()
  }),
  selection: z.object({
    node: z.array(z.string()),
    asset: z.array(z.string())
  }),
  preview: z.unknown().nullable(),
  unresolved: z.array(UnresolvedItemSchema)
}).passthrough();

const EditorStateOutputSchema = z.object({
  editor: EditorSessionSchema,
  state: EditorStateSchema
});

const PublicAssetRecordSchema = AssetRecordSchema.omit({ raw: true }).extend({
  raw: z.unknown().optional()
});

const AssetSearchProbeResponseSchema = z.object({
  assets: z.array(PublicAssetRecordSchema),
  total: z.number().int().nonnegative(),
  revision: z.string().min(1),
  unresolved: z.array(UnresolvedItemSchema)
});

const NormalizedAssetInfoSchema = z.object({
  uuid: z.string().nullable(),
  url: z.string().nullable(),
  file: z.string().nullable(),
  type: z.string().nullable(),
  importer: z.string().nullable(),
  isSubAsset: z.boolean().nullable(),
  isBundle: z.boolean().nullable(),
  name: z.string().nullable(),
  source: z.string().nullable(),
  path: z.string().nullable(),
  displayName: z.string().nullable(),
  imported: z.boolean().nullable(),
  invalid: z.boolean().nullable(),
  isDirectory: z.boolean().nullable(),
  visible: z.boolean().nullable(),
  readonly: z.boolean().nullable(),
  unknownFieldCount: z.number().int().nonnegative(),
  raw: z.record(z.string(), z.unknown())
});

const AssetProbeResponseSchema = z.object({
  assets: z.array(NormalizedAssetInfoSchema),
  details: NormalizedAssetInfoSchema.nullable(),
  meta: z.unknown(),
  dependencies: z.array(z.string()).nullable(),
  users: z.array(z.string()).nullable(),
  unresolved: z.array(z.object({
    path: z.string(),
    reason: z.string()
  }))
});

const PublicNormalizedAssetInfoSchema = NormalizedAssetInfoSchema.omit({ raw: true }).extend({
  raw: z.record(z.string(), z.unknown()).optional()
});

const AssetPageSchema = z.object({
  offset: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  items: z.array(PublicAssetRecordSchema),
  nextCursor: z.string().nullable()
});

const AssetSearchOutputSchema = z.object({
  editor: EditorSessionSchema,
  query: z.object({ pattern: z.string() }),
  page: AssetPageSchema,
  unresolved: z.array(UnresolvedItemSchema)
});

const AssetRelationSchema = z.object({
  kind: z.enum(['dependency', 'user']),
  assetUuid: z.string()
});

const AssetInspectOutputSchema = z.object({
  editor: EditorSessionSchema,
  asset: PublicNormalizedAssetInfoSchema,
  meta: z.unknown().nullable(),
  page: z.object({
    offset: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    items: z.array(AssetRelationSchema),
    nextCursor: z.string().nullable()
  }),
  unresolved: z.array(z.object({ path: z.string(), reason: z.string() }))
});

const AssetOpenProbeResponseSchema = z.object({
  opened: z.literal(true),
  uuid: z.string().min(1)
});

const AssetOpenOutputSchema = z.object({
  editor: EditorSessionSchema,
  asset: PublicAssetRecordSchema,
  opened: z.literal(true)
});

const ComponentProbeResponseSchema = z.object({
  schema: ComponentTypeSchemaSchema,
  raw: z.unknown()
}).passthrough();

const ComponentProbeEnvelopeSchema = z.object({
  data: ComponentProbeResponseSchema,
  raw: z.unknown(),
  source: z.literal('message-api')
});

const ComponentSchemaOutputSchema = z.object({
  editor: EditorSessionSchema,
  schema: ComponentTypeSchemaSchema,
  raw: z.unknown().optional()
});

const CursorSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['asset-search', 'asset-inspect']),
  projectId: z.string(),
  editorInstanceId: z.string(),
  key: z.string(),
  pageSize: z.number().int().positive().max(ASSET_INSPECT_PAGE_SIZE_MAX),
  offset: z.number().int().nonnegative(),
  includeRaw: z.boolean(),
  revision: z.string()
});

export type EditorSession = z.infer<typeof EditorSessionSchema>;
type AssetCursor = z.infer<typeof CursorSchema>;

export interface CocosReadonlyToolServiceOptions {
  creatorClient: ReadonlyCreatorClient;
}

/**
 * 提供 MCP 只读工具共享的编辑器发现和请求路由能力。
 */
export class CocosReadonlyToolService {
  constructor(private readonly options: CocosReadonlyToolServiceOptions) {}

  /** 返回 Creator IPC 后端状态；测试替身未实现时返回 null。 */
  readBackendStatus() {
    const status = this.options.creatorClient.getStatus?.();
    return status ? { available: status.state === 'ready', ...status } : null;
  }

  /**
   * 返回当前可通过命名管道访问的全部 Creator 编辑器实例。
   *
   * @returns 经过结构校验的编辑器会话列表。
   */
  async listEditors(): Promise<EditorSession[]> {
    return EditorSessionSchema.array().parse(
      await this.options.creatorClient.request('server.editors', {})
    );
  }

  /**
   * 按项目和可选实例标识解析唯一且已认证版本的 Creator 会话。
   *
   * @param selector 项目标识和可选编辑器实例标识。
   * @param selector.projectId Creator 项目标识。
   * @param selector.editorInstanceId Creator 编辑器实例标识。
   * @returns 唯一匹配的编辑器会话。
   */
  async resolveEditor(selector: {
    projectId: string;
    editorInstanceId?: string;
  }): Promise<EditorSession> {
    const matches = (await this.listEditors()).filter((editor) =>
      editor.projectId === selector.projectId
      && (!selector.editorInstanceId || editor.editorInstanceId === selector.editorInstanceId)
    );
    if (matches.length === 0) throw new Error('EDITOR_INSTANCE_NOT_FOUND');
    if (matches.length > 1) throw new Error('MULTIPLE_EDITOR_INSTANCES');
    const editor = matches[0];
    // 当前只认证 Creator 3.8.8，避免其它小版本绕过兼容性验证进入项目级工具。
    if (editor.creatorVersion !== SUPPORTED_CREATOR_VERSION) {
      throw new Error(`UNSUPPORTED_CREATOR_VERSION:${editor.creatorVersion}`);
    }
    return editor;
  }

  /**
   * 读取唯一目标编辑器的当前状态。
   *
   * @param selector 项目标识和可选编辑器实例标识。
   * @returns Bridge 返回的当前编辑器状态。
   */
  async readEditorState(selector: {
    projectId: string;
    editorInstanceId?: string;
  }) {
    const editor = await this.resolveEditor(selector);
    assertCapability(editor, 'probe.editorState');
    const state = readEditorStateResponse(await this.options.creatorClient.request(
      'probe.editorState',
      {
        selector: {
          projectId: editor.projectId,
          editorInstanceId: editor.editorInstanceId
        },
        params: {}
      }
    ));
    if (
      state.projectId !== editor.projectId
      || state.projectPath !== editor.projectPath
      || state.creatorVersion !== editor.creatorVersion
    ) {
      throw new Error('EDITOR_STATE_IDENTITY_MISMATCH');
    }
    return EditorStateOutputSchema.parse({ editor, state });
  }

  /**
   * 在完整 AssetDB 索引中按文本检索资产，并返回稳定的有界结果页。
   *
   * @param input 项目选择、搜索文本、分页和原始数据选项。
   * @returns 匹配资产、当前编辑器身份和下一页 cursor。
   */
  async searchAssets(input: {
    projectId: string;
    editorInstanceId?: string;
    pattern: string;
    pageSize?: number;
    cursor?: string;
    includeRaw?: boolean;
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.assetSearch');
    const pattern = input.pattern.trim().toLowerCase();
    const includeRaw = input.includeRaw === true;
    const pageState = readAssetSearchPageRequestState({
      cursor: input.cursor,
      editor,
      key: pattern,
      requestedPageSize: input.pageSize,
      includeRaw
    });
    const response = readAssetSearchProbeResponse(await this.options.creatorClient.request('probe.assetSearch', {
      selector: toSelector(editor),
      params: {
        pattern,
        includeRaw,
        offset: pageState.offset,
        pageSize: pageState.pageSize
      }
    }));
    if (pageState.cursorRevision && pageState.cursorRevision !== response.revision) {
      throw new Error('MCP_CURSOR_STALE');
    }
    const items = response.assets.map((asset) => toPublicAssetRecord(asset, includeRaw));
    const nextOffset = pageState.offset + items.length;
    return AssetSearchOutputSchema.parse({
      editor,
      query: { pattern: input.pattern },
      page: {
        offset: pageState.offset,
        pageSize: pageState.pageSize,
        total: response.total,
        items,
        nextCursor: nextOffset < response.total
          ? encodeCursor({
              version: 1,
              kind: 'asset-search',
              projectId: editor.projectId,
              editorInstanceId: editor.editorInstanceId,
              key: pattern,
              pageSize: pageState.pageSize,
              offset: nextOffset,
              includeRaw,
              revision: response.revision
            })
          : null
      },
      unresolved: response.unresolved
    });
  }

  /**
   * 读取单个资产的详情、Meta 和引用关系，并分页返回依赖与反向使用者。
   *
   * @param input 项目选择、资产 UUID、分页和原始数据选项。
   * @returns 资产详情、可选原始 Meta、引用关系页和未解析项。
   */
  async inspectAsset(input: {
    projectId: string;
    editorInstanceId?: string;
    uuid: string;
    pageSize?: number;
    cursor?: string;
    includeRaw?: boolean;
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.assets');
    const response = readAssetProbeResponse(await this.options.creatorClient.request('probe.assets', {
      selector: toSelector(editor),
      params: { uuid: input.uuid }
    }));
    if (!response.details) throw new Error('ASSET_NOT_FOUND');
    if (response.details.uuid && response.details.uuid !== input.uuid) {
      throw new Error('ASSET_IDENTITY_MISMATCH');
    }
    const relations = [
      ...(response.dependencies ?? []).map((assetUuid) => ({
        kind: 'dependency' as const,
        assetUuid
      })),
      ...(response.users ?? []).map((assetUuid) => ({
        kind: 'user' as const,
        assetUuid
      }))
    ];
    const includeRaw = input.includeRaw === true;
    const revision = hashJson(relations);
    const pageState = readPageState({
      cursor: input.cursor,
      kind: 'asset-inspect',
      editor,
      key: input.uuid,
      requestedPageSize: input.pageSize,
      defaultPageSize: 100,
      includeRaw,
      revision
    });
    const items = relations.slice(
      pageState.offset,
      pageState.offset + pageState.pageSize
    );
    const nextOffset = pageState.offset + items.length;
    return AssetInspectOutputSchema.parse({
      editor,
      asset: toPublicAssetInfo(response.details, includeRaw),
      meta: includeRaw ? response.meta : null,
      page: {
        offset: pageState.offset,
        pageSize: pageState.pageSize,
        total: relations.length,
        items,
        nextCursor: nextOffset < relations.length
          ? encodeCursor({
              version: 1,
              kind: 'asset-inspect',
              projectId: editor.projectId,
              editorInstanceId: editor.editorInstanceId,
              key: input.uuid,
              pageSize: pageState.pageSize,
              offset: nextOffset,
              includeRaw,
              revision
            })
          : null
      },
      unresolved: response.unresolved
    });
  }

  /**
   * 通过 Creator AssetDB 打开一个已索引资产，不直接读取或修改序列化文件。
   *
   * @param input 项目选择和目标资产 UUID。
   * @returns Creator 确认的打开状态、资产身份和编辑器会话。
   */
  async openAsset(input: {
    projectId: string;
    editorInstanceId?: string;
    uuid: string;
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.assets');
    assertCapability(editor, 'probe.openAsset');
    const inspected = readAssetProbeResponse(await this.options.creatorClient.request('probe.assets', {
      selector: toSelector(editor),
      params: { uuid: input.uuid, detailsOnly: true }
    }));
    if (!inspected.details) throw new Error('ASSET_NOT_FOUND');
    if (!inspected.details.uuid) throw new Error('ASSET_IDENTITY_UNAVAILABLE');
    if (inspected.details.uuid !== input.uuid) throw new Error('ASSET_IDENTITY_MISMATCH');
    const asset = toAssetRecord(inspected.details);
    const response = readAssetOpenProbeResponse(await this.options.creatorClient.request(
      'probe.openAsset',
      {
        selector: toSelector(editor),
        params: { uuid: asset.assetUuid }
      }
    ));
    if (response.uuid !== asset.assetUuid) {
      throw new Error('ASSET_OPEN_IDENTITY_MISMATCH');
    }
    return AssetOpenOutputSchema.parse({
      editor,
      asset,
      opened: response.opened
    });
  }

  /**
   * 读取当前文档中一个组件实例的完整反射 Schema。
   *
   * @param input 项目选择、组件运行时 UUID 和原始数据选项。
   * @returns 组件 Schema、编辑器身份和可选原始 Dump。
   */
  async readComponentSchema(input: {
    projectId: string;
    editorInstanceId?: string;
    uuid: string;
    includeRaw?: boolean;
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.component');
    const response = readComponentProbeResponse(
      await this.options.creatorClient.request('probe.component', {
        selector: toSelector(editor),
        params: { uuid: input.uuid }
      })
    );
    // Bridge 当前不回传 schema.componentUuid：身份校验仅在真实拿到该字段时执行，避免恒空转。
    if (typeof response.schema.componentUuid === 'string'
      && response.schema.componentUuid
      && response.schema.componentUuid !== input.uuid) {
      throw new Error('COMPONENT_IDENTITY_MISMATCH');
    }
    return ComponentSchemaOutputSchema.parse({
      editor,
      schema: response.schema,
      ...(input.includeRaw === true ? { raw: response.raw } : {})
    });
  }

  /**
   * 读取当前 Creator 文档的节点树（供 AI 寻址节点 uuid 与路径）。
   *
   * @param input 项目选择和可选层级深度。
   * @returns Scene 进程归一化后的层级树。
   */
  async readHierarchy(input: {
    projectId: string;
    editorInstanceId?: string;
    depth?: number;
    rootUuid?: string;
    compact?: boolean;
    maxOutputBytes?: number;
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.hierarchy');
    return {
      editor,
      hierarchy: await this.options.creatorClient.request('probe.hierarchy', {
        selector: toSelector(editor),
        params: {
          ...(typeof input.depth === 'number' ? { depth: input.depth } : {}),
          ...(input.rootUuid ? { rootUuid: input.rootUuid } : {}),
          ...(input.compact === true ? { compact: true } : {}),
          ...(typeof input.maxOutputBytes === 'number' ? { maxOutputBytes: input.maxOutputBytes } : {})
        }
      })
    };
  }

  /**
   * 读取当前文档中单个节点的详情（含组件清单，供组件寻址）。
   *
   * @param input 项目选择和节点运行时 UUID。
   * @returns Scene 进程归一化后的节点详情。
   */
  async readNode(input: {
    projectId: string;
    editorInstanceId?: string;
    uuid: string;
    includeBounds?: boolean;
    includeDescendantVisualUnion?: boolean;
    relativeToUuid?: string;
    relativeToPath?: string;
    compact?: boolean;
    maxOutputBytes?: number;
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.node');
    return {
      editor,
      node: await this.options.creatorClient.request('probe.node', {
        selector: toSelector(editor),
        params: {
          uuid: input.uuid,
          ...(input.includeBounds === true ? { includeBounds: true } : {}),
          ...(input.includeDescendantVisualUnion === true ? { includeDescendantVisualUnion: true } : {}),
          ...(input.relativeToUuid ? { relativeToUuid: input.relativeToUuid } : {}),
          ...(input.relativeToPath ? { relativeToPath: input.relativeToPath } : {}),
          ...(input.compact === true ? { compact: true } : {}),
          ...(typeof input.maxOutputBytes === 'number' ? { maxOutputBytes: input.maxOutputBytes } : {})
        }
      })
    };
  }

  /**
   * 经 Named Pipe 向目标编辑器发起一次原始请求（直写等高层服务的共用通道）。
   *
   * @param editor 已解析的编辑器会话。
   * @param method Bridge 探针方法名。
   * @param params 方法参数。
   * @returns Bridge 响应载荷。
   */
  async requestBridge(editor: EditorSession, method: string, params: unknown): Promise<unknown> {
    return this.options.creatorClient.request(method, {
      selector: toSelector(editor),
      params
    });
  }
}

function readAssetSearchProbeResponse(value: unknown): z.infer<typeof AssetSearchProbeResponseSchema> {
  const result = AssetSearchProbeResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`ASSET_SEARCH_INVALID:${result.error.message}`);
  }
  return result.data;
}

function readEditorStateResponse(value: unknown): z.infer<typeof EditorStateSchema> {
  const result = EditorStateSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`EDITOR_STATE_INVALID:${result.error.message}`);
  }
  return result.data;
}

function readAssetProbeResponse(value: unknown): z.infer<typeof AssetProbeResponseSchema> {
  const result = AssetProbeResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`ASSET_INSPECT_INVALID:${result.error.message}`);
  }
  return result.data;
}

function readAssetOpenProbeResponse(value: unknown): z.infer<typeof AssetOpenProbeResponseSchema> {
  const result = AssetOpenProbeResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`ASSET_OPEN_INVALID:${result.error.message}`);
  }
  return result.data;
}

function readComponentProbeResponse(value: unknown): z.infer<typeof ComponentProbeResponseSchema> {
  const result = ComponentProbeEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`COMPONENT_SCHEMA_INVALID:${result.error.message}`);
  }
  return result.data.data;
}

function assertCapability(editor: EditorSession, capability: string): void {
  if (!editor.capabilities.includes(capability)) {
    throw new Error(`EDITOR_CAPABILITY_MISSING:${capability}`);
  }
}

function toSelector(editor: EditorSession): {
  projectId: string;
  editorInstanceId: string;
} {
  return {
    projectId: editor.projectId,
    editorInstanceId: editor.editorInstanceId
  };
}

function toPublicAssetRecord(asset: z.infer<typeof PublicAssetRecordSchema>, includeRaw: boolean) {
  if (includeRaw) return asset;
  const { raw: _raw, ...publicAsset } = asset;
  return publicAsset;
}

function toAssetRecord(asset: z.infer<typeof NormalizedAssetInfoSchema>) {
  return PublicAssetRecordSchema.parse({
    assetUuid: asset.uuid,
    url: asset.url,
    filePath: asset.file,
    type: asset.type,
    importer: asset.importer,
    name: asset.name,
    displayName: asset.displayName,
    source: asset.source,
    path: asset.path,
    isSubAsset: asset.isSubAsset,
    isBundle: asset.isBundle,
    imported: asset.imported,
    invalid: asset.invalid,
    isDirectory: asset.isDirectory,
    visible: asset.visible,
    readonly: asset.readonly,
    available: asset.invalid !== true
  });
}

function toPublicAssetInfo(
  asset: z.infer<typeof NormalizedAssetInfoSchema>,
  includeRaw: boolean
) {
  if (includeRaw) return asset;
  const { raw: _raw, ...publicAsset } = asset;
  return publicAsset;
}

function readAssetSearchPageRequestState(input: {
  cursor?: string;
  editor: EditorSession;
  key: string;
  requestedPageSize?: number;
  includeRaw: boolean;
}): { offset: number; pageSize: number; cursorRevision: string | null } {
  if (!input.cursor) {
    const pageSize = input.requestedPageSize ?? 50;
    if (pageSize <= 0 || pageSize > ASSET_SEARCH_PAGE_SIZE_MAX) {
      throw new Error('MCP_CURSOR_INVALID:pageSize');
    }
    return { offset: 0, pageSize, cursorRevision: null };
  }
  const cursor = decodeCursor(input.cursor);
  const pageSize = input.requestedPageSize ?? cursor.pageSize;
  if (
    cursor.kind !== 'asset-search'
    || cursor.projectId !== input.editor.projectId
    || cursor.editorInstanceId !== input.editor.editorInstanceId
    || cursor.key !== input.key
    || cursor.pageSize !== pageSize
    || cursor.includeRaw !== input.includeRaw
    || pageSize <= 0
    || pageSize > ASSET_SEARCH_PAGE_SIZE_MAX
  ) {
    throw new Error('MCP_CURSOR_STALE');
  }
  return { offset: cursor.offset, pageSize, cursorRevision: cursor.revision };
}

/**
 * 读取并校验资产工具的分页状态，防止 cursor 绕过各工具页大小上限。
 *
 * @param input 当前资产工具、编辑器身份、查询键、分页参数和数据版本。
 * @returns 当前结果页的偏移和页大小。
 */
function readPageState(input: {
  cursor?: string;
  kind: AssetCursor['kind'];
  editor: EditorSession;
  key: string;
  requestedPageSize?: number;
  defaultPageSize: number;
  includeRaw: boolean;
  revision: string;
}): { offset: number; pageSize: number } {
  const maxPageSize = input.kind === 'asset-search'
    ? ASSET_SEARCH_PAGE_SIZE_MAX
    : ASSET_INSPECT_PAGE_SIZE_MAX;
  if (!input.cursor) {
    const pageSize = input.requestedPageSize ?? input.defaultPageSize;
    if (pageSize > maxPageSize) throw new Error('MCP_CURSOR_INVALID:pageSize');
    return {
      offset: 0,
      pageSize
    };
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor.pageSize > maxPageSize) throw new Error('MCP_CURSOR_INVALID:pageSize');
  const pageSize = input.requestedPageSize ?? cursor.pageSize;
  if (pageSize > maxPageSize) throw new Error('MCP_CURSOR_INVALID:pageSize');
  if (
    cursor.kind !== input.kind
    || cursor.projectId !== input.editor.projectId
    || cursor.editorInstanceId !== input.editor.editorInstanceId
    || cursor.key !== input.key
    || cursor.pageSize !== pageSize
    || cursor.includeRaw !== input.includeRaw
    || cursor.revision !== input.revision
  ) {
    throw new Error('MCP_CURSOR_STALE');
  }
  return { offset: cursor.offset, pageSize };
}

function encodeCursor(cursor: AssetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): AssetCursor {
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch (error) {
    throw new Error(`MCP_CURSOR_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
