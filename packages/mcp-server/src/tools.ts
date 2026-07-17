import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  appendWriteJournalEntry,
  createAssetManifestHash,
  JsonScanReportWriter,
  parseScanCheckpoint,
  ProjectScanner,
  type ProjectScanDocumentSummary,
  type ProjectScanResult,
  type ReadonlyProbeClient,
  type ScanCheckpoint
} from '@cocos-ai/core';
import {
  AssetRecordSchema,
  ComponentTypeSchemaSchema,
  DocumentAssetRecordSchema,
  DocumentSnapshotSchema,
  PrefabGraphEdgeSchema,
  PrefabGraphNodeSchema,
  ProjectCoverageSchema,
  RevisionPreconditionSchema,
  ScriptAssetRecordSchema,
  UnresolvedItemSchema,
  WriteOperationSchema,
  WriteTransactionRequestSchema,
  WriteTransactionResultSchema,
  type AssetRecord,
  type PrefabGraph,
  type ProjectCoverage
} from '@cocos-ai/protocol';
import { randomUUID, createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';
import { z } from 'zod';

const SUPPORTED_CREATOR_VERSION = '3.8.8';
const ASSET_SEARCH_PAGE_SIZE_MAX = 200;
const ASSET_INSPECT_PAGE_SIZE_MAX = 500;
const REPORT_PAGE_SIZE_MAX = 200;

const EditorSessionSchema = z.object({
  editorInstanceId: z.string().min(1),
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  creatorVersion: z.string().min(1),
  bridgeVersion: z.string().min(1),
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
    dirty: z.boolean().nullable()
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

const ComponentProbeResponseSchema = z.object({
  schema: ComponentTypeSchemaSchema,
  raw: z.unknown()
}).passthrough();

const ComponentSchemaOutputSchema = z.object({
  editor: EditorSessionSchema,
  schema: ComponentTypeSchemaSchema,
  raw: z.unknown().optional()
});

// 协议 Schema 含 z.custom 当前值门禁，MCP 公布的 JSON Schema 使用可表示的对象边界；
// 真实响应仍先经过上面的 ComponentSchemaOutputSchema 严格校验。
const ComponentMcpOutputSchema = z.object({
  editor: EditorSessionSchema,
  schema: z.record(z.string(), z.unknown()),
  raw: z.unknown().optional()
});

const DocumentSnapshotOutputSchema = z.object({
  editor: EditorSessionSchema,
  snapshot: DocumentSnapshotSchema
});

// DocumentSnapshot 嵌套同一组件自定义门禁，公开 Schema 保持 JSON Schema 可表示。
const DocumentSnapshotMcpOutputSchema = z.object({
  editor: EditorSessionSchema,
  snapshot: z.record(z.string(), z.unknown())
});

const DocumentSummarySchema = z.object({
  assetUuid: z.string().nullable(),
  path: z.string().nullable(),
  documentType: z.enum(['scene', 'prefab']).nullable(),
  revision: z.string(),
  nodes: z.number().int().nonnegative(),
  components: z.number().int().nonnegative(),
  prefabInstances: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  diagnostics: z.number().int().nonnegative()
});

const ProjectScanSummarySchema = z.object({
  assets: z.number().int().nonnegative(),
  scripts: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  diagnostics: z.number().int().nonnegative(),
  coverage: ProjectCoverageSchema
});

const ProjectScanOutputSchema = z.object({
  editor: EditorSessionSchema,
  scanId: z.string(),
  status: z.enum(['running', 'completed', 'completed-with-gaps', 'failed']),
  reportPath: z.string(),
  checkpointPath: z.string(),
  summary: ProjectScanSummarySchema,
  page: z.object({
    offset: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    items: z.array(DocumentSummarySchema),
    nextCursor: z.string().nullable()
  })
});

const PrefabGraphPageItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), value: PrefabGraphNodeSchema }),
  z.object({ kind: z.literal('edge'), value: PrefabGraphEdgeSchema })
]);

