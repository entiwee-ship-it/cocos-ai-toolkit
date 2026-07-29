import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DesignDocumentOperationSchema,
  DesignTargetNodeSchema,
  WriteRevisionSnapshotSchema,
  type DesignTargetDocument,
  type WriteTransactionResult
} from '@cocos-ai/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CocosDesignToolService,
  CocosReadonlyToolService,
  CocosWriteToolService,
  type CocosReadonlyToolServiceOptions
} from './tools.js';

const ProjectSelectorInput = {
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional()
};

const PrefabTargetInput = {
  ...ProjectSelectorInput,
  uuid: z.string().min(1),
  tree: z.array(z.unknown()),
  operations: z.array(z.unknown()).optional(),
  prune: z.boolean().optional()
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

const PrefabSearchCursorSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1),
  pattern: z.string(),
  offset: z.number().int().nonnegative(),
  pageSize: z.number().int().min(1).max(100),
  revision: z.string().min(1)
});

const PrefabCreationInspectSchema = z.object({
  document: z.object({ assetUuid: z.string().nullable().optional() }).passthrough(),
  tree: z.array(z.object({
    uuid: z.string().min(1),
    fileId: z.string().nullable().optional(),
    name: z.string(),
    path: z.string()
  }).passthrough())
});

interface ProjectSelector {
  projectId: string;
  editorInstanceId?: string;
}

interface PrefabTargetInput extends ProjectSelector {
  uuid: string;
  tree: z.infer<typeof DesignTargetNodeSchema>[];
  operations?: z.infer<typeof DesignDocumentOperationSchema>[];
  prune?: boolean;
}

interface PrefabEditInput extends PrefabTargetInput {
  mode: 'preview' | 'apply';
}

interface PrefabCreateInput extends ProjectSelector {
  assetUrl: string;
  tree: z.infer<typeof DesignTargetNodeSchema>[];
  rootId: string;
  mode: 'preview' | 'apply';
}

interface PrefabDeleteInput extends ProjectSelector {
  uuid: string;
  mode: 'preview' | 'apply';
  confirmAssetUrl?: string;
  confirmReferenced?: boolean;
}

export const COCOS_PREFAB_READONLY_TOOL_NAMES = [
  'cocos_editor_list',
  'cocos_prefab_search',
  'cocos_prefab_inspect',
  'cocos_prefab_verify'
] as const;

export const COCOS_PREFAB_WRITE_TOOL_NAMES = [
  'cocos_prefab_create',
  'cocos_prefab_edit',
  'cocos_prefab_delete'
] as const;

/** 组合现有底层服务的 Prefab 场景门面。 */
export class CocosPrefabToolService {
  constructor(
    private readonly options: CocosReadonlyToolServiceOptions,
    private readonly readonlyService: CocosReadonlyToolService,
    private readonly designService: CocosDesignToolService,
    private readonly writeService?: CocosWriteToolService
  ) {}

  async listEditors() {
    return { editors: await this.readonlyService.listEditors() };
  }

