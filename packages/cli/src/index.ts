#!/usr/bin/env node

import { ProbeClient } from './client.js';
import { parseCommand, type CliCommand } from './commands.js';
import {
  JsonScanReportWriter,
  ProjectScanner,
  parseScanCheckpoint,
  type ReadonlyProbeClient,
  type ScanCheckpoint
} from '@cocos-ai/core';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SERVER_URL = process.env.COCOS_AI_PROBE_SERVER_URL ?? 'ws://127.0.0.1:32188';

const HELP = `用法:
  cocos-ai-probe editors
  cocos-ai-probe state --project-id <id> [--editor-instance-id <id>]
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
  cocos-ai-probe scan-project --project-id <id> --report-root <directory> --report <relative-json> [--resume <relative-json>] [--page-size <n>] [--include-raw true|false] [--concurrency <n>] [--editor-instance-id <id>]
  cocos-ai-probe save-report --project-id <id> --sample <name> [--editor-instance-id <id>]
  cocos-ai-probe probe-undo-save-prepare --project-id <id> --project-path <path> --document-uuid <uuid> --probe-name <name>
  cocos-ai-probe probe-undo-save-confirm --project-id <id> --transaction-id <id> --expected-revision <sha256>
  cocos-ai-probe probe-undo-save-status --project-id <id> --transaction-id <id>

环境变量:
  COCOS_AI_PROBE_SERVER_URL  Probe Server WebSocket 地址，默认 ${DEFAULT_SERVER_URL}`;

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

  const client = new ProbeClient(options.serverUrl ?? DEFAULT_SERVER_URL);
  try {
    await client.connect();
    const payload = await executeCommand(command, client, preparedScan);
    stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    writeError(stderr, error);
    return 1;
  } finally {
    await client.close();
  }
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
  preparedScan?: PreparedScanProject
): Promise<unknown> {
  if (command.command === 'prefab-graph') {
    const result = await new ProjectScanner(client).scan({
      projectId: command.projectId,
      ...(command.editorInstanceId ? { editorInstanceId: command.editorInstanceId } : {})
    });
    return result.prefabGraph;
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

export function toRequest(command: CliCommand): [string, unknown] {
  if (command.command === 'editors') {
    return ['server.editors', {}];
  }

  const selector = command.editorInstanceId
    ? { projectId: command.projectId, editorInstanceId: command.editorInstanceId }
    : { projectId: command.projectId };

  switch (command.command) {
    case 'state':
      return ['probe.editorState', { selector, params: {} }];
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
    case 'probe-undo-save-prepare':
      return ['probe.undoSavePrepare', {
        selector,
        params: {
          projectPath: command.projectPath,
          documentAssetUuid: command.documentUuid,
          probeName: command.probeName
        }
      }];
    case 'probe-undo-save-confirm':
      return ['probe.undoSaveConfirm', {
        selector,
        params: {
          transactionId: command.transactionId,
          expectedRevision: command.expectedRevision
        }
      }];
    case 'probe-undo-save-status':
      return ['probe.undoSaveStatus', {
        selector,
        params: { transactionId: command.transactionId }
      }];
    case 'prefab-graph':
    case 'scan-project':
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