const PrefabGraphOutputSchema = z.object({
  editor: EditorSessionSchema,
  scanId: z.string(),
  status: z.enum(['running', 'completed', 'completed-with-gaps', 'failed']),
  reportPath: z.string(),
  checkpointPath: z.string(),
  summary: z.object({
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    blocked: z.boolean(),
    diagnostics: z.number().int().nonnegative()
  }),
  page: z.object({
    offset: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    items: z.array(PrefabGraphPageItemSchema),
    nextCursor: z.string().nullable()
  })
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

const ReportCursorSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['project-scan', 'prefab-graph']),
  projectId: z.string(),
  editorInstanceId: z.string(),
  report: z.string(),
  checkpoint: z.string(),
  pageSize: z.number().int().positive().max(REPORT_PAGE_SIZE_MAX),
  offset: z.number().int().nonnegative(),
  scanId: z.string(),
  reportHash: z.string().min(1),
  checkpointHash: z.string().min(1)
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
type ReportCursor = z.infer<typeof ReportCursorSchema>;

interface ProjectScanToolInput {
  projectId: string;
  editorInstanceId?: string;
  report?: string;
  resume?: string;
  scanPageSize?: number;
  pageSize?: number;
  cursor?: string;
  includeRaw?: boolean;
  concurrency?: number;
}

interface PreparedScanPaths {
  reportRoot: string;
  reportRelativePath: string;
  checkpointRelativePath: string;
  reportPath: string;
  checkpointPath: string;
}

interface ScanPageContext {
  editor: EditorSession;
  report: ProjectScanView;
  paths: PreparedScanPaths;
  pageSize: number;
  offset: number;
  reportHash: string;
  checkpointHash: string;
}

interface ProjectScanView {
  scanId: string;
  status: 'completed' | 'completed-with-gaps' | 'failed';
  project: {
    projectId: string;
    projectPath: string;
    creatorVersion: string;
  };
  startedAt: string;
  finishedAt: string;
  assetCount: number;
  scriptCount: number;
  documentSummaries: ProjectScanDocumentSummary[];
  prefabGraph: PrefabGraph;
  coverage: ProjectCoverage;
  unresolvedCount: number;
  diagnosticsCount: number;
}

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
      'probe.editorState', {
      selector: {
        projectId: editor.projectId,
        editorInstanceId: editor.editorInstanceId
      },
      params: {}
    }));
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
    if (response.schema.componentUuid && response.schema.componentUuid !== input.uuid) {
      throw new Error('COMPONENT_IDENTITY_MISMATCH');
    }
    return ComponentSchemaOutputSchema.parse({
      editor,
      schema: response.schema,
      ...(input.includeRaw === true ? { raw: response.raw } : {})
    });
  }

  /**
   * 读取 Creator 当前打开文档的摘要或完整分页快照。
   *
   * @param input 项目选择、快照模式、分页 cursor、原始数据和并发参数。
   * @returns 经过协议校验的文档快照和编辑器身份。
   */
  async readDocumentSnapshot(input: {
    projectId: string;
    editorInstanceId?: string;
    mode: 'summary' | 'full';
    pageSize: number;
    cursor?: string;
    includeRaw?: boolean;
    concurrency?: number;
  }) {
    const editor = await this.resolveEditor(input);
    assertCapability(editor, 'probe.documentSnapshot');
    const snapshot = readDocumentSnapshot(
      await this.options.probeClient.request('probe.documentSnapshot', {
        selector: toSelector(editor),
        params: {
          mode: input.mode,
          pageSize: input.pageSize,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          includeRaw: input.includeRaw === true,
          ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {})
        }
      })
    );
    if (snapshot.mode !== input.mode) throw new Error('DOCUMENT_MODE_MISMATCH');
    return DocumentSnapshotOutputSchema.parse({ editor, snapshot });
  }

  /**
   * 执行或继续读取项目只读扫描，并只向 AI 返回有界文档摘要页。
   *
   * @param input 项目选择、报告路径、扫描参数和可选报告 cursor。
   * @returns 项目扫描摘要、授权报告路径和当前文档摘要页。
   */
  async scanProject(input: ProjectScanToolInput) {
    const context = await this.prepareScanPage(input, 'project-scan');
    const documents = context.report.documentSummaries.map(toDocumentSummary);
    const page = createReportPage({
      items: documents,
      context,
      kind: 'project-scan'
    });
    return ProjectScanOutputSchema.parse({
      editor: context.editor,
      scanId: context.report.scanId,
      status: context.report.status,
      reportPath: context.paths.reportPath,
      checkpointPath: context.paths.checkpointPath,
      summary: {
        assets: context.report.assetCount,
        scripts: context.report.scriptCount,
        documents: context.report.documentSummaries.length,
        unresolved: context.report.unresolvedCount,
        diagnostics: context.report.diagnosticsCount,
        coverage: context.report.coverage
      },
      page
    });
  }

  /**
   * 执行或继续读取项目只读扫描，并分页返回 Prefab 图节点与边。
   *
   * @param input 项目选择、报告路径和可选报告 cursor。
   * @returns Prefab 图摘要、授权报告路径和当前图数据页。
   */
  async readPrefabGraph(input: ProjectScanToolInput) {
    const context = await this.prepareScanPage(input, 'prefab-graph');
    const graph = context.report.prefabGraph;
    const items = [
      ...graph.nodes.map((value) => ({ kind: 'node' as const, value })),
      ...graph.edges.map((value) => ({ kind: 'edge' as const, value }))
    ];
    const page = createReportPage({
      items,
      context,
      kind: 'prefab-graph'
    });
    return PrefabGraphOutputSchema.parse({
      editor: context.editor,
      scanId: context.report.scanId,
      status: context.report.status,
      reportPath: context.paths.reportPath,
      checkpointPath: context.paths.checkpointPath,
      summary: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        blocked: graph.blocked === true,
        diagnostics: graph.diagnostics?.length ?? 0
      },
      page
    });
  }

  /**
   * 在任何 Creator 请求前准备报告路径；有 cursor 时读取既有报告，无 cursor 时执行一次扫描。
   *
   * @param input 项目选择、扫描参数和可选报告 cursor。
   * @param kind 当前需要分页的报告视图。
   * @returns 已校验编辑器、完整报告、授权路径和分页位置。
   */
  private async prepareScanPage(
    input: ProjectScanToolInput,
    kind: ReportCursor['kind']
  ): Promise<ScanPageContext> {
    if (input.cursor) {
      return this.readStoredScanPage(input, kind);
    }

    const paths = await prepareScanPaths(this.options.reportRoot, input, kind);
    const checkpoint = await readResumeCheckpoint(input, paths);
    const editor = await this.resolveEditor(input);
    if (checkpoint && checkpoint.editorInstanceId !== editor.editorInstanceId) {
      throw new Error('SCAN_CHECKPOINT_STALE:editorInstanceId');
    }
    const result = await this.runProjectScan(input, editor, paths, checkpoint);
    const report = toProjectScanView(result);
    assertReportMatchesEditor(report, editor);
    return {
      editor,
      report,
      paths,
      pageSize: input.pageSize ?? 50,
      offset: 0,
      reportHash: await hashFile(paths.reportPath),
      checkpointHash: hashJson(result.checkpoint)
    };
  }

  /**
   * 从授权报告根读取 cursor 绑定的已落盘报告，不重新打开 Creator 资产。
   *
   * @param input 项目选择、结果页大小和报告 cursor。
   * @param kind 当前需要分页的报告视图。
   * @returns 已校验编辑器、完整报告、授权路径和 cursor 分页位置。
   */
  private async readStoredScanPage(
    input: ProjectScanToolInput,
    kind: ReportCursor['kind']
  ): Promise<ScanPageContext> {
    const cursor = decodeReportCursor(input.cursor ?? '');
    const pageSize = input.pageSize ?? cursor.pageSize;
    if (
      cursor.kind !== kind
      || cursor.projectId !== input.projectId
      || (input.editorInstanceId !== undefined
        && input.editorInstanceId !== cursor.editorInstanceId)
      || cursor.pageSize !== pageSize
      || input.report !== undefined
      || input.resume !== undefined
      || input.scanPageSize !== undefined
      || input.includeRaw !== undefined
      || input.concurrency !== undefined
    ) {
      throw new Error('MCP_CURSOR_STALE');
    }
    const paths = await prepareCursorPaths(this.options.reportRoot, cursor);
    let checkpoint: ScanCheckpoint;
    try {
      checkpoint = await readStoredCheckpoint(paths.checkpointPath);
    } catch {
      throw new Error('MCP_CURSOR_STALE');
    }
    const report = toStoredProjectScanView(checkpoint);
    // cursor 同时绑定报告和 checkpoint 内容，防止外部进程替换有效 JSON 后继续翻页。
    const reportHash = await hashFile(paths.reportPath).catch(() => '');
    const checkpointHash = hashJson(checkpoint);
    if (
      report.scanId !== cursor.scanId
      || report.project.projectId !== cursor.projectId
      || checkpoint.scanId !== cursor.scanId
      || checkpoint.projectId !== cursor.projectId
      || checkpoint.editorInstanceId !== cursor.editorInstanceId
      || reportHash !== cursor.reportHash
      || checkpointHash !== cursor.checkpointHash
    ) {
      throw new Error('MCP_CURSOR_STALE');
    }
    const editor = await this.resolveEditor(input);
    if (editor.editorInstanceId !== cursor.editorInstanceId) {
      throw new Error('MCP_CURSOR_STALE');
    }
    assertReportMatchesEditor(report, editor);
    return {
      editor,
      report,
      paths,
      pageSize,
      offset: cursor.offset,
      reportHash,
      checkpointHash
    };
  }

  /**
   * 使用共享 Core 扫描器执行完整只读扫描并把报告与 checkpoint 写入授权目录。
   *
   * @param input 当前 MCP 扫描参数。
   * @param editor 已解析的唯一 Creator 编辑器实例。
   * @param paths 已验证的报告和 checkpoint 路径。
   * @param checkpoint 可选的可信续扫 checkpoint。
   * @returns Core 扫描器生成的完整结果。
   */
  private async runProjectScan(
    input: ProjectScanToolInput,
    editor: EditorSession,
    paths: PreparedScanPaths,
    checkpoint?: ScanCheckpoint
  ): Promise<ProjectScanResult> {
    const scanner = new ProjectScanner(
      this.options.probeClient,
      new JsonScanReportWriter(paths.reportPath, paths.checkpointPath, paths.reportRoot)
    );
    return scanner.scan({
      projectId: editor.projectId,
      editorInstanceId: editor.editorInstanceId,
      ...(checkpoint
        ? {
            checkpoint,
            pageSize: input.scanPageSize ?? checkpoint.parameters.pageSize,
            includeRaw: input.includeRaw ?? checkpoint.parameters.includeRaw,
            concurrency: input.concurrency ?? checkpoint.parameters.concurrency
          }
        : {
            ...(input.scanPageSize !== undefined ? { pageSize: input.scanPageSize } : {}),
            ...(input.includeRaw !== undefined ? { includeRaw: input.includeRaw } : {}),
            ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {})
          })
    });
  }
}

