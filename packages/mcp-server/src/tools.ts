import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AssetRecordSchema,
  ComponentTypeSchemaSchema,
  DocumentAssetRecordSchema,
  ScriptAssetRecordSchema,
  UnresolvedItemSchema,
  type AssetRecord
} from '@cocos-ai/protocol';

const SUPPORTED_CREATOR_VERSION = '3.8.8';
const ASSET_SEARCH_PAGE_SIZE_MAX = 200;
const ASSET_INSPECT_PAGE_SIZE_MAX = 500;

/** MCP 侧只读探针客户端抽象。 */
export interface ReadonlyProbeClient {
  request(method: string, payload: unknown): Promise<unknown>;
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

const EditorListOutputSchema = z.object({
  editors: z.array(EditorSessionSchema)
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

const AssetIndexSchema = z.object({
  assets: z.array(AssetRecordSchema),
  scripts: z.array(ScriptAssetRecordSchema),
  documents: z.array(DocumentAssetRecordSchema),
  unresolved: z.array(UnresolvedItemSchema)
});

const PublicAssetRecordSchema = AssetRecordSchema.omit({ raw: true }).extend({
  raw: z.unknown().optional()
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

// Bridge 场景进程返回信封 {data:{…,schema,raw}, raw, source}；readComponentProbeResponse 先解包 data，
// 再按这里的内层形状校验，因此信封形状与无信封的旧形状均可接受。
const ComponentProbeResponseSchema = z.object({
  schema: ComponentTypeSchemaSchema,
  raw: z.unknown()
}).passthrough();

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

const ProjectSelectorInput = {
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional()
};

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false
} as const;

export type EditorSession = z.infer<typeof EditorSessionSchema>;
type AssetCursor = z.infer<typeof CursorSchema>;

export interface CocosReadonlyToolServiceOptions {
  probeClient: ReadonlyProbeClient;
  reportRoot: string;
}

/**
 * 提供 MCP 只读工具共享的编辑器发现和请求路由能力。
 */
export class CocosReadonlyToolService {
  constructor(private readonly options: CocosReadonlyToolServiceOptions) {}

  /**
   * 返回当前 Probe Server 已登记的全部 Creator 编辑器实例。
   *
   * @returns 经过结构校验的编辑器会话列表。
   */
  async listEditors(): Promise<EditorSession[]> {
    return EditorSessionSchema.array().parse(
      await this.options.probeClient.request('server.editors', {})
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
    const state = readEditorStateResponse(await this.options.probeClient.request(
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
    assertCapability(editor, 'probe.assetIndex');
    const index = readAssetIndex(await this.options.probeClient.request('probe.assetIndex', {
      selector: toSelector(editor),
      params: {}
    }));
    const pattern = input.pattern.trim().toLowerCase();
    const includeRaw = input.includeRaw === true;
    const revision = createAssetManifestHash(index.assets, index.documents);
    const matching = index.assets
      .filter((asset) => matchesAsset(asset, pattern))
      .sort(compareAssets);
    const pageState = readPageState({
      cursor: input.cursor,
      kind: 'asset-search',
      editor,
      key: pattern,
      requestedPageSize: input.pageSize,
      defaultPageSize: 50,
      includeRaw,
      revision
    });
    const items = matching
      .slice(pageState.offset, pageState.offset + pageState.pageSize)
      .map((asset) => toPublicAssetRecord(asset, includeRaw));
    const nextOffset = pageState.offset + items.length;
    return AssetSearchOutputSchema.parse({
      editor,
      query: { pattern: input.pattern },
      page: {
        offset: pageState.offset,
        pageSize: pageState.pageSize,
        total: matching.length,
        items,
        nextCursor: nextOffset < matching.length
          ? encodeCursor({
              version: 1,
              kind: 'asset-search',
              projectId: editor.projectId,
              editorInstanceId: editor.editorInstanceId,
              key: pattern,
              pageSize: pageState.pageSize,
              offset: nextOffset,
              includeRaw,
              revision
            })
          : null
      },
      unresolved: index.unresolved
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
    assertCapability(editor, 'probe.assetIndex');
    assertCapability(editor, 'probe.assets');
    const index = readAssetIndex(await this.options.probeClient.request('probe.assetIndex', {
      selector: toSelector(editor),
      params: {}
    }));
    const indexedAsset = index.assets.find((asset) => asset.assetUuid === input.uuid);
    if (!indexedAsset) throw new Error('ASSET_NOT_FOUND');
    const response = readAssetProbeResponse(await this.options.probeClient.request('probe.assets', {
      selector: toSelector(editor),
      params: {
        pattern: indexedAsset.url ?? indexedAsset.path ?? indexedAsset.name ?? indexedAsset.assetUuid,
        uuid: indexedAsset.assetUuid
      }
    }));
    if (!response.details) throw new Error('ASSET_DETAILS_UNAVAILABLE');
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
    assertCapability(editor, 'probe.assetIndex');
    assertCapability(editor, 'probe.openAsset');
    const index = readAssetIndex(await this.options.probeClient.request('probe.assetIndex', {
      selector: toSelector(editor),
      params: {}
    }));
    const indexedAsset = index.assets.find((asset) => asset.assetUuid === input.uuid);
    if (!indexedAsset) throw new Error('ASSET_NOT_FOUND');
    const response = readAssetOpenProbeResponse(await this.options.probeClient.request(
      'probe.openAsset',
      {
        selector: toSelector(editor),
        params: { uuid: indexedAsset.assetUuid }
      }
    ));
    if (response.uuid !== indexedAsset.assetUuid) {
      throw new Error('ASSET_OPEN_IDENTITY_MISMATCH');
    }
    return AssetOpenOutputSchema.parse({
      editor,
      asset: toPublicAssetRecord(indexedAsset, false),
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
      await this.options.probeClient.request('probe.component', {
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
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.hierarchy');
    return {
      editor,
      hierarchy: await this.options.probeClient.request('probe.hierarchy', {
        selector: toSelector(editor),
        params: {
          ...(typeof input.depth === 'number' ? { depth: input.depth } : {}),
          ...(input.rootUuid ? { rootUuid: input.rootUuid } : {})
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
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.node');
    return {
      editor,
      node: await this.options.probeClient.request('probe.node', {
        selector: toSelector(editor),
        params: {
          uuid: input.uuid,
          ...(input.includeBounds === true ? { includeBounds: true } : {}),
          ...(input.includeDescendantVisualUnion === true ? { includeDescendantVisualUnion: true } : {}),
          ...(input.relativeToUuid ? { relativeToUuid: input.relativeToUuid } : {}),
          ...(input.relativeToPath ? { relativeToPath: input.relativeToPath } : {})
        }
      })
    };
  }

  /**
   * 经 Probe Server 向目标编辑器发起一次原始请求（直写等高层服务的共用通道）。
   *
   * @param editor 已解析的编辑器会话。
   * @param method Bridge 探针方法名。
   * @param params 方法参数。
   * @returns Bridge 响应载荷。
   */
  async requestBridge(editor: EditorSession, method: string, params: unknown): Promise<unknown> {
    return this.options.probeClient.request(method, {
      selector: toSelector(editor),
      params
    });
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function readAssetIndex(value: unknown): z.infer<typeof AssetIndexSchema> {
  const result = AssetIndexSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`ASSET_INDEX_INVALID:${result.error.message}`);
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
  // Bridge 场景进程返回信封 {data:{…,schema,raw}, raw, source}：先解包 data 作为校验对象；
  // raw 优先取解包对象的 raw，缺省时回落信封顶层 raw；无 data 字段时按旧形状直接校验。
  const envelope = readObject(value);
  const data = envelope.data;
  const inner = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : envelope;
  const candidate = inner.raw !== undefined ? inner : { ...inner, raw: envelope.raw };
  const result = ComponentProbeResponseSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`COMPONENT_SCHEMA_INVALID:${result.error.message}`);
  }
  return result.data;
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

function matchesAsset(asset: AssetRecord, pattern: string): boolean {
  return [
    asset.assetUuid,
    asset.url,
    asset.filePath,
    asset.type,
    asset.importer,
    asset.name,
    asset.displayName,
    asset.source,
    asset.path
  ].some((value) => value?.toLowerCase().includes(pattern));
}

function compareAssets(left: AssetRecord, right: AssetRecord): number {
  const leftKey = left.url ?? left.filePath ?? left.assetUuid;
  const rightKey = right.url ?? right.filePath ?? right.assetUuid;
  return leftKey.localeCompare(rightKey);
}

function toPublicAssetRecord(asset: AssetRecord, includeRaw: boolean) {
  if (includeRaw) return asset;
  const { raw: _raw, ...publicAsset } = asset;
  return publicAsset;
}

function toPublicAssetInfo(
  asset: z.infer<typeof NormalizedAssetInfoSchema>,
  includeRaw: boolean
) {
  if (includeRaw) return asset;
  const { raw: _raw, ...publicAsset } = asset;
  return publicAsset;
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

/**
 * 为资产清单生成与顺序无关的指纹（cursor 数据版本）。
 *
 * @param assets AssetDB 返回的完整资产记录。
 * @param documents AssetDB 识别出的 Scene/Prefab 记录。
 * @returns 资产清单指纹。
 */
function createAssetManifestHash(
  assets: Array<{ assetUuid?: string | null; url?: string | null; type?: string | null }>,
  documents: Array<{ assetUuid?: string | null }>
): string {
  const assetKeys = assets
    .map((asset) => `${asset.assetUuid ?? ''}|${asset.url ?? ''}|${asset.type ?? ''}`)
    .sort();
  const documentKeys = documents.map((document) => document.assetUuid ?? '').sort();
  return hashJson({ assets: assetKeys, documents: documentKeys });
}
