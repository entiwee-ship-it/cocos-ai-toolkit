#!/usr/bin/env node

import { ProbeClient } from './client.js';
import { parseCommand, type CliCommand } from './commands.js';
import {
  DesignApplyCommittedError,
  DesignApplyConfirmError,
  DesignApplyError,
  DesignApplyOutcomeUnknownError,
  DesignApplyPreparedError,
  DesignApplyRollbackError,
  JsonScanReportWriter,
  ProjectScanner,
  applyDesignPlan,
  appendWriteJournalEntry,
  buildDesignPlan,
  computeDesignDiff,
  exportDesignDocument,
  mergeDocumentPages,
  parseScanCheckpoint,
  verifyDesignTarget,
  type DesignCurrentNode,
  type DesignApplyResult,
  type DesignApplyRuntime,
  type DesignApplyVerificationContext,
  type DesignApplyVerificationItem,
  type DesignExportOptions,
  type ProjectScanResult,
  type ReadonlyProbeClient,
  type ScanCheckpoint
} from '@cocos-ai/core';
import {
  DocumentSnapshotSchema,
  ScriptAssetRecordSchema,
  WriteRevisionSnapshotSchema,
  WriteTransactionResultSchema,
  type DesignPlan,
  type DesignPlanItem,
  type DesignTargetDocument,
  type DesignTargetNode,
  type DesignVerifyReport,
  type DocumentSnapshot,
  type ProbeComponent,
  type ProbeNode,
  type WriteTransactionRequest,
  type WriteRevisionSnapshot,
  type WriteTransactionResult
} from '@cocos-ai/protocol';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DEFAULT_SERVER_URL = process.env.COCOS_AI_PROBE_SERVER_URL ?? 'ws://127.0.0.1:32188';
// 真实项目（xy-client 规模）下单次请求实测可能超过 10 秒，默认 60 秒；
// 需要更短超时时用 COCOS_AI_PROBE_TIMEOUT_MS 显式调小。
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DESIGN_DOCUMENT_READY_TIMEOUT_MS = 10_000;
const DESIGN_DOCUMENT_READY_POLL_MS = 50;

const HELP = `用法:
  cocos-ai-probe editors
  cocos-ai-probe state --project-id <id> [--editor-instance-id <id>]
  cocos-ai-probe write-revision --project-id <id> [--editor-instance-id <id>]
  cocos-ai-probe assets --project-id <id> --pattern <text> [--uuid <uuid>] [--editor-instance-id <id>]
  cocos-ai-probe open-asset --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai-probe hierarchy --project-id <id> [--editor-instance-id <id>] [--depth <n>]
  cocos-ai-probe node --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai-probe component --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai-probe prefab --project-id <id> --node-uuid <uuid> [--editor-instance-id <id>]
  cocos-ai-probe asset-index --project-id <id> [--editor-instance-id <id>]
  cocos-ai-probe component-schema --project-id <id> --uuid <component-uuid> [--editor-instance-id <id>]
  cocos-ai-probe document-snapshot --project-id <id> --mode summary|full --page-size <n> [--cursor <cursor>] [--editor-instance-id <id>]
  cocos-ai-probe prefab-graph --project-id <id> [--editor-instance-id <id>]
  cocos-ai-probe design-inspect --project-id <id> [--root-uuid <node-uuid>] [--editor-instance-id <id>]
  cocos-ai-probe design-plan --project-id <id> --target <json> [--editor-instance-id <id>]
  cocos-ai-probe design-preview --project-id <id> --target <json> [--editor-instance-id <id>]
  cocos-ai-probe design-verify --project-id <id> --target <json> [--editor-instance-id <id>]
  cocos-ai-probe design-export --project-id <id> [--root-uuid <node-uuid>] [--scope current-document|source-prefab|apply-to-source] [--asset-uuid <uuid>] [--editor-instance-id <id>]
  cocos-ai-probe design-apply --project-id <id> --target <json> [--execution-id <id>] [--revision <json>] [--editor-instance-id <id>]
  cocos-ai-probe scan-project --project-id <id> --report-root <directory> --report <relative-json> [--resume <relative-json>] [--page-size <n>] [--include-raw true|false] [--concurrency <n>] [--editor-instance-id <id>]
  cocos-ai-probe save-report --project-id <id> --sample <name> [--editor-instance-id <id>]
  cocos-ai-probe write-prepare --project-id <id> --request <json> [--editor-instance-id <id>]
  cocos-ai-probe write-confirm --project-id <id> --transaction-id <id> [--editor-instance-id <id>]
  cocos-ai-probe transaction-status --project-id <id> --transaction-id <id> [--editor-instance-id <id>]
  cocos-ai-probe transaction-list --project-id <id> [--editor-instance-id <id>]
  cocos-ai-probe transaction-rollback --project-id <id> --transaction-id <id> [--editor-instance-id <id>]
  cocos-ai-probe preview-launch --project-id <id> [--editor-instance-id <id>] [--resolution <宽x高>] [--channel chrome|msedge]
  cocos-ai-probe preview-stop --session-id <id>
  cocos-ai-probe preview-sessions [--project-id <id>]
  cocos-ai-probe runtime-console --session-id <id> [--since-seq <n>] [--level log|info|warn|error|debug]

环境变量:
  COCOS_AI_PROBE_SERVER_URL  Probe Server WebSocket 地址，默认 ${DEFAULT_SERVER_URL}
  COCOS_AI_PROBE_TIMEOUT_MS  单次请求等待毫秒数，默认 60000
  COCOS_AI_REPORT_ROOT       写事务审计落盘根目录，默认 reports`;

export async function runCli(
  argv: string[],
  options: { serverUrl?: string; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {}
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    stdout.write(`${HELP}\n`);
    return 0;
  }

  let command: CliCommand;
  try {
    command = parseCommand(argv);
  } catch (error) {
    writeError(stderr, error);
    return 1;
  }

  let preparedScan: PreparedScanProject | undefined;
  try {
    if (command.command === 'scan-project') {
      preparedScan = await prepareScanProject(command);
    }
  } catch (error) {
    writeError(stderr, error);
    return 1;
  }

  const requestTimeoutMs = readRequestTimeoutMs(process.env.COCOS_AI_PROBE_TIMEOUT_MS);
  const client = new ProbeClient(options.serverUrl ?? DEFAULT_SERVER_URL, requestTimeoutMs);
  try {
    await client.connect();
    const payload = await executeCommand(command, client, preparedScan);
    stdout.write(`${JSON.stringify(payload)}\n`);
    return command.command === 'design-apply' ? designApplyExitCode(payload) : 0;
  } catch (error) {
    writeError(stderr, error);
    return 1;
  } finally {
    await client.close();
  }
}

/** design-apply 只有完整提交状态可作为脚本成功退出。 */
export function designApplyExitCode(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 1;
  return (payload as { status?: unknown }).status === 'committed' ? 0 : 1;
}

export interface PreparedScanProject {
  reportRoot: string;
  reportPath: string;
  checkpointPath: string;
  checkpoint?: ScanCheckpoint;
}

/**
 * 在连接 Creator 前解析报告边界和可选 checkpoint。
 *
 * @param command 已校验的项目扫描命令。
 * @returns 仅位于显式报告根目录内的绝对路径和可信 checkpoint。
 */