/**
 * 把阶段一八个 Cocos 只读工具登记到 MCP Server。
 *
 * @param server 待登记工具的 MCP Server。
 * @param service 共享的只读 Creator 请求服务。
 */
export function registerCocosReadonlyTools(
  server: McpServer,
  service: CocosReadonlyToolService
): void {
  server.registerTool('cocos_editor_list', {
    description: '列出当前连接 Probe Server 的全部 Cocos Creator 编辑器实例。',
    inputSchema: {},
    outputSchema: EditorListOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async () => toToolResult({ editors: await service.listEditors() }));

  server.registerTool('cocos_editor_state', {
    description: '读取指定 Cocos Creator 项目和编辑器实例的当前状态。',
    inputSchema: ProjectSelectorInput,
    outputSchema: EditorStateOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readEditorState(input)));

  server.registerTool('cocos_asset_search', {
    description: '在 Creator AssetDB 完整索引中搜索资产，并按 cursor 返回有界结果页。',
    inputSchema: {
      ...ProjectSelectorInput,
      pattern: z.string().min(1),
      pageSize: z.number().int().min(1).max(ASSET_SEARCH_PAGE_SIZE_MAX).optional(),
      cursor: z.string().min(1).optional(),
      includeRaw: z.boolean().optional()
    },
    outputSchema: AssetSearchOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.searchAssets(input)));
  server.registerTool('cocos_asset_inspect', {
    description: '读取单个 Creator 资产的详情、Meta、依赖和反向使用者。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      pageSize: z.number().int().min(1).max(ASSET_INSPECT_PAGE_SIZE_MAX).optional(),
      cursor: z.string().min(1).optional(),
      includeRaw: z.boolean().optional()
    },
    outputSchema: AssetInspectOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.inspectAsset(input)));
  server.registerTool('cocos_component_schema', {
    description: '读取当前 Creator 文档中组件实例的完整类型、属性和 Inspector Schema。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      includeRaw: z.boolean().optional()
    },
    outputSchema: ComponentMcpOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readComponentSchema(input)));
  server.registerTool('cocos_document_snapshot', {
    description: '读取当前 Creator 文档的摘要或完整分页快照。',
    inputSchema: {
      ...ProjectSelectorInput,
      mode: z.enum(['summary', 'full']),
      pageSize: z.number().int().min(1).max(500),
      cursor: z.string().min(1).optional(),
      includeRaw: z.boolean().optional(),
      concurrency: z.number().int().min(1).max(4).optional()
    },
    outputSchema: DocumentSnapshotMcpOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readDocumentSnapshot(input)));
  server.registerTool('cocos_prefab_graph', {
    description: '扫描项目并把完整 Prefab 图写入授权报告，只返回有界节点和边页。',
    inputSchema: {
      ...ProjectSelectorInput,
      report: z.string().min(1).optional(),
      pageSize: z.number().int().min(1).max(REPORT_PAGE_SIZE_MAX).optional(),
      cursor: z.string().min(1).optional()
    },
    outputSchema: PrefabGraphOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.readPrefabGraph(input)));
  server.registerTool('cocos_project_scan', {
    description: '执行可断点续扫的完整项目只读扫描，并返回有界文档摘要页。',
    inputSchema: {
      ...ProjectSelectorInput,
      report: z.string().min(1).optional(),
      resume: z.string().min(1).optional(),
      scanPageSize: z.number().int().min(1).max(500).optional(),
      pageSize: z.number().int().min(1).max(REPORT_PAGE_SIZE_MAX).optional(),
      cursor: z.string().min(1).optional(),
      includeRaw: z.boolean().optional(),
      concurrency: z.number().int().min(1).max(4).optional()
    },
    outputSchema: ProjectScanOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.scanProject(input)));
}

