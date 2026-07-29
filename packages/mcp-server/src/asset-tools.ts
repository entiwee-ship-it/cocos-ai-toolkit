import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WriteRevisionSnapshotSchema, type WriteTransactionResult } from '@cocos-ai/protocol';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CocosReadonlyToolService,
  CocosWriteToolService,
  type CocosReadonlyToolServiceOptions,
  type EditorSession
} from './tools.js';

const ProjectSelectorInput = {
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional()
};

const ToolOutputSchema = z.looseObject({});

export const COCOS_ASSET_WRITE_TOOL_NAMES = [
  'cocos_asset_create',
  'cocos_asset_move',
  'cocos_asset_write_meta',
  'cocos_asset_update_text',
  'cocos_asset_delete'
] as const;

interface ProjectSelector {
  projectId: string;
  editorInstanceId?: string;
}

interface AssetCreateInput extends ProjectSelector {
  assetUrl: string;
  assetKind: 'folder' | 'component-script' | 'prefab';
  content?: string;
  sourceNodeUuid?: string;
  mode: 'preview' | 'apply';
}

interface AssetIdentityInput extends ProjectSelector {
  uuid: string;
  mode: 'preview' | 'apply';
}

interface AssetUpdateTextInput extends AssetIdentityInput {
  expectedCurrentSha256?: string;
  oldText: string;
  newText: string;
}

export class CocosAssetWriteToolService {
  constructor(
    private readonly options: CocosReadonlyToolServiceOptions,
    private readonly readonlyService: CocosReadonlyToolService,
    private readonly writeService: CocosWriteToolService
  ) {}

  async createAsset(input: AssetCreateInput) {
    assertAssetUrl(input.assetUrl);
    if (await this.findAssetByUrl(input, input.assetUrl)) {
      throw new Error(`ASSET_ALREADY_EXISTS:${input.assetUrl}`);
    }
    const operation = this.buildCreateOperation(input);
    const editor = await this.readonlyService.resolveEditor(input);
    if (input.mode === 'preview') return { editor, mode: input.mode, operation };

    const result = await this.execute(editor, input, operation, 'asset-create');
    const asset = await this.findAssetByUrl(input, input.assetUrl);
    if (!asset) throw new Error(`ASSET_CREATE_POSTVERIFY_FAILED:${input.assetUrl}`);
    return { editor, mode: input.mode, operation, result, asset };
  }

  async moveAsset(input: AssetIdentityInput & { targetUrl: string }) {
    assertAssetUrl(input.targetUrl);
    const details = await this.readAssetDetails(input);
    const sourceUrl = readAssetUrl(details.asset, input.uuid);
    if (sourceUrl === input.targetUrl) throw new Error(`ASSET_MOVE_NOOP:${sourceUrl}`);
    if (await this.findAssetByUrl(input, input.targetUrl)) {
      throw new Error(`ASSET_ALREADY_EXISTS:${input.targetUrl}`);
    }
    const operation = {
      type: 'asset.move' as const,
      sourceUrl,
      targetUrl: input.targetUrl,
      expectedAssetUuid: input.uuid
    };
    if (input.mode === 'preview') {
      return { editor: details.editor, mode: input.mode, asset: details.asset, operation };
    }
    const result = await this.execute(details.editor, input, operation, 'asset-move');
    const moved = await this.findAssetByUrl(input, input.targetUrl);
    if (!moved || moved.assetUuid !== input.uuid || await this.findAssetByUrl(input, sourceUrl)) {
      throw new Error(`ASSET_MOVE_POSTVERIFY_FAILED:${input.uuid}`);
    }
    return { editor: details.editor, mode: input.mode, asset: moved, operation, result };
  }

  async writeMeta(input: AssetIdentityInput & { meta: Record<string, unknown> }) {
    const details = await this.readAssetDetails(input);
    const assetUrl = readAssetUrl(details.asset, input.uuid);
    const requestedUuid = input.meta.uuid;
    if (typeof requestedUuid === 'string' && requestedUuid !== input.uuid) {
      throw new Error(`ASSET_META_UUID_MUTATION_FORBIDDEN:${requestedUuid}`);
    }
    const operation = {
      type: 'asset.write_meta' as const,
      assetUrl,
      expectedAssetUuid: input.uuid,
      meta: input.meta
    };
    if (input.mode === 'preview') {
      return {
        editor: details.editor,
        mode: input.mode,
        asset: details.asset,
        beforeMeta: details.meta,
        operation
      };
    }
    const result = await this.execute(details.editor, input, operation, 'asset-write-meta');
    const verified = await this.readAssetDetails(input);
    if (verified.asset.uuid !== input.uuid || !isDeepStrictEqual(verified.meta, input.meta)) {
      throw new Error(`ASSET_META_POSTVERIFY_FAILED:${input.uuid}`);
    }
    return { editor: details.editor, mode: input.mode, asset: verified.asset, meta: verified.meta, result };
  }