export async function prepareScanProject(command: CliCommand): Promise<PreparedScanProject> {
  if (command.command !== 'scan-project') throw new Error('SCAN_PROJECT_COMMAND_REQUIRED');
  const reportRoot = await prepareReportRoot(command.reportRoot);
  const reportPath = await prepareTargetPath(
    reportRoot,
    command.report,
    'INVALID_REPORT_PATH'
  );
  const checkpointRelativePath = command.resume ?? deriveCheckpointPath(command.report);
  const checkpointPath = await prepareTargetPath(
    reportRoot,
    checkpointRelativePath,
    command.resume ? 'INVALID_RESUME_PATH' : 'INVALID_REPORT_PATH'
  );
  if (pathsEqual(reportPath, checkpointPath)) {
    throw new Error('REPORT_CHECKPOINT_PATH_CONFLICT');
  }
  if (!command.resume) return { reportRoot, reportPath, checkpointPath };

  try {
    const source = await readFile(checkpointPath, 'utf8');
    const checkpoint = parseScanCheckpoint(JSON.parse(source));
    const mismatches: string[] = [];
    if (checkpoint.projectId !== command.projectId) mismatches.push('projectId');
    if (
      command.editorInstanceId
      && checkpoint.editorInstanceId !== command.editorInstanceId
    ) {
      mismatches.push('editorInstanceId');
    }
    if (
      (command.pageSize !== undefined && command.pageSize !== checkpoint.parameters.pageSize)
      || (command.includeRaw !== undefined
        && command.includeRaw !== checkpoint.parameters.includeRaw)
      || (command.concurrency !== undefined
        && command.concurrency !== checkpoint.parameters.concurrency)
    ) {
      mismatches.push('parameters');
    }
    if (mismatches.length > 0) {
      throw new Error(`SCAN_CHECKPOINT_STALE:${mismatches.join(',')}`);
    }
    return {
      reportRoot,
      reportPath,
      checkpointPath,
      checkpoint
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.startsWith('SCAN_CHECKPOINT_INVALID')
      || message.startsWith('SCAN_CHECKPOINT_STALE')
    ) {
      throw error;
    }
    throw new Error(`SCAN_CHECKPOINT_INVALID:${message}`);
  }
}

/**
 * 执行原子 Bridge 请求或本地项目聚合命令。
 *
 * @param command 已解析的 CLI 命令。
 * @param client 已连接的共享只读 Client。
 * @param preparedScan 连接前准备好的报告路径和可选 checkpoint。
 * @returns 可直接输出为 JSON 的结果。
 */
export async function executeCommand(
  command: CliCommand,
  client: ReadonlyProbeClient,
  preparedScan?: PreparedScanProject,
  options: { journalRoot?: string } = {}
): Promise<unknown> {
  if (
    command.command === 'design-inspect'
    || command.command === 'design-plan'
    || command.command === 'design-preview'
    || command.command === 'design-verify'
    || command.command === 'design-export'
    || command.command === 'design-apply'
  ) {
    return executeDesignCommand(command, client, options);
  }
  if (command.command === 'prefab-graph') {
    return executePrefabGraph(command, client);
  }
  if (WRITE_RESULT_COMMANDS.has(command.command)) {
    return executeWriteCommand(command, client, options);
  }
  if (command.command === 'scan-project') {
    if (!preparedScan) throw new Error('SCAN_PROJECT_NOT_PREPARED');
    const checkpoint = preparedScan.checkpoint;
    const scanner = new ProjectScanner(
      client,
      new JsonScanReportWriter(
        preparedScan.reportPath,
        preparedScan.checkpointPath,
        preparedScan.reportRoot
      )
    );
    const result = await scanner.scan({
      projectId: command.projectId,
      ...(command.editorInstanceId || checkpoint?.editorInstanceId
        ? { editorInstanceId: command.editorInstanceId ?? checkpoint?.editorInstanceId }
        : {}),
      ...(checkpoint
        ? {
            checkpoint,
            pageSize: command.pageSize ?? checkpoint.parameters.pageSize,
            includeRaw: command.includeRaw ?? checkpoint.parameters.includeRaw,
            concurrency: command.concurrency ?? checkpoint.parameters.concurrency
          }
        : {
            ...(command.pageSize !== undefined ? { pageSize: command.pageSize } : {}),
            ...(command.includeRaw !== undefined ? { includeRaw: command.includeRaw } : {}),
            ...(command.concurrency !== undefined ? { concurrency: command.concurrency } : {})
          })
    });
    return {
      scanId: result.scanId,
      status: result.status,
      reportPath: preparedScan.reportPath,
      checkpointPath: preparedScan.checkpointPath
    };
  }
  return client.request(...toRequest(command));
}

/** design-inspect 的结构化只读摘要。 */
export interface DesignInspectResult {
  document: DocumentSnapshot['document'];
  revision: string;
  tree: DesignCurrentNode[];
  prefabInstances: DocumentSnapshot['prefabInstances'];
  coverage: DocumentSnapshot['coverage'];
  risks: string[];
  unresolved: DocumentSnapshot['unresolved'];
}

/** design-preview 的人类可读渲染，同时保留机器可读字段。 */
export interface DesignPreviewResult {
  mode: 'preview';
  operationCount: number;
  operations: Array<DesignPlanItem & { index: number; description: string }>;
  impactAnalysis: DesignPlan['impactAnalysis'];
  risks: string[];
  unresolved: DesignPlan['unresolved'];
}

/**
 * 执行阶段四声明式检查、计划、预览与事务应用命令。
 *
 * @param command 已解析且通过协议校验的声明式 CLI 命令。
 * @param client 已连接的共享 Probe Client。
 * @param options 写事务审计目录等执行选项。
 * @returns 只读摘要、声明式计划、预览、验证报告、导出文档或事务应用结果。
 */
export async function executeDesignCommand(
  command: Extract<CliCommand, {
    command: 'design-inspect' | 'design-plan' | 'design-preview' | 'design-verify' | 'design-export' | 'design-apply'
  }>,
  client: ReadonlyProbeClient,
  options: { journalRoot?: string } = {}
): Promise<
  DesignInspectResult
  | DesignPlan
  | DesignPreviewResult
  | DesignApplyResult
  | DesignVerifyReport
  | DesignTargetDocument
> {
  const snapshot = await readCompleteDesignSnapshot(command, client);
  const selector = command.editorInstanceId
    ? { projectId: command.projectId, editorInstanceId: command.editorInstanceId }
    : { projectId: command.projectId };
  const needsImpact = (
    command.command === 'design-plan'
    || command.command === 'design-preview'
    || command.command === 'design-apply'
  ) && command.target.document.scope !== 'current-document';
  const writeDocumentId = snapshot.document.assetUuid;
  if (
    command.command !== 'design-inspect'
    && command.command !== 'design-verify'
    && command.command !== 'design-export'
    && command.target.document.scope === 'source-prefab'
    && snapshot.document.assetUuid !== command.target.document.assetUuid
  ) {
    throw new Error('SOURCE_PREFAB_DOCUMENT_MISMATCH');
  }
  if (
    command.command !== 'design-inspect'
    && command.command !== 'design-verify'
    && command.command !== 'design-export'
    && command.target.document.scope === 'source-prefab'
    && snapshot.document.documentType !== 'prefab'
  ) {
    throw new Error('SOURCE_PREFAB_DOCUMENT_REQUIRED');
  }
  const inspect = summarizeDesignSnapshot(
    snapshot,
    command.command === 'design-inspect' || command.command === 'design-export'
      ? command.rootUuid
      : undefined
  );
  if (command.command === 'design-inspect') return inspect;
  if (command.command === 'design-verify') return verifyDesignTarget(inspect.tree, command.target);
  if (command.command === 'design-export') {
    const exportOptions: DesignExportOptions = {
      scope: command.scope,
      assetUuid: command.assetUuid ?? snapshot.document.assetUuid,
      prefabInstances: snapshot.prefabInstances.map((instance) => ({
        instanceRootObjectUuid: instance.instanceRootObjectUuid,
        sourcePrefabAssetUuid: instance.sourcePrefabAssetUuid
      }))
    };
    return exportDesignDocument(inspect.tree, exportOptions);
  }

  const diffItems = computeDesignDiff(inspect.tree, command.target.tree, command.target.prune === true);
  let prefabGraph: ProjectScanResult['prefabGraph'] | undefined;
  if (needsImpact) {
    if (!writeDocumentId) throw new Error('DESIGN_WRITE_DOCUMENT_IDENTITY_REQUIRED');
    try {
      prefabGraph = await executePrefabGraph({
        command: 'prefab-graph',
        projectId: command.projectId,
        ...(command.editorInstanceId ? { editorInstanceId: command.editorInstanceId } : {})
      }, client);
    } finally {
      await restoreDesignWriteDocument(client, selector, writeDocumentId);
    }
  }
  const sourceAssetPath = resolveDesignSourceAssetPath(
    command.target.document,
    snapshot.document,
    prefabGraph
  );
  const plan = buildDesignPlan(diffItems, command.target, {
    ...(prefabGraph ? { prefabGraph } : {}),
    ...(sourceAssetPath ? { sourceAssetPath } : {}),
    documentEditMode: snapshot.document.documentType === 'prefab' ? 'prefab' : 'scene'
  });
  if (command.command === 'design-plan') return plan;
  if (command.command === 'design-preview') return renderDesignPreview(plan);

  const runtime = createCliDesignApplyRuntime(command, client, snapshot, options);
  try {
    return await applyDesignPlan(plan, runtime, {
      executionId: command.executionId ?? `design-${randomUUID()}`,
      initialNodeResolutions: collectInitialNodeResolutions(inspect.tree, command.target.tree),
      scope: command.target.document.scope,
      ...(command.revision ? { revision: command.revision } : {})
    });
  } catch (error) {
    if (error instanceof DesignApplyError) {
      throw new Error(`${error.code}:${error.message}`);
    }
    throw error;
  }
}