  async searchPrefabs(input: ProjectSelector & {
    pattern: string;
    pageSize?: number;
    cursor?: string;
  }) {
    const matches = [] as Array<Record<string, unknown> & {
      assetUuid: string;
      type: string | null;
      url: string | null;
      path: string | null;
      filePath: string | null;
    }>;
    let assetCursor: string | undefined;
    let editor: Awaited<ReturnType<CocosReadonlyToolService['resolveEditor']>> | undefined;
    do {
      const result = await this.readonlyService.searchAssets({
        projectId: input.projectId,
        ...(input.editorInstanceId ? { editorInstanceId: input.editorInstanceId } : {}),
        pattern: input.pattern,
        pageSize: 200,
        ...(assetCursor ? { cursor: assetCursor } : {})
      });
      editor = result.editor;
      matches.push(...result.page.items.filter(isPrefabAsset));
      assetCursor = result.page.nextCursor ?? undefined;
    } while (assetCursor);
    if (!editor) throw new Error('EDITOR_INSTANCE_NOT_FOUND');

    const revision = createHash('sha256')
      .update(JSON.stringify(matches.map((asset) => [asset.assetUuid, asset.url, asset.type])))
      .digest('hex');
    const cursor = input.cursor ? decodePrefabSearchCursor(input.cursor) : undefined;
    if (cursor && (
      cursor.projectId !== editor.projectId
      || cursor.editorInstanceId !== editor.editorInstanceId
      || cursor.pattern !== input.pattern.trim().toLowerCase()
      || cursor.revision !== revision
      || (input.pageSize !== undefined && input.pageSize !== cursor.pageSize)
    )) {
      throw new Error('MCP_CURSOR_STALE');
    }
    const pageSize = cursor?.pageSize ?? input.pageSize ?? 25;
    const offset = cursor?.offset ?? 0;
    if (offset > matches.length) throw new Error('MCP_CURSOR_STALE');
    const items = matches.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      editor,
      query: { pattern: input.pattern },
      page: {
        offset,
        pageSize,
        total: matches.length,
        items,
        nextCursor: nextOffset < matches.length
          ? encodePrefabSearchCursor({
              version: 1,
              projectId: editor.projectId,
              editorInstanceId: editor.editorInstanceId,
              pattern: input.pattern.trim().toLowerCase(),
              offset: nextOffset,
              pageSize,
              revision
            })
          : null
      }
    };
  }

  async inspectPrefab(input: ProjectSelector & { uuid: string }) {
    const details = await this.readPrefabDetails(input);
    await this.openPrefab(input);
    const { editor, inspect } = await this.designService.inspectDesign(input);
    return {
      editor,
      asset: details.asset,
      relations: details.relations,
      inspect
    };
  }

  async verifyPrefab(input: PrefabTargetInput) {
    const details = await this.readPrefabDetails(input);
    await this.openPrefab(input);
    const { editor, report } = await this.designService.verifyDesign({
      ...input,
      target: createPrefabTarget(input)
    });
    return { editor, asset: details.asset, report };
  }

  async createPrefab(input: PrefabCreateInput) {
    if (!this.writeService) throw new Error('PREFAB_WRITES_DISABLED');
    assertPrefabAssetUrl(input.assetUrl);
    if (input.tree.length !== 1 || input.tree[0]?.id !== input.rootId) {
      throw new Error(`PREFAB_ROOT_ID_INVALID:${input.rootId}`);
    }
    if (await this.findPrefabByAssetUrl(input, input.assetUrl)) {
      throw new Error(`ASSET_ALREADY_EXISTS:${input.assetUrl}`);
    }

    const inspected = await this.designService.inspectDesign(input);
    const target = createPrefabCreationTarget(inspected.inspect, input.tree[0]);
    const { editor, preview } = await this.designService.previewDesign({ ...input, target });
    const operation = {
      type: 'prefab.create_from_node' as const,
      nodeUuid: input.rootId,
      assetUrl: input.assetUrl
    };
    if (input.mode === 'preview') {
      return {
        editor,
        mode: input.mode,
        assetUrl: input.assetUrl,
        rootId: input.rootId,
        preview,
        operation
      };
    }

    const applied = await this.designService.applyDesign({
      ...input,
      target,
      executionId: `prefab-create-tree-${randomUUID()}`,
      revision: preview.revision,
      save: false,
      allowDirtyAfterFirstCommit: true
    });
    const applyResult = applied.result as unknown as {
      status: string;
      transactions: WriteTransactionResult[];
      resolutions: { nodes: Record<string, string> };
      verification: { passed: boolean };
    };
    if (applyResult.status !== 'committed' || !applyResult.verification.passed) {
      throw new Error(`PREFAB_CREATE_TREE_FAILED:${JSON.stringify(applied.result)}`);
    }
    const sourceNodeUuid = applyResult.resolutions.nodes[input.rootId];
    if (!sourceNodeUuid) {
      const rollback = await this.rollbackDesignTransactions(input, applyResult.transactions);
      throw new Error(`PREFAB_CREATE_ROOT_UNRESOLVED:${JSON.stringify({ rootId: input.rootId, rollback })}`);
    }

    const revision = await this.captureWriteRevision(editor);
    const transactionId = `prefab-create-asset-${randomUUID()}`;
    let prepared: Awaited<ReturnType<CocosWriteToolService['prepareWrite']>>;
    try {
      prepared = await this.writeService.prepareWrite({
        ...input,
        transactionId,
        idempotencyKey: transactionId,
        revision,
        operations: [{ type: 'prefab.create_from_node', nodeUuid: sourceNodeUuid, assetUrl: input.assetUrl }],
        save: false,
        allowDirty: true,
        undoGroup: `prefab-create-${input.rootId}`
      });
    } catch (error) {
      const rollback = await this.rollbackDesignTransactions(input, applyResult.transactions);
      throw new Error(`PREFAB_CREATE_PREPARE_FAILED:${JSON.stringify({
        error: readErrorMessage(error),
        rollback
      })}`);
    }

    let created: WriteTransactionResult;
    if (prepared.result.status === 'committed') {
      created = prepared.result;
    } else if (prepared.result.status === 'validated') {
      try {
        created = (await this.writeService.confirmWrite({ ...input, transactionId })).result;
      } catch (error) {
        throw new Error(`PREFAB_CREATE_CONFIRM_OUTCOME_UNKNOWN:${transactionId}:${readErrorMessage(error)}`);
      }
    } else {
      const rollback = await this.rollbackDesignTransactions(input, applyResult.transactions);
      throw new Error(`PREFAB_CREATE_PREPARE_FAILED:${JSON.stringify({ result: prepared.result, rollback })}`);
    }
    if (created.status !== 'committed' || created.verification?.passed !== true) {
      const rollback = await this.rollbackDesignTransactions(input, applyResult.transactions);
      throw new Error(`PREFAB_CREATE_COMMIT_FAILED:${JSON.stringify({ result: created, rollback })}`);
    }

    const createdAsset = await this.findPrefabByAssetUrl(input, input.assetUrl);
    if (!createdAsset) {
      throw new Error(`PREFAB_CREATE_POSTVERIFY_FAILED:${transactionId}:ASSET_NOT_FOUND`);
    }
    const cleanupTransaction = await this.removeTemporaryPrefabInstance(
      input,
      editor,
      createdAsset.assetUuid,
      input.rootId
    );
    const prefab = await this.inspectPrefab({ ...input, uuid: createdAsset.assetUuid });
    const cleanup = {
      strategy: 'removed-temporary-instance' as const,
      transactionIds: [...new Set([
        ...applyResult.transactions
        .filter((result) => result.status === 'committed')
        .map((result) => result.transactionId),
        cleanupTransaction.transactionId
      ])]
    };
    return {
      editor,
      mode: input.mode,
      assetUrl: input.assetUrl,
      rootId: input.rootId,
      sourceNodeUuid,
      preview,
      apply: applied.result,
      create: created,
      cleanup,
      prefab
    };
  }

  async editPrefab(input: PrefabEditInput) {
    if (!this.writeService) throw new Error('PREFAB_WRITES_DISABLED');
    const details = await this.readPrefabDetails(input);
    await this.openPrefab(input);
    const target = createPrefabTarget(input);
    const { editor, preview } = await this.designService.previewDesign({ ...input, target });
    if (input.mode === 'preview') {
      return { editor, asset: details.asset, mode: input.mode, preview };
    }

    const { result } = await this.designService.applyDesign({
      ...input,
      target,
      executionId: `prefab-edit-${randomUUID()}`
    });
    const apply = result as {
      status?: string;
      verification?: { passed?: boolean };
    };
    if (apply.status !== 'committed' || apply.verification?.passed !== true) {
      throw new Error(`PREFAB_EDIT_APPLY_FAILED:${JSON.stringify(result)}`);
    }
    const verified = await this.designService.verifyDesign({
      ...input,
      target: createPostApplyVerificationTarget(target)
    });
    if (!verified.report.passed) {
      throw new Error(`PREFAB_EDIT_VERIFY_FAILED:${JSON.stringify(verified.report)}`);
    }
    return {
      editor,
      asset: details.asset,
      mode: input.mode,
      preview,
      apply: result,
      verification: verified.report
    };
  }

  async deletePrefab(input: PrefabDeleteInput) {
    if (!this.writeService) throw new Error('PREFAB_WRITES_DISABLED');
    const details = await this.readPrefabDetails(input);
    const assetUrl = details.asset.url ?? details.asset.path;
    if (!assetUrl) throw new Error(`PREFAB_ASSET_URL_UNAVAILABLE:${input.uuid}`);
    const impact = {
      dependencies: details.relations.dependencies,
      users: details.relations.users,
      userCount: details.relations.users.length,
      irreversible: true
    };
    if (input.mode === 'preview') {
      return {
        editor: details.editor,
        mode: input.mode,
        asset: details.asset,
        impact
      };
    }
    if (input.confirmAssetUrl !== assetUrl) {
      throw new Error(`PREFAB_DELETE_CONFIRMATION_REQUIRED:${assetUrl}`);
    }
    if (impact.userCount > 0 && input.confirmReferenced !== true) {
      throw new Error(`PREFAB_DELETE_REFERENCES_CONFIRMATION_REQUIRED:${impact.userCount}`);
    }

    const revision = await this.captureWriteRevision(details.editor);
    const transactionId = `prefab-delete-${randomUUID()}`;
    const prepared = await this.writeService.prepareWrite({
      ...input,
      transactionId,
      idempotencyKey: transactionId,
      revision,
      operations: [{ type: 'asset.delete', assetUrl, expectedAssetUuid: input.uuid }],
      save: false,
      undoGroup: `prefab-delete-${input.uuid}`
    });
    let deleted: WriteTransactionResult;
    if (prepared.result.status === 'committed') {
      deleted = prepared.result;
    } else if (prepared.result.status === 'validated') {
      try {
        deleted = (await this.writeService.confirmWrite({ ...input, transactionId })).result;
      } catch (error) {
        throw new Error(`PREFAB_DELETE_CONFIRM_OUTCOME_UNKNOWN:${transactionId}:${readErrorMessage(error)}`);
      }
    } else {
      throw new Error(`PREFAB_DELETE_PREPARE_FAILED:${JSON.stringify(prepared.result)}`);
    }
    if (deleted.status !== 'committed' || deleted.verification?.passed !== true) {
      throw new Error(`PREFAB_DELETE_COMMIT_FAILED:${JSON.stringify(deleted)}`);
    }
    if (
      await this.findPrefabByAssetUrl(input, assetUrl)
      || await this.findPrefabByUuid(input, input.uuid)
    ) {
      throw new Error(`PREFAB_DELETE_POSTVERIFY_FAILED:${input.uuid}`);
    }
    return {
      editor: details.editor,
      mode: input.mode,
      asset: details.asset,
      impact,
      deleted: true,
      result: deleted
    };
  }

  /** 读取全部依赖页，且在任何打开/写入前确认目标确实是 Prefab。 */
  private async readPrefabDetails(input: ProjectSelector & { uuid: string }) {
    const relations = { dependencies: [] as string[], users: [] as string[] };
    let cursor: string | undefined;
    let asset: Awaited<ReturnType<CocosReadonlyToolService['inspectAsset']>>['asset'] | undefined;
    let editor: Awaited<ReturnType<CocosReadonlyToolService['resolveEditor']>> | undefined;
    do {
      const result = await this.readonlyService.inspectAsset({
        ...input,
        pageSize: 500,
        ...(cursor ? { cursor } : {})
      });
      editor = result.editor;
      asset = result.asset;
      for (const relation of result.page.items) {
        relations[relation.kind === 'dependency' ? 'dependencies' : 'users'].push(relation.assetUuid);
      }
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor);
    if (!asset || !editor) throw new Error('ASSET_DETAILS_UNAVAILABLE');
    if (!isPrefabAsset(asset)) throw new Error(`ASSET_NOT_PREFAB:${input.uuid}`);
    return { editor, asset, relations };
  }

  /** 通过 Creator 打开资产，并等待编辑器当前文档身份切换到目标 UUID。 */
  private async openPrefab(input: ProjectSelector & { uuid: string }): Promise<void> {
    await this.readonlyService.openAsset(input);
    const deadline = Date.now() + 5_000;
    do {
      const { state } = await this.readonlyService.readEditorState(input);
      if (state.document.assetUuid === input.uuid && state.ready.scene) return;
      if (Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`PREFAB_OPEN_NOT_READY:${input.uuid}`);
  }

  private async findPrefabByAssetUrl(input: ProjectSelector, assetUrl: string) {
    let cursor: string | undefined;
    do {
      const result = await this.searchPrefabs({ ...input, pattern: assetUrl, pageSize: 100, ...(cursor ? { cursor } : {}) });
      const match = result.page.items.find((asset) => asset.url === assetUrl || asset.path === assetUrl);
      if (match) return match;
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor);
    return undefined;
  }

  private async findPrefabByUuid(input: ProjectSelector, uuid: string) {
    let cursor: string | undefined;
    do {
      const result = await this.searchPrefabs({ ...input, pattern: uuid, pageSize: 100, ...(cursor ? { cursor } : {}) });
      const match = result.page.items.find((asset) => asset.assetUuid === uuid);
      if (match) return match;
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor);
    return undefined;
  }

  private async captureWriteRevision(editor: {
    projectId: string;
    editorInstanceId: string;
  }) {
    const snapshot = WriteRevisionSnapshotSchema.parse(await this.options.probeClient.request(
      'probe.writeRevision',
      {
        selector: { projectId: editor.projectId, editorInstanceId: editor.editorInstanceId },
        params: {}
      }
    ));
    return snapshot.revision;
  }

  private async rollbackDesignTransactions(
    input: ProjectSelector,
    transactions: WriteTransactionResult[]
  ) {
    const transactionIds = [...new Set(transactions
      .filter((result) => result.status === 'committed')
      .map((result) => result.transactionId))].reverse();
    const results = [] as Array<{ transactionId: string; status?: string; error?: string }>;
    for (const transactionId of transactionIds) {
      try {
        const rolledBack = await this.writeService!.rollbackTransaction({ ...input, transactionId });
        results.push({ transactionId, status: rolledBack.result.status });
      } catch (error) {
        results.push({ transactionId, error: readErrorMessage(error) });
      }
    }
    return results;
  }

  private async removeTemporaryPrefabInstance(
    input: ProjectSelector,
    editor: { projectId: string; editorInstanceId: string },
    prefabAssetUuid: string,
    rootId: string
  ): Promise<WriteTransactionResult> {
    const { inspect } = await this.designService.inspectDesign(input);
    const candidateUuids = inspect.prefabInstances.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const instance = value as Record<string, unknown>;
      return instance.sourcePrefabAssetUuid === prefabAssetUuid
        && typeof instance.instanceRootObjectUuid === 'string'
        && instance.instanceRootObjectUuid.length > 0
        ? [instance.instanceRootObjectUuid]
        : [];
    });
    const candidates = [...new Set(candidateUuids)];
    if (candidates.length !== 1) {
      throw new Error(`PREFAB_CREATE_CLEANUP_INSTANCE_AMBIGUOUS:${JSON.stringify({
        prefabAssetUuid,
        rootId,
        candidates
      })}`);
    }
    const revision = await this.captureWriteRevision(editor);
    const transactionId = `prefab-create-cleanup-${randomUUID()}`;
    let prepared: Awaited<ReturnType<CocosWriteToolService['prepareWrite']>>;
    try {
      prepared = await this.writeService!.prepareWrite({
        ...input,
        transactionId,
        idempotencyKey: transactionId,
        revision,
        operations: [{ type: 'node.delete', nodeUuid: candidates[0] }],
        save: false,
        allowDirty: true,
        undoGroup: `prefab-create-cleanup-${rootId}`
      });
    } catch (error) {
      throw new Error(`PREFAB_CREATE_CLEANUP_PREPARE_FAILED:${transactionId}:${readErrorMessage(error)}`);
    }

    let result: WriteTransactionResult;
    if (prepared.result.status === 'committed') {
      result = prepared.result;
    } else if (prepared.result.status === 'validated') {
      try {
        result = (await this.writeService!.confirmWrite({ ...input, transactionId })).result;
      } catch (error) {
        throw new Error(`PREFAB_CREATE_CLEANUP_CONFIRM_OUTCOME_UNKNOWN:${transactionId}:${readErrorMessage(error)}`);
      }
    } else {
      throw new Error(`PREFAB_CREATE_CLEANUP_PREPARE_FAILED:${JSON.stringify(prepared.result)}`);
    }
    if (result.status !== 'committed' || result.verification?.passed !== true) {
      throw new Error(`PREFAB_CREATE_CLEANUP_FAILED:${JSON.stringify(result)}`);
    }
    return result;
  }
}

