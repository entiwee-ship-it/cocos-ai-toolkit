#!/usr/bin/env node

import { CreatorClient } from '@cocos-ai/client';
import { parseCommand, type CliCommand } from './commands.js';
import { pathToFileURL } from 'node:url';

// 真实项目资产和层级读取可能较慢；需要更短超时时用 COCOS_AI_IPC_TIMEOUT_MS 显式调小。
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

/** CLI 侧只读探针客户端抽象。 */
export interface ReadonlyCreatorClient {
  request(method: string, payload: unknown): Promise<unknown>;
}

const HELP = `用法:
  cocos-ai editors
  cocos-ai state --project-id <id> [--editor-instance-id <id>]
  cocos-ai assets --project-id <id> --pattern <text> [--uuid <uuid>] [--editor-instance-id <id>]
  cocos-ai open-asset --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai hierarchy --project-id <id> [--editor-instance-id <id>] [--depth <n>]
  cocos-ai node --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai component --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai prefab --project-id <id> --node-uuid <uuid> [--editor-instance-id <id>]
  cocos-ai asset-index --project-id <id> [--editor-instance-id <id>]
  cocos-ai runtime-scenario --project-id <id> [--editor-instance-id <id>] --steps <包含 launch 与 stop(always:true) 的 json 数组>

环境变量:
  COCOS_AI_ENDPOINT_ROOT     Creator 端点描述目录，通常无需配置
  COCOS_AI_IPC_TIMEOUT_MS    单次请求等待毫秒数，默认 180000
  COCOS_AI_SESSION_TOKEN     Creator 本机直连启用认证时使用的会话令牌

CLI 提供编辑态只读诊断和单进程 runtime-scenario；需要持续 Preview 会话时使用 MCP。`;

export async function runCli(
  argv: string[],
  options: { endpointRoot?: string; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {}
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
    assertCliCommandSupported(command);
  } catch (error) {
    writeError(stderr, error);
    return 1;
  }

  const requestTimeoutMs = readRequestTimeoutMs(process.env.COCOS_AI_IPC_TIMEOUT_MS);
  const client = new CreatorClient({
    requestTimeoutMs,
    ...(options.endpointRoot || process.env.COCOS_AI_ENDPOINT_ROOT
      ? { endpointRoot: options.endpointRoot ?? process.env.COCOS_AI_ENDPOINT_ROOT }
      : {}),
    ...(process.env.COCOS_AI_CAPTURE_ROOT
      ? { captureRoot: process.env.COCOS_AI_CAPTURE_ROOT }
      : {}),
    ...(process.env.COCOS_AI_SESSION_TOKEN
      ? { sessionToken: process.env.COCOS_AI_SESSION_TOKEN }
      : {})
  });
  try {
    await client.connect();
    const payload = await executeCommand(command, client);
    stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    writeError(stderr, error);
    return 1;
  } finally {
    await client.close();
  }
}

const MCP_ONLY_RUNTIME_COMMANDS = new Set<CliCommand['command']>([
  'preview-launch',
  'preview-stop',
  'preview-sessions',
  'runtime-console',
  'runtime-hierarchy',
  'runtime-component',
  'runtime-invoke',
  'runtime-watch',
  'runtime-input',
  'runtime-instantiate',
  'runtime-capture'
]);

/** 无后台会话服务时，CLI 只允许单进程完成的场景验证。 */
export function assertCliCommandSupported(command: CliCommand): void {
  if (MCP_ONLY_RUNTIME_COMMANDS.has(command.command)) {
    throw new Error('CLI_RUNTIME_SESSION_REQUIRES_MCP');
  }
  if (command.command !== 'runtime-scenario') return;
  if (
    command.sessionId
    || !command.projectId
    || !command.steps.some((step) => step.kind === 'launch')
    || !command.steps.some((step) => step.kind === 'stop' && step.always === true)
  ) {
    throw new Error('CLI_SCENARIO_MUST_OWN_SESSION');
  }
}

/**
 * 执行只读 Bridge 请求或运行态命令。
 *
 * @param command 已解析的 CLI 命令。
 * @param client 已连接的共享只读 Client。
 * @returns 可直接输出为 JSON 的结果。
 */
export async function executeCommand(
  command: CliCommand,
  client: ReadonlyCreatorClient
): Promise<unknown> {
  return client.request(...toRequest(command));
}