/**
 * 解析源 Prefab 影响分析使用的真实资产路径。
 *
 * @param document 声明式目标中的作用域与源资产 UUID。
 * @param currentDocument 当前 Creator 打开文档的身份与路径。
 * @param prefabGraph 项目扫描得到的 Prefab 引用图。
 * @returns source-prefab 的当前文档路径，或 apply-to-source 的源 Prefab 图节点路径。
 */
export function resolveDesignSourceAssetPath(
  document: DesignTargetDocument['document'],
  currentDocument: DocumentSnapshot['document'],
  prefabGraph?: ProjectScanResult['prefabGraph']
): string | undefined {
  if (document.scope === 'current-document') return undefined;
  if (document.scope === 'source-prefab') return currentDocument.path ?? undefined;
  if (!document.assetUuid) return undefined;
  return prefabGraph?.nodes.find((node) => node.assetUuid === document.assetUuid)?.path ?? undefined;
}

/** 按 cursor 读取当前文档的完整快照，分页期间 revision 改变立即拒绝。 */
async function readCompleteDesignSnapshot(
  command: Extract<CliCommand, {
    command: 'design-inspect' | 'design-plan' | 'design-preview' | 'design-verify' | 'design-export' | 'design-apply'
  }>,
  client: ReadonlyProbeClient
): Promise<DocumentSnapshot> {
  const selector = command.editorInstanceId
    ? { projectId: command.projectId, editorInstanceId: command.editorInstanceId }
    : { projectId: command.projectId };
  const pages: DocumentSnapshot[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = DocumentSnapshotSchema.parse(await client.request('probe.documentSnapshot', {
      selector,
      params: { mode: 'full', pageSize: 500, cursor }
    }));
    if (pages[0] && page.revision !== pages[0].revision) {
      throw new Error('DOCUMENT_REVISION_CHANGED_DURING_PAGING');
    }
    pages.push(page);
    cursor = page.page.nextCursor;
    if (!cursor) break;
    if (cursors.has(cursor)) throw new Error('DOCUMENT_CURSOR_LOOP');
    cursors.add(cursor);
  }
  return mergeDocumentPages(pages);
}

/** 把 Phase 1 平铺快照规整成 Task 2 使用的树形当前状态。 */
export function summarizeDesignSnapshot(
  snapshot: DocumentSnapshot,
  rootUuid?: string
): DesignInspectResult {
  const currentNodes = new Map<string, DesignCurrentNode>();
  const parentByNode = new Map<string, string | null>();
  for (const node of snapshot.nodes) {
    const uuid = node.identity.objectUuid ?? node.identity.sessionId;
    if (!uuid) continue;
    currentNodes.set(uuid, toDesignCurrentNode(node, uuid));
    parentByNode.set(uuid, node.parentObjectUuid ?? null);
  }
  for (const entry of readSnapshotComponentEntries(snapshot)) {
    currentNodes.get(entry.nodeUuid)?.components.push(toDesignCurrentComponent(entry.component));
  }
  for (const [uuid, parentUuid] of parentByNode) {
    if (!parentUuid) continue;
    const parent = currentNodes.get(parentUuid);
    const child = currentNodes.get(uuid);
    if (parent && child) parent.children.push(child);
  }

  let tree: DesignCurrentNode[];
  if (rootUuid) {
    const root = currentNodes.get(rootUuid);
    if (!root) throw new Error('DESIGN_ROOT_NOT_FOUND');
    tree = [root];
  } else {
    tree = [...currentNodes.entries()]
      .filter(([uuid]) => {
        const parentUuid = parentByNode.get(uuid);
        return !parentUuid || !currentNodes.has(parentUuid);
      })
      .map(([, node]) => node);
  }

  const risks = [
    ...snapshot.diagnostics
      .filter((item) => item.severity !== 'info')
      .map((item) => item.message),
    ...snapshot.prefabInstances.flatMap((instance) =>
      instance.unresolved.map((item) => `${instance.hostNodePath ?? 'prefab-instance'}: ${item.reason}`)
    )
  ];
  return {
    document: snapshot.document,
    revision: snapshot.revision,
    tree,
    prefabInstances: snapshot.prefabInstances,
    coverage: snapshot.coverage,
    risks: [...new Set(risks)],
    unresolved: snapshot.unresolved
  };
}

function toDesignCurrentNode(node: ProbeNode, uuid: string): DesignCurrentNode {
  return {
    uuid,
    fileId: node.identity.fileId,
    name: node.name ?? uuid,
    path: node.path ?? node.name ?? uuid,
    prefabAssetUuid: node.prefabContext?.sourcePrefabAssetUuid ?? null,
    components: [],
    children: []
  };
}

function toDesignCurrentComponent(component: ProbeComponent): DesignCurrentNode['components'][number] {
  const properties: Record<string, unknown> = {};
  const references: Record<string, unknown> = {};
  const propertySources: Record<string, string> = {};
  for (const property of component.properties) {
    propertySources[property.propertyPath] = property.valueSource;
    if (property.valueKind.endsWith('-reference')) references[property.propertyPath] = property.effectiveValue;
    else properties[property.propertyPath] = property.effectiveValue;
  }
  return {
    uuid: component.identity.objectUuid,
    type: component.qualifiedName ?? component.className ?? component.identity.typeId ?? 'unknown-component',
    scriptUuid: component.identity.scriptUuid,
    properties,
    references,
    propertySources
  };
}

/** 把机器计划转为可读的零执行预览。 */
export function renderDesignPreview(plan: DesignPlan): DesignPreviewResult {
  return {
    mode: 'preview',
    operationCount: plan.items.length,
    operations: plan.items.map((item, index) => ({
      ...item,
      index: index + 1,
      description: `${index + 1}. ${item.kind} -> ${item.target}${item.overrideLayer ? ` (${item.overrideLayer})` : ''}`
    })),
    impactAnalysis: plan.impactAnalysis,
    risks: plan.risks,
    unresolved: plan.unresolved
  };
}

