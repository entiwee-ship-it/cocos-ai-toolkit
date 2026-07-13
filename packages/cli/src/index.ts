#!/usr/bin/env node

import { ProbeClient } from './client.js';
import { parseCommand, type CliCommand } from './commands.js';
import { pathToFileURL } from 'node:url';

const DEFAULT_SERVER_URL = process.env.COCOS_AI_PROBE_SERVER_URL ?? 'ws://127.0.0.1:4318';

const HELP = `用法:
  cocos-ai-probe editors
  cocos-ai-probe state --project-id <id> [--editor-instance-id <id>]
  cocos-ai-probe assets --project-id <id> --pattern <text> [--editor-instance-id <id>]
  cocos-ai-probe hierarchy --project-id <id> [--editor-instance-id <id>] [--depth <n>]
  cocos-ai-probe node --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai-probe component --project-id <id> --uuid <uuid> [--editor-instance-id <id>]
  cocos-ai-probe prefab --project-id <id> --node-uuid <uuid> [--editor-instance-id <id>]
  cocos-ai-probe save-report --project-id <id> --sample <name> [--editor-instance-id <id>]

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

  const client = new ProbeClient(options.serverUrl ?? DEFAULT_SERVER_URL);
  try {
    await client.connect();
    const payload = await client.request(...toRequest(command));
    stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    writeError(stderr, error);
    return 1;
  } finally {
    await client.close();
  }
}

function toRequest(command: CliCommand): [string, unknown] {
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
      return ['probe.assets', { selector, params: { pattern: command.pattern } }];
    case 'hierarchy':
      return ['probe.hierarchy', { selector, params: { depth: command.depth } }];
    case 'node':
      return ['probe.node', { selector, params: { uuid: command.uuid } }];
    case 'component':
      return ['probe.component', { selector, params: { uuid: command.uuid } }];
    case 'prefab':
      return ['probe.prefab', { selector, params: { nodeUuid: command.nodeUuid } }];
    case 'save-report':
      return ['probe.saveReport', { selector, params: { sample: command.sample } }];
  }
}

function writeError(stderr: NodeJS.WritableStream, error: unknown): void {
  const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  const message = errorMessage(code);
  stderr.write(`${JSON.stringify({ code, message, details: {} })}\n`);
}

function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    COMMAND_REQUIRED: '必须指定探针命令',
    INVALID_ARGUMENTS: '命令参数格式无效',
    UNKNOWN_COMMAND: '未知探针命令',
    PROJECT_ID_REQUIRED: '缺少 project-id',
    PATTERN_REQUIRED: '缺少 pattern',
    UUID_REQUIRED: '缺少 uuid',
    NODE_UUID_REQUIRED: '缺少 node-uuid',
    SAMPLE_REQUIRED: '缺少 sample',
    INVALID_DEPTH: 'depth 必须是 1 到 20 的整数',
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