  async updateText(input: AssetUpdateTextInput) {
    const details = await this.readAssetDetails(input);
    const assetUrl = readAssetUrl(details.asset, input.uuid);
    assertTextAssetUrl(assetUrl);
    if (input.oldText === input.newText) throw new Error('ASSET_TEXT_REPLACEMENT_NOOP');
    const operation = {
      type: 'asset.update_text' as const,
      assetUrl,
      expectedAssetUuid: input.uuid,
      ...(input.expectedCurrentSha256 ? { expectedCurrentSha256: input.expectedCurrentSha256 } : {}),
      oldText: input.oldText,
      newText: input.newText
    };
    if (input.mode === 'preview') {
      return { editor: details.editor, mode: input.mode, asset: details.asset, operation };
    }
    const result = await this.execute(details.editor, input, operation, 'asset-update-text');
    const verified = await this.readAssetDetails(input);
    if (verified.asset.uuid !== input.uuid) throw new Error(`ASSET_TEXT_POSTVERIFY_FAILED:${input.uuid}`);
    return { editor: details.editor, mode: input.mode, asset: verified.asset, operation, result };
  }

  async deleteAsset(input: AssetIdentityInput & {
    confirmAssetUrl?: string;
    confirmReferenced?: boolean;
  }) {
    const details = await this.readAssetDetails(input);
    const assetUrl = readAssetUrl(details.asset, input.uuid);
    const impact = {
      dependencies: details.dependencies,
      users: details.users,
      userCount: details.users.length,
      irreversible: true
    };
    if (input.mode === 'preview') {
      return { editor: details.editor, mode: input.mode, asset: details.asset, impact };
    }
    if (input.confirmAssetUrl !== assetUrl) {
      throw new Error(`ASSET_DELETE_CONFIRMATION_REQUIRED:${assetUrl}`);
    }
    if (impact.userCount > 0 && input.confirmReferenced !== true) {
      throw new Error(`ASSET_DELETE_REFERENCES_CONFIRMATION_REQUIRED:${impact.userCount}`);
    }
    const operation = {
      type: 'asset.delete' as const,
      assetUrl,
      expectedAssetUuid: input.uuid
    };
    const result = await this.execute(details.editor, input, operation, 'asset-delete');
    if (await this.findAssetByUrl(input, assetUrl) || await this.findAssetByUuid(input, input.uuid)) {
      throw new Error(`ASSET_DELETE_POSTVERIFY_FAILED:${input.uuid}`);
    }
    return { editor: details.editor, mode: input.mode, asset: details.asset, impact, result };
  }

  private buildCreateOperation(input: AssetCreateInput) {
    if (input.assetKind === 'prefab') {
      if (!input.sourceNodeUuid) {
        throw new Error('ASSET_CREATE_SOURCE_NODE_REQUIRED:请使用现有节点生成 Prefab');
      }
      if (!input.assetUrl.toLowerCase().endsWith('.prefab')) {
        throw new Error(`PREFAB_ASSET_URL_INVALID:${input.assetUrl}`);
      }
      return {
        type: 'prefab.create_from_node' as const,
        nodeUuid: input.sourceNodeUuid,
        assetUrl: input.assetUrl
      };
    }
    if (input.assetKind === 'component-script' && (!input.content || !input.assetUrl.toLowerCase().endsWith('.ts'))) {
      throw new Error(`COMPONENT_SCRIPT_CONTENT_REQUIRED:${input.assetUrl}`);
    }
    return {
      type: 'asset.create' as const,
      assetUrl: input.assetUrl,
      assetKind: input.assetKind,
      ...(input.content ? { content: input.content } : {})
    };
  }

  private async execute(
    editor: EditorSession,
    input: ProjectSelector,
    operation: Record<string, unknown>,
    kind: string
  ): Promise<WriteTransactionResult> {
    const transactionId = `${kind}-${randomUUID()}`;
    const revision = await this.captureWriteRevision(editor);
    const prepared = await this.writeService.prepareWrite({
      ...input,
      transactionId,
      idempotencyKey: transactionId,
      revision,
      operations: [operation],
      save: false,
      undoGroup: transactionId
    });
    const result = prepared.result.status === 'validated'
      ? (await this.writeService.confirmWrite({ ...input, transactionId })).result
      : prepared.result;
    if (result.status !== 'committed' || result.verification?.passed !== true) {
      throw new Error(`ASSET_TRANSACTION_FAILED:${JSON.stringify(result)}`);
    }
    return result;
  }