function toToolResult(value: unknown) {
  const structuredContent = readObject(value);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent
  };
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

function readComponentProbeResponse(value: unknown): z.infer<typeof ComponentProbeResponseSchema> {
  const result = ComponentProbeResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`COMPONENT_SCHEMA_INVALID:${result.error.message}`);
  }
  return result.data;
}

function readDocumentSnapshot(value: unknown): z.infer<typeof DocumentSnapshotSchema> {
  const result = DocumentSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`DOCUMENT_SNAPSHOT_INVALID:${result.error.message}`);
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

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * 把完整文档快照压缩为 AI 可分页读取的稳定摘要。
 *
 * @param document 项目报告中的完整文档快照。
 * @returns 不包含节点、组件和原始 Dump 的文档摘要。
 */
function toDocumentSummary(document: ProjectScanDocumentSummary) {
  return DocumentSummarySchema.parse({
    assetUuid: document.assetUuid,
    path: document.path,
    documentType: document.documentType,
    revision: document.revision,
    nodes: document.nodes,
    components: document.components,
    prefabInstances: document.prefabInstances,
    unresolved: document.unresolved,
    diagnostics: document.diagnostics
  });
}

function toProjectScanView(result: ProjectScanResult): ProjectScanView {
  return {
    scanId: result.scanId,
    status: result.status === 'running' ? 'failed' : result.status,
    project: result.project,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt ?? new Date().toISOString(),
    assetCount: result.assets.length,
    scriptCount: result.scripts.length,
    documentSummaries: result.documentSummaries,
    prefabGraph: result.prefabGraph,
    coverage: result.coverage,
    unresolvedCount: result.unresolved.length,
    diagnosticsCount: result.diagnostics.length
  };
}