/** 注册默认 Prefab 档只读工具。 */
export function registerCocosPrefabReadonlyTools(
  server: McpServer,
  service: CocosPrefabToolService
): void {
  server.registerTool('cocos_editor_list', {
    description: '列出当前连接 Probe Server 的 Creator；空列表时启动 Creator/Bridge 后重试。',
    inputSchema: {},
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async () => toToolResult(await service.listEditors()));

  server.registerTool('cocos_prefab_search', {
    description: '在 Creator AssetDB 中只搜索 Prefab；MCP_CURSOR_STALE 时丢弃 cursor 并从第一页重查。',
    inputSchema: {
      ...ProjectSelectorInput,
      pattern: z.string().min(1),
      pageSize: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.searchPrefabs(input)));

  server.registerTool('cocos_prefab_inspect', {
    description: '通过 Creator 打开 Prefab并返回结构、依赖和反向引用；ASSET_NOT_PREFAB/OPEN_NOT_READY 时核对 UUID、刷新 AssetDB 后重试。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1)
    },
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => toToolResult(await service.inspectPrefab(input)));

  server.registerTool('cocos_prefab_verify', {
    description: '打开 Prefab 并独立重读目标；验证失败时检查 report.items，重新 inspect 后修正目标，不要直接重写。',
    inputSchema: PrefabTargetInput,
    outputSchema: ToolOutputSchema,
    annotations: READONLY_ANNOTATIONS
  }, async (input) => withInputValidation(
    'cocos_prefab_verify',
    async () => service.verifyPrefab(parsePrefabTargetInput(input))
  ));
}

/** 注册仅在写能力开启时可见的 Prefab 场景写工具。 */
export function registerCocosPrefabWriteTools(
  server: McpServer,
  service: CocosPrefabToolService
): void {
  server.registerTool('cocos_prefab_create', {
    description: '预览或创建单根 Prefab；PREFAB_ROOT_ID_INVALID 时让 rootId 等于唯一根 ID，ASSET_ALREADY_EXISTS 时改用新 URL 或 edit。',
    inputSchema: {
      ...ProjectSelectorInput,
      assetUrl: z.string().min(1),
      tree: z.array(z.unknown()),
      rootId: z.string().min(1),
      mode: z.enum(['preview', 'apply'])
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => withInputValidation(
    'cocos_prefab_create',
    async () => service.createPrefab({ ...input, tree: parsePrefabTree(input.tree, true) })
  ));

  server.registerTool('cocos_prefab_edit', {
    description: '自动打开 Prefab，预览后事务应用并重读；PLAN_UNRESOLVED/REVISION_* 时按 preview.unresolved 修正并重跑 preview。',
    inputSchema: {
      ...PrefabTargetInput,
      mode: z.enum(['preview', 'apply'])
    },
    outputSchema: ToolOutputSchema,
    annotations: WRITE_ANNOTATIONS
  }, async (input) => withInputValidation(
    'cocos_prefab_edit',
    async () => service.editPrefab({ ...parsePrefabTargetInput(input), mode: input.mode })
  ));

  server.registerTool('cocos_prefab_delete', {
    description: '先预览引用影响，再用精确 assetUrl/confirmReferenced 确认删除；OUTCOME_UNKNOWN 时先查事务状态，禁止直接重试。',
    inputSchema: {
      ...ProjectSelectorInput,
      uuid: z.string().min(1),
      mode: z.enum(['preview', 'apply']),
      confirmAssetUrl: z.string().min(1).optional(),
      confirmReferenced: z.boolean().optional()
    },
    outputSchema: ToolOutputSchema,
    annotations: DELETE_ANNOTATIONS
  }, async (input) => toToolResult(await service.deletePrefab(input)));
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

class McpInputValidationError extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super('MCP_INPUT_INVALID');
  }
}

async function withInputValidation(
  tool: string,
  execute: () => Promise<unknown>
) {
  try {
    return toToolResult(await execute());
  } catch (error) {
    if (!(error instanceof McpInputValidationError)) throw error;
    const payload = { ...error.payload, tool };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true
    };
  }
}

function parsePrefabTargetInput(input: {
  projectId: string;
  editorInstanceId?: string;
  uuid: string;
  tree: unknown[];
  operations?: unknown[];
  prune?: boolean;
}): PrefabTargetInput {
  const { tree, operations, ...selector } = input;
  return {
    ...selector,
    tree: parsePrefabTree(tree, false),
    ...(operations ? { operations: parsePrefabOperations(operations) } : {})
  };
}

function parsePrefabTree(value: unknown, requireRoot: boolean): PrefabTargetInput['tree'] {
  const schema = requireRoot
    ? z.array(DesignTargetNodeSchema).min(1)
    : z.array(DesignTargetNodeSchema);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw createInputValidationError(parsed.error);
  return parsed.data;
}

function parsePrefabOperations(value: unknown): NonNullable<PrefabTargetInput['operations']> {
  const parsed = z.array(DesignDocumentOperationSchema).safeParse(value);
  if (!parsed.success) throw createInputValidationError(parsed.error);
  return parsed.data;
}

function createInputValidationError(error: z.ZodError): McpInputValidationError {
  const first = error.issues[0];
  const path = first?.path.length ? first.path.join('.') : 'input';
  return new McpInputValidationError({
    code: 'MCP_INPUT_INVALID',
    phase: 'input-validation',
    reason: `${path}: ${first?.message ?? '输入不符合协议'}`,
    nextAction: '根据 reason 修正 tree/operations 的字段类型、必填 ID 或引用形态后重新调用',
    details: { issues: error.issues }
  });
}

function createPrefabTarget(input: PrefabTargetInput) {
  return {
    document: { scope: 'current-document' as const, assetUuid: input.uuid },
    tree: input.tree,
    ...(input.operations ? { operations: input.operations } : {}),
    ...(input.prune !== undefined ? { prune: input.prune } : {})
  };
}

function createPostApplyVerificationTarget(
  target: DesignTargetDocument
): DesignTargetDocument {
  const extractedNodeIds = new Set(
    (target.operations ?? [])
      .filter((operation) => operation.type === 'document.extract_subtree')
      .map((operation) => operation.nodeId)
  );
  if (extractedNodeIds.size === 0) return target;
  const filterNodes = (
    nodes: DesignTargetDocument['tree']
  ): DesignTargetDocument['tree'] => nodes.flatMap((node) => (
    extractedNodeIds.has(node.id)
      ? []
      : [{
          ...node,
          ...(node.children ? { children: filterNodes(node.children) } : {})
        }]
  ));
  return {
    ...target,
    tree: filterNodes(target.tree),
    operations: (target.operations ?? []).filter((operation) => (
      operation.type !== 'document.extract_subtree'
    ))
  };
}

function createPrefabCreationTarget(
  currentInput: unknown,
  prefabRoot: z.infer<typeof DesignTargetNodeSchema>
): DesignTargetDocument {
  const current = PrefabCreationInspectSchema.parse(currentInput);
  if (current.tree.length !== 1 || !current.tree[0]) {
    throw new Error(`PREFAB_CREATE_DOCUMENT_ROOT_INVALID:${current.tree.length}`);
  }
  const documentRoot = current.tree[0];
  return {
    document: { scope: 'current-document', assetUuid: current.document.assetUuid ?? undefined },
    tree: [{
      id: '$cocosAiCreationHostRoot',
      ...(documentRoot.fileId ? { fileId: documentRoot.fileId } : {}),
      name: documentRoot.name,
      path: documentRoot.path,
      children: [prefabRoot]
    }]
  };
}

function assertPrefabAssetUrl(assetUrl: string): void {
  const segments = assetUrl.split('/');
  if (
    !assetUrl.startsWith('db://assets/')
    || !assetUrl.toLowerCase().endsWith('.prefab')
    || assetUrl.includes('\\')
    || segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`PREFAB_ASSET_URL_INVALID:${assetUrl}`);
  }
}

function isPrefabAsset(asset: {
  type?: string | null;
  url?: string | null;
  path?: string | null;
  filePath?: string | null;
}): boolean {
  if (asset.type === 'cc.Prefab') return true;
  return [asset.url, asset.path, asset.filePath]
    .some((value) => typeof value === 'string' && value.toLowerCase().endsWith('.prefab'));
}

function decodePrefabSearchCursor(value: string) {
  try {
    return PrefabSearchCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new Error('MCP_CURSOR_INVALID');
  }
}

function encodePrefabSearchCursor(value: z.infer<typeof PrefabSearchCursorSchema>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