/**
 * 读取单次 Creator IPC 请求超时，并对非法环境变量回退到稳定默认值。
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
  if (command.command === 'runtime-hierarchy') {
    return ['server.runtimeHierarchy', {
      sessionId: command.sessionId,
      ...(command.maxDepth !== undefined ? { maxDepth: command.maxDepth } : {}),
      ...(command.maxNodes !== undefined ? { maxNodes: command.maxNodes } : {}),
      ...(command.path ? { path: command.path } : {}),
      ...(command.includeInactive !== undefined ? { includeInactive: command.includeInactive } : {})
    }];
  }
  if (command.command === 'runtime-component') {
    return ['server.runtimeComponent', {
      sessionId: command.sessionId,
      path: command.path,
      componentType: command.componentType
    }];
  }
  if (command.command === 'runtime-invoke') {
    return ['server.runtimeInvoke', {
      sessionId: command.sessionId,
      path: command.path,
      componentType: command.componentType,
      method: command.method,
      ...(command.args ? { args: command.args } : {})
    }];
  }
  if (command.command === 'runtime-watch') {
    return ['server.runtimeWatch', {
      sessionId: command.sessionId,
      path: command.path,
      componentType: command.componentType,
      property: command.property,
      ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      ...(command.intervalMs !== undefined ? { intervalMs: command.intervalMs } : {}),
      ...(command.maxChanges !== undefined ? { maxChanges: command.maxChanges } : {})
    }];
  }
  if (command.command === 'runtime-input') {
    return ['server.runtimeDispatchInput', {
      sessionId: command.sessionId,
      inputType: command.inputType,
      ...(command.x !== undefined ? { x: command.x } : {}),
      ...(command.y !== undefined ? { y: command.y } : {}),
      ...(command.key !== undefined ? { key: command.key } : {})
    }];
  }
  if (command.command === 'runtime-instantiate') {
    return ['server.runtimeInstantiate', {
      sessionId: command.sessionId,
      assetUuid: command.assetUuid,
      parentPath: command.parentPath,
      ...(command.x !== undefined ? { x: command.x } : {}),
      ...(command.y !== undefined ? { y: command.y } : {})
    }];
  }
  if (command.command === 'runtime-capture') {
    return ['server.runtimeCapture', {
      sessionId: command.sessionId,
      ...(command.resolution ? { resolution: command.resolution } : {}),
      ...(command.resolutions ? { resolutions: command.resolutions } : {}),
      ...(command.crop ? { crop: command.crop } : {}),
      ...(command.overlayNodeBounds !== undefined || command.overlayAnchors !== undefined
        ? {
            overlay: {
              ...(command.overlayNodeBounds !== undefined ? { nodeBounds: command.overlayNodeBounds } : {}),
              ...(command.overlayAnchors !== undefined ? { anchors: command.overlayAnchors } : {})
            }
          }
        : {})
    }];
  }
  if (command.command === 'runtime-scenario') {
    return ['server.runtimeRunScenario', {
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(command.projectId
        ? {
            selector: {
              projectId: command.projectId,
              ...(command.editorInstanceId ? { editorInstanceId: command.editorInstanceId } : {})
            }
          }
        : {}),
      steps: command.steps
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
    case 'open-asset':
      return ['probe.openAsset', { selector, params: { uuid: command.uuid } }];
    case 'prefab':
      return ['probe.prefab', { selector, params: { nodeUuid: command.nodeUuid } }];
  }
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
    SAMPLE_REQUIRED: '缺少 sample',
    INVALID_DEPTH: 'depth 必须是 1 到 20 的整数',
    MULTIPLE_EDITOR_INSTANCES: '同一项目存在多个编辑器实例，请明确指定 editor-instance-id',
    CREATOR_CLIENT_NOT_READY: 'Creator 本机直连客户端尚未启动',
    CREATOR_IPC_UNAVAILABLE: 'Creator 未打开或 Cocos AI Bridge 扩展未启用',
    CREATOR_IPC_REQUEST_TIMEOUT: 'Creator 工具请求超时',
    EDITOR_INSTANCE_DISCONNECTED: 'Creator 实例已断开',
    CLI_RUNTIME_SESSION_REQUIRES_MCP: 'Preview 会话必须通过同一个 MCP 任务管理；CLI 只支持一次完成的 runtime-scenario',
    CLI_SCENARIO_MUST_OWN_SESSION: 'CLI runtime-scenario 必须提供 project-id，并包含 launch 和 stop(always:true)',
  };
  return messages[code] ?? 'Cocos AI 工具请求失败';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