function toStoredProjectScanView(checkpoint: ScanCheckpoint): ProjectScanView {
  const result = checkpoint.result;
  if (!result) throw new Error('MCP_CURSOR_STALE');
  return {
    scanId: checkpoint.scanId,
    status: result.status,
    project: result.project,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    assetCount: result.assetCount,
    scriptCount: result.scriptCount,
    documentSummaries: checkpoint.documents.map((document) => ({
      assetUuid: document.assetUuid,
      revision: document.revision,
      ...document.summary
    })),
    prefabGraph: result.prefabGraph,
    coverage: result.coverage,
    unresolvedCount: result.unresolvedCount,
    diagnosticsCount: result.diagnostics.length
  };
}

/**
 * 从完整项目报告创建一个有界结果页和下一页 cursor。
 *
 * @param input 当前全部条目、扫描上下文和 cursor 类型。
 * @returns 当前页偏移、条目、总数和下一页 cursor。
 */
function createReportPage<T>(input: {
  items: T[];
  context: ScanPageContext;
  kind: ReportCursor['kind'];
}) {
  if (input.context.offset > input.items.length) throw new Error('MCP_CURSOR_STALE');
  const items = input.items.slice(
    input.context.offset,
    input.context.offset + input.context.pageSize
  );
  const nextOffset = input.context.offset + items.length;
  return {
    offset: input.context.offset,
    pageSize: input.context.pageSize,
    total: input.items.length,
    items,
    nextCursor: nextOffset < input.items.length
      ? encodeReportCursor({
          version: 1,
          kind: input.kind,
          projectId: input.context.editor.projectId,
          editorInstanceId: input.context.editor.editorInstanceId,
          report: input.context.paths.reportRelativePath,
          checkpoint: input.context.paths.checkpointRelativePath,
          pageSize: input.context.pageSize,
          offset: nextOffset,
          scanId: input.context.report.scanId,
          reportHash: input.context.reportHash,
          checkpointHash: input.context.checkpointHash
        })
      : null
  };
}

/**
 * 准备服务端授权报告根内的项目报告和 checkpoint 目标路径。
 *
 * @param configuredRoot MCP 进程配置的报告根目录。
 * @param input AI 提供的相对报告与可选续扫路径。
 * @param kind 当前扫描报告类型。
 * @returns 规范化授权根、相对路径和真实目标路径。
 */