  private async captureWriteRevision(editor: EditorSession) {
    try {
      const snapshot = WriteRevisionSnapshotSchema.parse(await this.options.probeClient.request(
        'probe.writeRevision',
        { selector: { projectId: editor.projectId, editorInstanceId: editor.editorInstanceId }, params: {} }
      ));
      return snapshot.revision;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('ASSET_FILE_PATH_UNAVAILABLE')) throw error;
      return {
        document: null,
        hierarchy: null,
        assetDatabase: null,
        scriptCompilation: null,
        prefabGraph: null
      };
    }
  }

  private async readAssetDetails(input: ProjectSelector & { uuid: string }) {
    const dependencies: string[] = [];
    const users: string[] = [];
    let cursor: string | undefined;
    let asset: Awaited<ReturnType<CocosReadonlyToolService['inspectAsset']>>['asset'] | undefined;
    let editor: EditorSession | undefined;
    let meta: unknown = null;
    do {
      const result = await this.readonlyService.inspectAsset({
        ...input,
        includeRaw: true,
        pageSize: 500,
        ...(cursor ? { cursor } : {})
      });
      editor = result.editor;
      asset = result.asset;
      meta = result.meta;
      for (const relation of result.page.items) {
        (relation.kind === 'dependency' ? dependencies : users).push(relation.assetUuid);
      }
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor);
    if (!editor || !asset) throw new Error('ASSET_DETAILS_UNAVAILABLE');
    return { editor, asset, meta, dependencies, users };
  }

  private async findAssetByUrl(input: ProjectSelector, assetUrl: string) {
    let cursor: string | undefined;
    do {
      const result = await this.readonlyService.searchAssets({
        ...input,
        pattern: assetUrl,
        pageSize: 200,
        ...(cursor ? { cursor } : {})
      });
      const asset = result.page.items.find((item) => item.url === assetUrl || item.path === assetUrl);
      if (asset) return asset;
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor);
    return undefined;
  }

  private async findAssetByUuid(input: ProjectSelector, uuid: string) {
    let cursor: string | undefined;
    do {
      const result = await this.readonlyService.searchAssets({
        ...input,
        pattern: uuid,
        pageSize: 200,
        ...(cursor ? { cursor } : {})
      });
      const asset = result.page.items.find((item) => item.assetUuid === uuid);
      if (asset) return asset;
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor);
    return undefined;
  }
}

export function registerCocosAssetWriteTools(
  server: McpServer,
  service: CocosAssetWriteToolService
): void {
  server.registerTool('cocos_asset_create', {
    description: '预览或创建目录/组件脚本；Prefab 必须来自真实节点。ALREADY_EXISTS 时换 URL，SOURCE_NODE_REQUIRED 时改用 cocos_prefab_create。',
    inputSchema: {
      ...ProjectSelectorInput,
      assetUrl: z.string().min(1),
      assetKind: z.enum(['folder', 'component-script', 'prefab']),
      content: z.string().min(1).optional(),
      sourceNodeUuid: z.string().min(1).optional(),
      mode: z.enum(['preview', 'apply'])
    },
    outputSchema: ToolOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (input) => toToolResult(await service.createAsset(input)));

  server.registerTool('cocos_asset_move', {
    description: '通过 AssetDB 移动资产并验证 UUID 不变；MOVE_NOOP/ALREADY_EXISTS 时修正目标 URL，POSTVERIFY_FAILED 时停止后续写入。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      targetUrl: z.string().min(1),
      mode: z.enum(['preview', 'apply'])
    },
    outputSchema: ToolOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (input) => toToolResult(await service.moveAsset(input)));

  server.registerTool('cocos_asset_write_meta', {
    description: '通过 AssetDB 写 Meta并重读；禁止改 UUID，META_UUID_MUTATION_FORBIDDEN 时移除新 UUID 后重新 preview。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      meta: z.record(z.string(), z.unknown()),
      mode: z.enum(['preview', 'apply'])
    },
    outputSchema: ToolOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (input) => toToolResult(await service.writeMeta(input)));

  server.registerTool('cocos_asset_update_text', {
    description: '按精确 UUID 和唯一 oldText 安全更新 TypeScript/JavaScript/JSON 资产；MATCH_COUNT_INVALID 时重读后缩小旧文本锚点。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      expectedCurrentSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      oldText: z.string().min(1),
      newText: z.string().min(1),
      mode: z.enum(['preview', 'apply'])
    },
    outputSchema: ToolOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (input) => toToolResult(await service.updateText(input)));

  server.registerTool('cocos_asset_delete', {
    description: '先预览引用影响，再用精确 assetUrl/confirmReferenced 确认删除；OUTCOME_UNKNOWN 时先查事务状态，禁止直接重试。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      mode: z.enum(['preview', 'apply']),
      confirmAssetUrl: z.string().min(1).optional(),
      confirmReferenced: z.boolean().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async (input) => toToolResult(await service.deleteAsset(input)));
}

function assertAssetUrl(assetUrl: string): void {
  if (!assetUrl.startsWith('db://assets/') || assetUrl.includes('\\') || assetUrl.split('/').includes('..')) {
    throw new Error(`ASSET_URL_INVALID:${assetUrl}`);
  }
}

function assertTextAssetUrl(assetUrl: string): void {
  assertAssetUrl(assetUrl);
  const lower = assetUrl.toLowerCase();
  if (!['.ts', '.js', '.json'].some((extension) => lower.endsWith(extension))) {
    throw new Error(`ASSET_TEXT_TYPE_REQUIRED:${assetUrl}`);
  }
}

function readAssetUrl(asset: { url?: string | null; path?: string | null }, uuid: string): string {
  const assetUrl = asset.url ?? asset.path;
  if (!assetUrl) throw new Error(`ASSET_URL_UNAVAILABLE:${uuid}`);
  return assetUrl;
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