/** 用现有 CLI 写命令和文档快照组装声明式执行运行时。 */
function createCliDesignApplyRuntime(
  command: Extract<CliCommand, { command: 'design-apply' }>,
  client: ReadonlyProbeClient,
  initialSnapshot: DocumentSnapshot,
  options: { journalRoot?: string }
): DesignApplyRuntime {
  let cachedSnapshot: DocumentSnapshot | null = initialSnapshot;
  const knownNodeUuids = new Set(readSnapshotNodeUuids(initialSnapshot));
  const knownComponentUuids = new Set(readSnapshotComponentUuids(initialSnapshot));
  const selector = command.editorInstanceId
    ? { projectId: command.projectId, editorInstanceId: command.editorInstanceId }
    : { projectId: command.projectId };
  const readSnapshot = async (): Promise<DocumentSnapshot> => {
    if (!cachedSnapshot) cachedSnapshot = await readCompleteDesignSnapshot(command, client);
    return cachedSnapshot;
  };

  return {
    async prepare(request: WriteTransactionRequest): Promise<WriteTransactionResult> {
      try {
        return await executeWriteCommand({ command: 'write-prepare', ...selector, request }, client, options) as WriteTransactionResult;
      } catch (error) {
        if (error instanceof WriteCommandAuditError) {
          throw new DesignApplyPreparedError(error.result, error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new DesignApplyOutcomeUnknownError(message);
      }
    },
    async confirm(transactionId: string): Promise<WriteTransactionResult> {
      try {
        const result = await executeWriteCommand({ command: 'write-confirm', ...selector, transactionId }, client, options) as WriteTransactionResult;
        if (result.status === 'committed') cachedSnapshot = null;
        return result;
      } catch (error) {
        cachedSnapshot = null;
        if (error instanceof WriteCommandAuditError) {
          if (error.result.status === 'committed') {
            throw new DesignApplyCommittedError(error.result, error.message);
          }
          throw new DesignApplyConfirmError(error.result, error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new DesignApplyOutcomeUnknownError(message);
      }
    },
    async rollback(transactionId: string): Promise<WriteTransactionResult> {
      try {
        const result = await executeWriteCommand({ command: 'transaction-rollback', ...selector, transactionId }, client, options) as WriteTransactionResult;
        cachedSnapshot = null;
        return result;
      } catch (error) {
        cachedSnapshot = null;
        if (error instanceof WriteCommandAuditError) {
          throw new DesignApplyRollbackError(error.result, error.message);
        }
        throw error;
      }
    },
    async resolveCreatedNode(_logicalId, item): Promise<string | null> {
      const snapshot = await readSnapshot();
      const parentIdentity = readPlanString(item, 'parentLogicalId') ?? readPlanString(item, 'parentNodeUuid');
      const parentUuid = parentIdentity?.startsWith('$')
        ? collectInitialNodeResolutionsFromSnapshot(snapshot, command.target.tree)[parentIdentity]
        : parentIdentity;
      const expectedName = readPlanString(item, 'name');
      const candidate = snapshot.nodes.find((node) => {
        const uuid = readProbeNodeUuid(node);
        if (!uuid || knownNodeUuids.has(uuid)) return false;
        if (parentUuid && node.parentObjectUuid !== parentUuid) return false;
        return !expectedName || node.name === expectedName;
      });
      for (const uuid of readSnapshotNodeUuids(snapshot)) knownNodeUuids.add(uuid);
      return candidate ? readProbeNodeUuid(candidate) : null;
    },
    async resolveComponent(nodeUuid, componentType, expectCreated = false): Promise<string | null> {
      const snapshot = await readSnapshot();
      const matches = findSnapshotComponents(snapshot, nodeUuid, componentType);
      const newMatches = matches.filter((component) => {
        const uuid = component.identity.objectUuid;
        return uuid !== null && !knownComponentUuids.has(uuid);
      });
      const resolved = expectCreated
        ? newMatches.length === 1 ? newMatches[0] : undefined
        : newMatches.length === 1
          ? newMatches[0]
          : newMatches.length === 0 && matches.length === 1 ? matches[0] : undefined;
      for (const uuid of readSnapshotComponentUuids(snapshot)) knownComponentUuids.add(uuid);
      return resolved?.identity.objectUuid ?? null;
    },
    async verifyPlanItem(item, context): Promise<DesignApplyVerificationItem> {
      if (item.kind === 'script.wait_for_compile') {
        return verificationItem(item, 'script-asset-available', 'script-asset-available');
      }
      const snapshot = await readSnapshot();
      return verifyPlanItemFromSnapshot(item, context, snapshot);
    },
    async waitForScript(scriptUuid): Promise<void> {
      const rawIndex = await client.request('probe.assetIndex', { selector, params: {} });
      const scripts = ScriptAssetRecordSchema.array().safeParse(
        rawIndex && typeof rawIndex === 'object'
          ? (rawIndex as { scripts?: unknown }).scripts
          : undefined
      );
      if (!scripts.success) {
        throw new DesignApplyError('INVALID_SCRIPT_ASSET_INDEX', '脚本资产索引不符合协议');
      }
      const script = scripts.data.find((entry) => entry.assetUuid === scriptUuid && entry.available);
      if (!script) throw new DesignApplyError('SCRIPT_ASSET_NOT_FOUND', `脚本资产不存在：${scriptUuid}`);
    },
    async captureRevision() {
      const snapshot = await readCurrentWriteRevisionSnapshot(client, selector);
      assertDesignWriteDocumentIdentity(initialSnapshot.document.assetUuid, snapshot);
      return snapshot.revision;
    }
  };
}

/** 从 Bridge 重取当前写文档的五维 revision。 */
export async function readCurrentWriteRevision(
  client: ReadonlyProbeClient,
  selector: { projectId: string; editorInstanceId?: string }
) {
  return (await readCurrentWriteRevisionSnapshot(client, selector)).revision;
}

/**
 * 从 Bridge 重取当前写文档身份与五维 revision。
 *
 * @param client 已连接的共享 Probe Client。
 * @param selector 目标项目与可选 Editor 实例选择器。
 * @returns 当前 Editor 写文档身份和 revision 快照。
 */
export async function readCurrentWriteRevisionSnapshot(
  client: ReadonlyProbeClient,
  selector: { projectId: string; editorInstanceId?: string }
): Promise<WriteRevisionSnapshot> {
  return WriteRevisionSnapshotSchema.parse(await client.request(
    'probe.writeRevision',
    { selector, params: {} }
  ));
}

/**
 * 确认影响分析后当前 Editor 仍停留在最初读取的写文档。
 *
 * @param expectedDocumentId 初始完整快照中的文档资产 UUID。
 * @param snapshot 写入前重新读取的 Bridge 文档身份和 revision。
 */
export function assertDesignWriteDocumentIdentity(
  expectedDocumentId: string | null,
  snapshot: WriteRevisionSnapshot
): void {
  if (expectedDocumentId && snapshot.documentId === expectedDocumentId) return;
  throw new Error('DESIGN_WRITE_DOCUMENT_CHANGED');
}

/**
 * Prefab 图扫描结束后重新打开最初设计文档，并核对 Bridge 写文档身份。
 *
 * @param client 已连接的共享 Probe Client。
 * @param selector 目标项目与可选 Editor 实例选择器。
 * @param documentId 初始完整快照中的文档资产 UUID。
 * @returns 恢复后的当前写文档身份与五维 revision。
 */
export async function restoreDesignWriteDocument(
  client: ReadonlyProbeClient,
  selector: { projectId: string; editorInstanceId?: string },
  documentId: string
): Promise<WriteRevisionSnapshot> {
  await client.request('probe.openAsset', {
    selector,
    params: { uuid: documentId }
  });
  await waitUntilDesignDocumentReadable(client, selector);
  const snapshot = await readCurrentWriteRevisionSnapshot(client, selector);
  assertDesignWriteDocumentIdentity(documentId, snapshot);
  return snapshot;
}

/**
 * 等待恢复后的 Creator Scene 与 AssetDB 同时进入可读状态。
 *
 * @param client 已连接的共享 Probe Client。
 * @param selector 目标项目与可选 Editor 实例选择器。
 */
async function waitUntilDesignDocumentReadable(
  client: ReadonlyProbeClient,
  selector: { projectId: string; editorInstanceId?: string }
): Promise<void> {
  const deadline = Date.now() + DESIGN_DOCUMENT_READY_TIMEOUT_MS;
  while (true) {
    const state = await client.request('probe.editorState', { selector, params: {} });
    const ready = state && typeof state === 'object'
      ? (state as { ready?: unknown }).ready
      : undefined;
    if (
      ready
      && typeof ready === 'object'
      && (ready as { scene?: unknown }).scene === true
      && (ready as { assetDatabase?: unknown }).assetDatabase === true
    ) {
      return;
    }
    if (Date.now() >= deadline) throw new Error('DOCUMENT_NOT_READY');
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, DESIGN_DOCUMENT_READY_POLL_MS));
  }
}

/** 把目标树中已存在的节点映射为 Creator UUID，供新建子节点解析父级。 */
function collectInitialNodeResolutions(
  currentNodes: DesignCurrentNode[],
  targetNodes: DesignTargetNode[]
): Record<string, string> {
  const resolutions: Record<string, string> = {};
  matchTargetLevel(currentNodes, targetNodes, resolutions);
  return resolutions;
}

function matchTargetLevel(
  currentNodes: DesignCurrentNode[],
  targetNodes: DesignTargetNode[],
  resolutions: Record<string, string>
): void {
  const used = new Set<DesignCurrentNode>();
  for (const target of targetNodes) {
    const prefabAssetUuid = target.prefabInstance?.assetUuid;
    const prefabMatches = (node: DesignCurrentNode): boolean =>
      !prefabAssetUuid || node.prefabAssetUuid === prefabAssetUuid;
    let match = target.fileId && target.match !== 'name-path'
      ? currentNodes.find((node) => !used.has(node) && node.fileId === target.fileId && prefabMatches(node))
      : undefined;
    if (!match && target.match !== 'fileId') {
      const expectedName = target.prefabInstance?.name ?? target.name;
      match = currentNodes.find((node) =>
        !used.has(node)
        && Boolean(expectedName)
        && node.name === expectedName
        && (!target.path || node.path === target.path)
        && prefabMatches(node)
      );
    }
    if (!match) continue;
    used.add(match);
    resolutions[target.id] = match.uuid;
    matchTargetLevel(match.children, target.children ?? [], resolutions);
  }
}

function collectInitialNodeResolutionsFromSnapshot(
  snapshot: DocumentSnapshot,
  targetNodes: DesignTargetNode[]
): Record<string, string> {
  return collectInitialNodeResolutions(summarizeDesignSnapshot(snapshot).tree, targetNodes);
}

/**
 * 使用事务提交后的全新文档快照独立验证单个计划项。
 *
 * @param item 已完成事务提交的声明式计划项。
 * @param context 执行期解析出的节点、组件 UUID 与事务结果。
 * @param snapshot 从 Creator 重新读取的完整文档快照。
 * @returns 可写入 design_apply 结果的逐项 expected、actual 与通过状态。
 */
export function verifyPlanItemFromSnapshot(
  item: DesignPlanItem,
  context: DesignApplyVerificationContext,
  snapshot: DocumentSnapshot
): DesignApplyVerificationItem {
  const targetUuid = readPlanString(item, 'targetUuid')
    ?? (item.target.startsWith('$') ? context.nodeResolutions[item.target] : item.target);
  switch (item.kind) {
    case 'node.create': {
      const actual = targetUuid ? findSnapshotNode(snapshot, targetUuid)?.name ?? null : null;
      return verificationItem(item, readPlanString(item, 'name') ?? 'exists', actual ?? 'missing', actual !== null);
    }
    case 'prefab.instantiate': {
      const sourcePrefabAssetUuid = readPlanString(item, 'prefabAssetUuid');
      const expectedName = readPlanString(item, 'name');
      const expected = {
        nodeExists: true,
        name: expectedName ?? 'any',
        ...expectedPrefabRelation(targetUuid, sourcePrefabAssetUuid)
      };
      const node = targetUuid ? findSnapshotNode(snapshot, targetUuid) : undefined;
      const actual = {
        nodeExists: Boolean(node),
        name: expectedName ? node?.name ?? null : node ? 'any' : null,
        ...actualPrefabRelation(snapshot, targetUuid, sourcePrefabAssetUuid)
      };
      return verificationItem(item, expected, actual);
    }
    case 'node.delete': {
      const actual = targetUuid ? findSnapshotNode(snapshot, targetUuid) : undefined;
      return verificationItem(item, 'missing', actual ? 'exists' : 'missing');
    }
    case 'component.add': {
      const componentType = readPlanString(item, 'componentType');
      const componentUuid = componentType ? context.componentResolutions[`${item.target}::${componentType}`] : undefined;
      const actual = targetUuid && componentUuid && componentType
        ? findSnapshotComponents(snapshot, targetUuid, componentType).find(
            (component) => component.identity.objectUuid === componentUuid
          )?.identity.objectUuid ?? null
        : null;
      return verificationItem(item, componentUuid ?? 'resolved-component', actual ?? 'missing');
    }
    case 'component.remove': {
      const componentUuid = readPlanString(item, 'componentUuid')
        ?? resolveContextComponentUuid(item, context);
      const actual = componentUuid ? findSnapshotComponentByUuid(snapshot, componentUuid) : undefined;
      return verificationItem(item, 'missing', actual ? 'exists' : 'missing');
    }
    case 'component.set_property':
    case 'component.set_reference': {
      const componentUuid = readPlanString(item, 'componentUuid')
        ?? resolveContextComponentUuid(item, context);
      const component = componentUuid ? findSnapshotComponentByUuid(snapshot, componentUuid) : undefined;
      const property = component?.properties.find((entry) => entry.propertyPath === item.propertyPath);
      const expected = item.kind === 'component.set_property'
        ? item.value
        : materializeExpectedReference(item, context);
      return verificationItem(item, expected, property?.effectiveValue ?? null);
    }
    case 'prefab.apply_to_source': {
      const sourcePrefabAssetUuid = readPlanString(item, 'sourcePrefabAssetUuid');
      return verificationItem(
        item,
        expectedPrefabRelation(targetUuid, sourcePrefabAssetUuid),
        actualPrefabRelation(snapshot, targetUuid, sourcePrefabAssetUuid)
      );
    }
    default:
      return verificationItem(item, item.kind, 'unsupported', false);
  }
}

/**
 * 组装 Prefab 实例独立重读的期望关系。
 *
 * @param instanceRootObjectUuid 执行期解析出的实例根 UUID。
 * @param sourcePrefabAssetUuid 计划声明的源 Prefab 资产 UUID。
 * @returns 用于深比较的完整关系期望。
 */
function expectedPrefabRelation(
  instanceRootObjectUuid: string | undefined,
  sourcePrefabAssetUuid: string | null
) {
  return {
    instanceRootObjectUuid: instanceRootObjectUuid ?? null,
    sourcePrefabAssetUuid,
    sourceObjectFileId: 'present',
    instanceFileId: 'present',
    unresolvedCount: 0,
    relationComplete: true
  };
}

/**
 * 从新快照读取指定实例根的源资产与 FileID 关系。
 *
 * @param snapshot 事务提交后重新读取的完整文档快照。
 * @param instanceRootObjectUuid 执行期解析出的实例根 UUID。
 * @param expectedSourcePrefabAssetUuid 计划声明的源 Prefab 资产 UUID。
 * @returns 可与期望关系直接深比较的实际关系。
 */
function actualPrefabRelation(
  snapshot: DocumentSnapshot,
  instanceRootObjectUuid: string | undefined,
  expectedSourcePrefabAssetUuid: string | null
) {
  const instance = instanceRootObjectUuid
    ? snapshot.prefabInstances.find((entry) => entry.instanceRootObjectUuid === instanceRootObjectUuid)
    : undefined;
  const unresolvedCount = instance?.unresolved.length ?? 0;
  return {
    instanceRootObjectUuid: instance?.instanceRootObjectUuid ?? null,
    sourcePrefabAssetUuid: instance?.sourcePrefabAssetUuid ?? null,
    sourceObjectFileId: instance?.sourceObjectFileId ? 'present' : 'missing',
    instanceFileId: instance?.instanceFileId ? 'present' : 'missing',
    unresolvedCount,
    relationComplete: Boolean(
      instanceRootObjectUuid
      && expectedSourcePrefabAssetUuid
      && instance?.sourcePrefabAssetUuid === expectedSourcePrefabAssetUuid
      && instance.sourceObjectFileId
      && instance.instanceFileId
      && unresolvedCount === 0
    )
  };
}

function materializeExpectedReference(
  item: DesignPlanItem,
  context: DesignApplyVerificationContext
): unknown {
  const resolveTo = readPlanString(item, 'resolveTo');
  if (!resolveTo) return item.params?.reference;
  return {
    kind: 'node',
    objectUuid: context.nodeResolutions[resolveTo] ?? null,
    fileId: null,
    nodePath: null,
    available: true
  };
}

function resolveContextComponentUuid(
  item: DesignPlanItem,
  context: DesignApplyVerificationContext
): string | undefined {
  const componentType = readPlanString(item, 'componentType');
  return componentType ? context.componentResolutions[`${item.target}::${componentType}`] : undefined;
}

function verificationItem(
  item: DesignPlanItem,
  expected: unknown,
  actual: unknown,
  passed = isDeepStrictEqual(expected, actual)
): DesignApplyVerificationItem {
  return {
    description: `${item.kind}:${item.target}${item.propertyPath ? `.${item.propertyPath}` : ''}`,
    expected,
    actual,
    passed
  };
}

function findSnapshotNode(snapshot: DocumentSnapshot, uuid: string): ProbeNode | undefined {
  return snapshot.nodes.find((node) => readProbeNodeUuid(node) === uuid);
}

function findSnapshotComponent(
  snapshot: DocumentSnapshot,
  nodeUuid: string,
  componentType: string
): ProbeComponent | undefined {
  return findSnapshotComponents(snapshot, nodeUuid, componentType)[0];
}

function findSnapshotComponents(
  snapshot: DocumentSnapshot,
  nodeUuid: string,
  componentType: string
): ProbeComponent[] {
  return readSnapshotComponentEntries(snapshot)
    .filter((entry) => entry.nodeUuid === nodeUuid)
    .map((entry) => entry.component)
    .filter((component) =>
      (component.qualifiedName ?? component.className ?? component.identity.typeId) === componentType
    );
}

function findSnapshotComponentByUuid(
  snapshot: DocumentSnapshot,
  componentUuid: string
): ProbeComponent | undefined {
  return readSnapshotComponentEntries(snapshot)
    .find((entry) => entry.component.identity.objectUuid === componentUuid)
    ?.component;
}

function readProbeNodeUuid(node: ProbeNode): string | null {
  return node.identity.objectUuid ?? node.identity.sessionId;
}

function readSnapshotNodeUuids(snapshot: DocumentSnapshot): string[] {
  return snapshot.nodes.map(readProbeNodeUuid).filter((uuid): uuid is string => uuid !== null);
}

function readSnapshotComponentUuids(snapshot: DocumentSnapshot): string[] {
  return readSnapshotComponentEntries(snapshot)
    .map((entry) => entry.component.identity.objectUuid)
    .filter((uuid): uuid is string => uuid !== null);
}

interface SnapshotComponentEntry {
  nodeUuid: string;
  component: ProbeComponent;
}

/** 统一读取真实 document-scan 顶层组件，并兼容旧快照的节点内组件。 */
function readSnapshotComponentEntries(snapshot: DocumentSnapshot): SnapshotComponentEntry[] {
  const entries = snapshot.componentSchemas.map((schema) => ({
    nodeUuid: schema.nodeUuid,
    component: componentSchemaToProbeComponent(schema)
  }));
  const knownUuids = new Set(snapshot.componentSchemas.map((schema) => schema.componentUuid));
  for (const node of snapshot.nodes) {
    const nodeUuid = readProbeNodeUuid(node);
    if (!nodeUuid) continue;
    for (const component of node.components ?? []) {
      const componentUuid = component.identity.objectUuid;
      if (componentUuid && knownUuids.has(componentUuid)) continue;
      entries.push({ nodeUuid, component });
    }
  }
  return entries;
}

/** 把组件 Schema 的当前值与引用还原为声明式层既有的 ProbeComponent 视图。 */
function componentSchemaToProbeComponent(
  schema: DocumentSnapshot['componentSchemas'][number]
): ProbeComponent {
  return {
    kind: 'component',
    identity: {
      sessionId: null,
      objectUuid: schema.componentUuid,
      assetUuid: null,
      fileId: schema.componentFileId,
      typeId: schema.typeId,
      scriptUuid: schema.scriptUuid
    },
    className: schema.className,
    qualifiedName: schema.qualifiedName,
    scriptPath: schema.scriptPath,
    inheritance: schema.inheritance,
    properties: schema.properties.flatMap(componentSchemaPropertyToProbeProperties),
    rawSerializedState: schema.rawClassAttributes
  };
}

type ComponentSchemaProperty = DocumentSnapshot['componentSchemas'][number]['properties'][number];
type ComponentSchemaReference = ComponentSchemaProperty['references'][number];
type ProbeProperty = ProbeComponent['properties'][number];

/** 把顶层组件属性还原为基础值，并补出数组或嵌套对象内引用的精确属性路径。 */
function componentSchemaPropertyToProbeProperties(property: ComponentSchemaProperty): ProbeProperty[] {
  const base: ProbeProperty = {
    propertyPath: property.propertyPath,
    serializedName: property.serializedName,
    displayName: property.displayName,
    declaredType: property.declaredType,
    actualType: property.actualType,
    valueKind: property.valueKind,
    nullable: property.nullable,
    serializable: property.serializable,
    visible: property.visible,
    readonly: property.readonly,
    defaultValue: property.defaultValue,
    effectiveValue: property.valueKind.endsWith('-reference') && property.references.length === 1
      ? property.references[0]
      : property.currentValue,
    sourceValue: property.currentValue,
    overrideValue: null,
    valueSource: 'local',
    inspectorMetadata: property.inspectorMetadata,
    raw: property.rawClassAttributes
  };
  if (property.valueKind.endsWith('-reference') || property.references.length === 0) {
    return [base];
  }

  const paths: string[] = [];
  collectSchemaReferencePaths(
    property.rawClassAttributes,
    property.propertyPath,
    null,
    paths,
    new Set<unknown>(),
    0
  );
  if (paths.length !== property.references.length) return [base];
  return [
    base,
    ...paths.map((propertyPath, index): ProbeProperty => ({
      ...base,
      propertyPath,
      serializedName: propertyPath,
      displayName: propertyPath,
      declaredType: null,
      actualType: null,
      valueKind: schemaReferenceValueKind(property.references[index]),
      nullable: false,
      defaultValue: null,
      effectiveValue: property.references[index],
      sourceValue: property.references[index]
    }))
  ];
}

function collectSchemaReferencePaths(
  value: unknown,
  propertyPath: string,
  inheritedKind: 'node' | 'component' | 'asset' | null,
  paths: string[],
  visited: Set<unknown>,
  depth: number
): void {
  if (depth > 8 || !value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSchemaReferencePaths(
      item, `${propertyPath}[${index}]`, inheritedKind, paths, visited, depth + 1
    ));
    return;
  }

  const record = value as Record<string, unknown>;
  const expectedKind = readSchemaReferenceKind(record) ?? inheritedKind;
  const currentValue = Object.prototype.hasOwnProperty.call(record, 'value') ? record.value : value;
  if (record.isArray === true || Array.isArray(currentValue)) {
    if (Array.isArray(currentValue)) {
      currentValue.forEach((item, index) => collectSchemaReferencePaths(
        item, `${propertyPath}[${index}]`, expectedKind, paths, visited, depth + 1
      ));
    }
    return;
  }
  if (expectedKind) {
    paths.push(propertyPath);
    return;
  }
  if (currentValue !== value) {
    collectSchemaReferencePaths(currentValue, propertyPath, null, paths, visited, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'default' || key === 'elementTypeData') continue;
    collectSchemaReferencePaths(child, `${propertyPath}.${key}`, null, paths, visited, depth + 1);
  }
}

function readSchemaReferenceKind(
  property: Record<string, unknown>
): 'node' | 'component' | 'asset' | null {
  const type = typeof property.type === 'string' ? property.type : null;
  const inheritance = Array.isArray(property.extends)
    ? property.extends.filter((item): item is string => typeof item === 'string')
    : [];
  if (type === 'cc.Node') return 'node';
  if (inheritance.includes('cc.Component')) return 'component';
  if (
    inheritance.includes('cc.Asset')
    || type === 'cc.Script'
    || type === 'cc.Prefab'
    || type === 'cc.SpriteFrame'
    || type === 'cc.RenderTexture'
  ) return 'asset';
  return null;
}

function schemaReferenceValueKind(
  reference: ComponentSchemaReference
): ProbeProperty['valueKind'] {
  if (reference.kind === 'node') return 'node-reference';
  if (reference.kind === 'component') return 'component-reference';
  if (reference.kind === 'asset') return 'asset-reference';
  if (reference.expectedKind === 'node') return 'node-reference';
  if (reference.expectedKind === 'component') return 'component-reference';
  if (reference.expectedKind === 'asset') return 'asset-reference';
  return 'unknown-serialized';
}

function readPlanString(item: DesignPlanItem, key: string): string | null {
  const value = item.params?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 需要协议结果校验的写命令。 */
const WRITE_RESULT_COMMANDS = new Set([
  'write-prepare',
  'write-confirm',
  'transaction-status',
  'transaction-list',
  'transaction-rollback'
]);

/** 需要写事务审计落盘的命令（状态查询不产生审计）。 */
const AUDITED_WRITE_COMMANDS = new Set(['write-prepare', 'write-confirm', 'transaction-rollback']);

/** Bridge 已返回协议结果，但后置 journal 写入失败。 */
class WriteCommandAuditError extends Error {
  constructor(readonly result: WriteTransactionResult, cause: unknown) {
    super(`WRITE_JOURNAL_FAILED:${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WriteCommandAuditError';
  }
}

/**
 * 执行阶段二写命令：响应按协议 Schema 校验，并把调用来源、参数和结果写入事务审计。
 *
 * @param command 已解析的写命令。
 * @param client 已连接的共享 Client。
 * @param options.journalRoot 审计落盘的授权报告根，默认 reports 或 COCOS_AI_REPORT_ROOT。
 * @returns 协议校验后的写事务结果。
 */
async function executeWriteCommand(
  command: CliCommand,
  client: ReadonlyProbeClient,
  options: { journalRoot?: string } = {}
): Promise<unknown> {
  const result = await client.request(...toRequest(command));
  const validated = validateWriteCommandResult(command.command, result);
  if (!AUDITED_WRITE_COMMANDS.has(command.command)) {
    return validated;
  }

  const record = Array.isArray(validated) ? undefined : validated;
  try {
    await appendWriteJournalEntry(readJournalRoot(options.journalRoot), {
      transactionId: readWriteCommandTransactionId(command),
      idempotencyKey: command.command === 'write-prepare' ? command.request.idempotencyKey : '',
      at: new Date().toISOString(),
      event: command.command,
      source: 'cli',
      request: command.command === 'write-prepare' ? command.request : undefined,
      verification: record?.verification ?? undefined,
      details: record ? { status: record.status } : undefined
    });
  } catch (error) {
    if (record) throw new WriteCommandAuditError(record, error);
    throw error;
  }
  return validated;
}

/**
 * 读取写命令的事务 id：prepare 取请求内 transactionId，其余取命令参数。
 *
 * @param command 已解析的写命令。
 * @returns 事务 id。
 */
function readWriteCommandTransactionId(command: CliCommand): string {
  if (command.command === 'write-prepare') return command.request.transactionId;
  if ('transactionId' in command) return command.transactionId;
  throw new Error('TRANSACTION_ID_REQUIRED');
}

/**
 * 按协议校验写命令响应，防止未验证的写结果流出。
 *
 * @param command 写命令名。
 * @param result Bridge 返回的原始载荷。
 * @returns 协议校验后的结果。
 */
function validateWriteCommandResult(
  command: string,
  result: unknown
): WriteTransactionResult | WriteTransactionResult[] {
  try {
    return command === 'transaction-list'
      ? WriteTransactionResultSchema.array().parse(result)
      : WriteTransactionResultSchema.parse(result);
  } catch {
    throw new Error('INVALID_WRITE_RESULT');
  }
}

function readJournalRoot(journalRoot?: string): string {
  return journalRoot ?? resolve(process.env.COCOS_AI_REPORT_ROOT ?? 'reports');
}

/**
 * 使用临时文件化扫描仓库生成 Prefab 引用图，避免完整文档快照常驻 CLI 内存。
 *
 * @param command 已解析的 Prefab 图命令。
 * @param client 已连接的共享只读 Client。
 * @param temporaryDirectoryRoot 临时扫描目录的父目录，默认使用操作系统临时目录。
 * @returns 项目扫描生成的 Prefab 引用图。
 */
export async function executePrefabGraph(
  command: Extract<CliCommand, { command: 'prefab-graph' }>,
  client: ReadonlyProbeClient,
  temporaryDirectoryRoot = tmpdir()
): Promise<ProjectScanResult['prefabGraph']> {
  const scanRoot = await mkdtemp(join(temporaryDirectoryRoot, 'cocos-ai-prefab-graph-'));
  let scanFailed = false;
  try {
    const scanner = new ProjectScanner(
      client,
      new JsonScanReportWriter(
        join(scanRoot, 'prefab-graph.report.json'),
        join(scanRoot, 'prefab-graph.checkpoint.json'),
        scanRoot
      )
    );
    const result = await scanner.scan({
      projectId: command.projectId,
      ...(command.editorInstanceId ? { editorInstanceId: command.editorInstanceId } : {})
    });
    return result.prefabGraph;
  } catch (error) {
    scanFailed = true;
    throw error;
  } finally {
    try {
      await rm(scanRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      // 扫描已经失败时优先保留原始错误，避免临时目录清理异常遮蔽真正根因。
      if (!scanFailed) throw cleanupError;
    }
  }
}

/**
 * 读取单次 Probe 请求超时，并对非法环境变量回退到稳定默认值。
 *
 * @param rawValue 环境变量中的毫秒数字符串。
 * @returns 有限的正整数毫秒数。
 */
export function readRequestTimeoutMs(rawValue: string | undefined): number {
  const timeoutMs = Number(rawValue);
  return Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function toRequest(command: CliCommand): [string, unknown] {
  if (command.command === 'editors') {
    return ['server.editors', {}];
  }
  if (command.command === 'preview-stop') {
    return ['server.previewStop', { sessionId: command.sessionId }];
  }
  if (command.command === 'preview-sessions') {
    return ['server.previewSessions', {
      ...(command.projectId ? { projectId: command.projectId } : {})
    }];
  }
  if (command.command === 'runtime-console') {
    return ['server.runtimeConsole', {
      sessionId: command.sessionId,
      ...(command.sinceSeq !== undefined ? { sinceSeq: command.sinceSeq } : {}),
      ...(command.level ? { level: command.level } : {})
    }];
  }

  const selector = command.editorInstanceId
    ? { projectId: command.projectId, editorInstanceId: command.editorInstanceId }
    : { projectId: command.projectId };

  switch (command.command) {
    case 'preview-launch':
      return ['server.previewLaunch', {
        selector,
        params: {
          ...(command.resolution ? { resolution: command.resolution } : {}),
          ...(command.channel ? { channel: command.channel } : {})
        }
      }];
    case 'state':
      return ['probe.editorState', { selector, params: {} }];
    case 'write-revision':
      return ['probe.writeRevision', { selector, params: {} }];
    case 'assets':
      return ['probe.assets', {
        selector,
        params: { pattern: command.pattern, ...(command.uuid ? { uuid: command.uuid } : {}) }
      }];
    case 'hierarchy':
      return ['probe.hierarchy', { selector, params: { depth: command.depth } }];
    case 'node':
      return ['probe.node', { selector, params: { uuid: command.uuid } }];
    case 'component':
      return ['probe.component', { selector, params: { uuid: command.uuid } }];
    case 'asset-index':
      return ['probe.assetIndex', { selector, params: {} }];
    case 'component-schema':
      return ['probe.component', { selector, params: { uuid: command.uuid } }];
    case 'document-snapshot':
      return ['probe.documentSnapshot', {
        selector,
        params: {
          mode: command.mode,
          pageSize: command.pageSize,
          ...(command.cursor ? { cursor: command.cursor } : {})
        }
      }];
    case 'open-asset':
      return ['probe.openAsset', { selector, params: { uuid: command.uuid } }];
    case 'prefab':
      return ['probe.prefab', { selector, params: { nodeUuid: command.nodeUuid } }];
    case 'save-report':
      return ['probe.saveReport', { selector, params: { sample: command.sample } }];
    case 'write-prepare':
      return ['probe.writePrepare', { selector, params: command.request }];
    case 'write-confirm':
      return ['probe.writeConfirm', {
        selector,
        params: { transactionId: command.transactionId }
      }];
    case 'transaction-status':
      return ['probe.transactionStatus', {
        selector,
        params: { transactionId: command.transactionId }
      }];
    case 'transaction-list':
      return ['probe.transactionList', { selector, params: {} }];
    case 'transaction-rollback':
      return ['probe.transactionRollback', {
        selector,
        params: { transactionId: command.transactionId }
      }];
    case 'prefab-graph':
    case 'scan-project':
    case 'design-inspect':
    case 'design-plan':
    case 'design-preview':
    case 'design-verify':
    case 'design-export':
    case 'design-apply':
      throw new Error('LOCAL_COMMAND_REQUIRED');
  }
}

function deriveCheckpointPath(report: string): string {
  return `${report.slice(0, -'.json'.length)}.checkpoint.json`;
}

/**
 * 创建并规范化调用方显式授权的报告根目录。
 *
 * @param reportRoot CLI 传入的报告根目录。
 * @returns 已解析真实路径且可写的报告根目录。
 */
async function prepareReportRoot(reportRoot: string): Promise<string> {
  try {
    const requestedRoot = resolve(reportRoot);
    await mkdir(requestedRoot, { recursive: true });
    const rootStat = await stat(requestedRoot);
    if (!rootStat.isDirectory()) throw new Error('NOT_A_DIRECTORY');
    const canonicalRoot = await realpath(requestedRoot);
    await access(canonicalRoot, constants.W_OK);
    return canonicalRoot;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`REPORT_ROOT_INVALID:${reason}`);
  }
}

/**
 * 在授权报告根内准备一个 JSON 目标路径，并拒绝 Junction、目录和其它非普通文件目标。
 *
 * @param root 已解析真实路径的报告根目录。
 * @param relativePath CLI 提供的相对 JSON 路径。
 * @param errorCode 当前目标类型对应的稳定业务错误码。
 * @returns 位于真实父目录下的目标绝对路径。
 */
async function prepareTargetPath(
  root: string,
  relativePath: string,
  errorCode: string
): Promise<string> {
  const target = resolveWithinRoot(root, relativePath, errorCode);
  const requestedParent = dirname(target);
  const existingAncestor = await findExistingAncestor(requestedParent);
  const canonicalAncestor = await realpath(existingAncestor);
  assertWithinRoot(root, canonicalAncestor, errorCode);
  await mkdir(requestedParent, { recursive: true });
  const canonicalParent = await realpath(requestedParent);
  assertWithinRoot(root, canonicalParent, errorCode);
  await access(canonicalParent, constants.W_OK);
  const canonicalTarget = join(canonicalParent, basename(target));
  try {
    const targetStat = await lstat(canonicalTarget);
    if (!targetStat.isFile()) throw new Error(errorCode);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return canonicalTarget;
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

function writeError(stderr: NodeJS.WritableStream, error: unknown): void {
  const rawCode = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  const separatorIndex = rawCode.indexOf(':');
  const code = separatorIndex >= 0 ? rawCode.slice(0, separatorIndex) : rawCode;
  const reason = separatorIndex >= 0 ? rawCode.slice(separatorIndex + 1) : null;
  const message = errorMessage(code);
  stderr.write(`${JSON.stringify({
    code,
    message,
    details: reason ? { reason } : {}
  })}\n`);
}

/**
 * 把稳定错误码转换为面向 AI 和开发人员的中文说明。
 *
 * @param code CLI 或 Bridge 返回的稳定错误码。
 * @returns 对应中文说明；未知错误使用统一兜底文本。
 */
function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    COMMAND_REQUIRED: '必须指定探针命令',
    INVALID_ARGUMENTS: '命令参数格式无效',
    UNKNOWN_COMMAND: '未知探针命令',
    UNKNOWN_ARGUMENT: '命令包含未知参数',
    PROJECT_ID_REQUIRED: '缺少 project-id',
    PATTERN_REQUIRED: '缺少 pattern',
    UUID_REQUIRED: '缺少 uuid',
    NODE_UUID_REQUIRED: '缺少 node-uuid',
    PROJECT_PATH_REQUIRED: '缺少 project-path',
    DOCUMENT_UUID_REQUIRED: '缺少 document-uuid',
    PROBE_NAME_REQUIRED: '缺少 probe-name',
    TRANSACTION_ID_REQUIRED: '缺少 transaction-id',
    EXPECTED_REVISION_REQUIRED: '缺少 expected-revision',
    WRITE_REQUEST_REQUIRED: '缺少 request',
    INVALID_WRITE_REQUEST_JSON: 'request 必须是合法 JSON',
    INVALID_WRITE_REQUEST: 'request 不符合写事务协议',
    INVALID_WRITE_RESULT: '写事务结果不符合协议',
    DESIGN_TARGET_REQUIRED: '缺少 target',
    INVALID_DESIGN_TARGET_JSON: 'target 必须是合法 JSON',
    INVALID_DESIGN_TARGET: 'target 不符合声明式目标协议',
    DESIGN_REVISION_REQUIRED: '跨文档声明式写入缺少 revision',
    INVALID_DESIGN_REVISION_JSON: 'revision 必须是合法 JSON',
    INVALID_DESIGN_REVISION: 'revision 不符合五维前置协议',
    SAMPLE_REQUIRED: '缺少 sample',
    SNAPSHOT_MODE_REQUIRED: '缺少 mode',
    PAGE_SIZE_REQUIRED: '缺少 page-size',
    REPORT_ROOT_REQUIRED: '缺少 report-root',
    REPORT_REQUIRED: '缺少 report',
    INVALID_DEPTH: 'depth 必须是 1 到 20 的整数',
    INVALID_PAGE_SIZE: 'page-size 必须是 1 到 500 的整数',
    INVALID_SNAPSHOT_MODE: 'mode 必须是 summary 或 full',
    INVALID_REPORT_PATH: 'report 必须是报告根目录内的相对 JSON 路径',
    INVALID_RESUME_PATH: 'resume 必须是报告根目录内的相对 JSON 路径',
    REPORT_ROOT_INVALID: 'report-root 必须是可写目录',
    REPORT_PATH_OUTSIDE_ROOT: '报告路径已离开 report-root 授权边界',
    REPORT_CHECKPOINT_PATH_CONFLICT: '报告和 checkpoint 不能使用同一路径',
    SCAN_CHECKPOINT_INVALID: '扫描 checkpoint 无效',
    SCAN_CHECKPOINT_STALE: '扫描 checkpoint 与当前项目或参数不匹配',
    INVALID_SCAN_PAGE_SIZE: '扫描 page-size 必须是 1 到 500 的整数',
    INVALID_INCLUDE_RAW: 'include-raw 必须是 true 或 false',
    INVALID_SCAN_CONCURRENCY: '扫描 concurrency 必须是 1 到 4 的整数',
    MULTIPLE_EDITOR_INSTANCES: '同一项目存在多个编辑器实例，请明确指定 editor-instance-id',
    CLIENT_NOT_CONNECTED: 'Probe Server 尚未连接',
    SERVER_CONNECTION_CLOSED: 'Probe Server 连接已关闭',
    SERVER_REQUEST_TIMEOUT: 'Probe Server 请求超时，结果未知',
    EDITOR_INSTANCE_DISCONNECTED: '编辑器 Bridge 已断开',
  };
  return messages[code] ?? '探针请求失败';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