async function prepareScanPaths(
  configuredRoot: string,
  input: ProjectScanToolInput,
  kind: ReportCursor['kind']
): Promise<PreparedScanPaths> {
  const reportRoot = await prepareReportRoot(configuredRoot);
  const reportRelativePath = requireRelativeJsonPath(
    input.report ?? `mcp/${kind}-${randomUUID()}.json`,
    'INVALID_REPORT_PATH'
  );
  const checkpointRelativePath = input.resume
    ? requireRelativeJsonPath(input.resume, 'INVALID_RESUME_PATH')
    : deriveCheckpointPath(reportRelativePath);
  const reportPath = await prepareTargetPath(
    reportRoot,
    reportRelativePath,
    'INVALID_REPORT_PATH'
  );
  const checkpointPath = await prepareTargetPath(
    reportRoot,
    checkpointRelativePath,
    input.resume ? 'INVALID_RESUME_PATH' : 'INVALID_REPORT_PATH'
  );
  if (pathsEqual(reportPath, checkpointPath)) {
    throw new Error('REPORT_CHECKPOINT_PATH_CONFLICT');
  }
  return {
    reportRoot,
    reportRelativePath: relative(reportRoot, reportPath),
    checkpointRelativePath: relative(reportRoot, checkpointPath),
    reportPath,
    checkpointPath
  };
}

/**
 * 准备 cursor 内已绑定的报告和 checkpoint 路径。
 *
 * @param configuredRoot MCP 进程配置的报告根目录。
 * @param cursor 已通过结构校验的报告 cursor。
 * @returns 位于授权根内的既有报告和 checkpoint 路径。
 */
async function prepareCursorPaths(
  configuredRoot: string,
  cursor: ReportCursor
): Promise<PreparedScanPaths> {
  const reportRoot = await prepareReportRoot(configuredRoot);
  const reportRelativePath = requireRelativeJsonPath(cursor.report, 'INVALID_REPORT_PATH');
  const checkpointRelativePath = requireRelativeJsonPath(
    cursor.checkpoint,
    'INVALID_REPORT_PATH'
  );
  const reportPath = await prepareTargetPath(
    reportRoot,
    reportRelativePath,
    'INVALID_REPORT_PATH'
  );
  const checkpointPath = await prepareTargetPath(
    reportRoot,
    checkpointRelativePath,
    'INVALID_REPORT_PATH'
  );
  if (pathsEqual(reportPath, checkpointPath)) throw new Error('MCP_CURSOR_STALE');
  return {
    reportRoot,
    reportRelativePath: relative(reportRoot, reportPath),
    checkpointRelativePath: relative(reportRoot, checkpointPath),
    reportPath,
    checkpointPath
  };
}

/**
 * 创建并规范化 MCP 进程显式授权的报告根目录。
 *
 * @param configuredRoot MCP 进程配置的报告根目录。
 * @returns 已解析真实路径且可写的报告根目录。
 */
async function prepareReportRoot(configuredRoot: string): Promise<string> {
  try {
    const requestedRoot = resolve(configuredRoot);
    await mkdir(requestedRoot, { recursive: true });
    const rootStat = await stat(requestedRoot);
    if (!rootStat.isDirectory()) throw new Error('NOT_A_DIRECTORY');
    const canonicalRoot = await realpath(requestedRoot);
    await access(canonicalRoot, constants.W_OK);
    return requestedRoot;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`REPORT_ROOT_INVALID:${reason}`);
  }
}

/**
 * 在授权报告根内准备 JSON 文件，并拒绝 Junction、目录和符号链接目标。
 *
 * @param root 已解析真实路径的授权报告根。
 * @param relativePath 待准备的相对 JSON 路径。
 * @param errorCode 当前路径类型对应的稳定错误码。
 * @returns 使用真实父目录拼接出的目标路径。
 */
async function prepareTargetPath(
  root: string,
  relativePath: string,
  errorCode: string
): Promise<string> {
  const target = resolveWithinRoot(root, relativePath, errorCode);
  const requestedParent = dirname(target);
  const canonicalRoot = await realpath(root);
  const existingAncestor = await findExistingAncestor(requestedParent);
  const canonicalAncestor = await realpath(existingAncestor);
  assertWithinRoot(canonicalRoot, canonicalAncestor, errorCode);
  await mkdir(requestedParent, { recursive: true });
  const canonicalParent = await realpath(requestedParent);
  assertWithinRoot(canonicalRoot, canonicalParent, errorCode);
  await access(canonicalParent, constants.W_OK);
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isFile()) throw new Error(errorCode);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return target;
}

/**
 * 校验 AI 路径是报告根内的相对 JSON 文件路径。
 *
 * @param value AI 提供的相对路径。
 * @param errorCode 当前参数对应的稳定错误码。
 * @returns 原始相对路径。
 */
function requireRelativeJsonPath(value: string, errorCode: string): string {
  const segments = value.split(/[\\/]+/);
  const fileName = segments[segments.length - 1]?.toLowerCase();
  if (
    !value
    || value.includes('\0')
    || value.includes(':')
    || value.startsWith('/')
    || value.startsWith('\\')
    || isAbsolute(value)
    || segments.includes('..')
    || !fileName?.endsWith('.json')
    || fileName === '.json'
  ) {
    throw new Error(errorCode);
  }
  return value;
}

/**
 * 读取并校验用户显式提供的续扫 checkpoint，且不连接 Creator。
 *
 * @param input 当前项目扫描参数。
 * @param paths 已准备的报告和 checkpoint 路径。
 * @returns 可信 checkpoint；未请求续扫时返回 undefined。
 */
async function readResumeCheckpoint(
  input: ProjectScanToolInput,
  paths: PreparedScanPaths
): Promise<ScanCheckpoint | undefined> {
  if (!input.resume) return undefined;
  const checkpoint = await readStoredCheckpoint(paths.checkpointPath);
  const mismatches: string[] = [];
  if (checkpoint.projectId !== input.projectId) mismatches.push('projectId');
  if (
    input.editorInstanceId
    && checkpoint.editorInstanceId !== input.editorInstanceId
  ) {
    mismatches.push('editorInstanceId');
  }
  if (
    (input.scanPageSize !== undefined
      && input.scanPageSize !== checkpoint.parameters.pageSize)
    || (input.includeRaw !== undefined
      && input.includeRaw !== checkpoint.parameters.includeRaw)
    || (input.concurrency !== undefined
      && input.concurrency !== checkpoint.parameters.concurrency)
  ) {
    mismatches.push('parameters');
  }
  if (mismatches.length > 0) {
    throw new Error(`SCAN_CHECKPOINT_STALE:${mismatches.join(',')}`);
  }
  return checkpoint;
}

/**
 * 从磁盘读取并验证项目扫描 checkpoint。
 *
 * @param path 授权根内的 checkpoint 路径。
 * @returns 经过结构和一致性校验的 checkpoint。
 */
async function readStoredCheckpoint(path: string): Promise<ScanCheckpoint> {
  try {
    return parseScanCheckpoint(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    const message = readErrorMessage(error);
    if (message.startsWith('SCAN_CHECKPOINT_INVALID')) throw error;
    throw new Error(`SCAN_CHECKPOINT_INVALID:${message}`);
  }
}

/**
 * 确认磁盘报告仍属于当前选择的 Creator 项目和编辑器版本。
 *
 * @param report 已读取的项目扫描报告。
 * @param editor 当前唯一编辑器实例。
 */
function assertReportMatchesEditor(
  report: ProjectScanView,
  editor: EditorSession
): void {
  if (
    report.project.projectId !== editor.projectId
    || report.project.projectPath !== editor.projectPath
    || report.project.creatorVersion !== editor.creatorVersion
  ) {
    throw new Error('MCP_CURSOR_STALE');
  }
}

function deriveCheckpointPath(report: string): string {
  return `${report.slice(0, -'.json'.length)}.checkpoint.json`;
}

function resolveWithinRoot(root: string, relativePath: string, errorCode: string): string {
  const target = resolve(root, relativePath);
  assertWithinRoot(root, target, errorCode);
  return target;
}

function assertWithinRoot(root: string, target: string, errorCode: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(errorCode);
  }
}

async function findExistingAncestor(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function encodeReportCursor(cursor: ReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeReportCursor(value: string): ReportCursor {
  try {
    return ReportCursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    );
  } catch (error) {
    throw new Error(`MCP_CURSOR_INVALID:${readErrorMessage(error)}`);
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true
} as const;

const WriteTransactionOutputSchema = z.object({
  editor: EditorSessionSchema,
  result: WriteTransactionResultSchema
});

const WriteTransactionListOutputSchema = z.object({
  editor: EditorSessionSchema,
  results: z.array(WriteTransactionResultSchema)
});

const TransactionIdInput = {
  ...ProjectSelectorInput,
  transactionId: z.string().min(1)
};

/**
 * 阶段二写工具服务。与只读工具共享 Probe Client、编辑器发现和报告根；
 * 每次写调用都把调用来源、参数、结果写入事务审计。
 */
export class CocosWriteToolService {
  constructor(
    private readonly options: CocosReadonlyToolServiceOptions,
    private readonly editors: CocosReadonlyToolService
  ) {}

  async prepareWrite(input: {
    projectId: string;
    editorInstanceId?: string;
    transactionId: string;
    idempotencyKey: string;
    revision: unknown;
    operations: unknown[];
    save: boolean;
    undoGroup: string;
  }) {
    const editor = await this.editors.resolveEditor(input);
    assertCapability(editor, 'probe.writePrepare');
    const request = WriteTransactionRequestSchema.parse({
      transactionId: input.transactionId,
      idempotencyKey: input.idempotencyKey,
      scope: 'current-document',
      revision: input.revision,
      operations: input.operations,
      save: input.save,
      undoGroup: input.undoGroup
    });
    const result = WriteTransactionResultSchema.parse(await this.options.probeClient.request(
      'probe.writePrepare',
      { selector: toSelector(editor), params: request }
    ));
    await this.audit('cocos_write_prepare', request, result);
    return { editor, result };
  }

  async confirmWrite(input: { projectId: string; editorInstanceId?: string; transactionId: string }) {
    const editor = await this.editors.resolveEditor(input);
    assertCapability(editor, 'probe.writeConfirm');
    const result = WriteTransactionResultSchema.parse(await this.options.probeClient.request(
      'probe.writeConfirm',
      { selector: toSelector(editor), params: { transactionId: input.transactionId } }
    ));
    await this.audit('cocos_write_confirm', null, result);
    return { editor, result };
  }

  async readTransactionStatus(input: { projectId: string; editorInstanceId?: string; transactionId: string }) {
    const editor = await this.editors.resolveEditor(input);
    assertCapability(editor, 'probe.transactionStatus');
    const result = WriteTransactionResultSchema.parse(await this.options.probeClient.request(
      'probe.transactionStatus',
      { selector: toSelector(editor), params: { transactionId: input.transactionId } }
    ));
    return { editor, result };
  }

  async listTransactions(input: { projectId: string; editorInstanceId?: string }) {
    const editor = await this.editors.resolveEditor(input);
    assertCapability(editor, 'probe.transactionList');
    const results = WriteTransactionResultSchema.array().parse(await this.options.probeClient.request(
      'probe.transactionList',
      { selector: toSelector(editor), params: {} }
    ));
    return { editor, results };
  }

  async rollbackTransaction(input: { projectId: string; editorInstanceId?: string; transactionId: string }) {
    const editor = await this.editors.resolveEditor(input);
    assertCapability(editor, 'probe.transactionRollback');
    const result = WriteTransactionResultSchema.parse(await this.options.probeClient.request(
      'probe.transactionRollback',
      { selector: toSelector(editor), params: { transactionId: input.transactionId } }
    ));
    await this.audit('cocos_transaction_rollback', null, result);
    return { editor, result };
  }

  private async audit(
    event: string,
    request: unknown,
    result: { transactionId: string; status: string; verification: unknown }
  ): Promise<void> {
    await appendWriteJournalEntry(this.options.reportRoot, {
      transactionId: result.transactionId,
      idempotencyKey: request
        ? (request as { idempotencyKey: string }).idempotencyKey
        : '',
      at: new Date().toISOString(),
      event,
      source: 'mcp',
      request: request ?? undefined,
      verification: result.verification ?? undefined,
      details: { status: result.status }
    });
  }
}

/**
 * 登记阶段二写工具。仅当 MCP 以显式 --enable-writes 启动时由 server.ts 调用；
 * 默认只读启动路径不经过这里，写工具无法因配置错误而暴露。
 *
 * @param server 待登记工具的 MCP Server。
 * @param service 写事务服务。
 */
export function registerCocosWriteTools(server: McpServer, service: CocosWriteToolService): void {
  server.registerTool('cocos_write_prepare', {
    description: '准备事务式写入：登记事务、幂等去重并校验 Revision 前置（scope 限当前文档）。',
    inputSchema: {
      ...ProjectSelectorInput,
      transactionId: z.string().min(1),
      idempotencyKey: z.string().min(1),
      revision: RevisionPreconditionSchema,
      operations: z.array(WriteOperationSchema).min(1),
      save: z.boolean(),
      undoGroup: z.string().min(1)
    },
    outputSchema: WriteTransactionOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.prepareWrite(input)));

  server.registerTool('cocos_write_confirm', {
    description: '确认并执行已准备的事务：复查 Revision 前置、执行写入、保存并重读验证。',
    inputSchema: TransactionIdInput,
    outputSchema: WriteTransactionOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.confirmWrite(input)));

  server.registerTool('cocos_transaction_status', {
    description: '查询单个写事务的当前状态、验证报告和回滚证据。',
    inputSchema: TransactionIdInput,
    outputSchema: WriteTransactionOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.readTransactionStatus(input)));

  server.registerTool('cocos_transaction_list', {
    description: '只列出未完成写事务，供重连恢复入口使用。',
    inputSchema: ProjectSelectorInput,
    outputSchema: WriteTransactionListOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.listTransactions(input)));

  server.registerTool('cocos_transaction_rollback', {
    description: '回滚已提交或已失败的写事务，并返回回滚验证证据。',
    inputSchema: TransactionIdInput,
    outputSchema: WriteTransactionOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => toToolResult(await service.rollbackTransaction(input)));
}
