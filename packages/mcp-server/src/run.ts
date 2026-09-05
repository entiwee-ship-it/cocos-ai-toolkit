#!/usr/bin/env node

import { CreatorClient } from '@cocos-ai/client';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { createCocosMcpServer } from './server.js';

/** 与 CLI 默认一致的单次请求等待超时毫秒数。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

interface RuntimeCreatorClient {
  connect(): Promise<void>;
  close(): Promise<void>;
}

interface RuntimeMcpServer<TTransport> {
  connect(transport: TTransport): Promise<void>;
  close(): Promise<void>;
}

export interface McpRuntime {
  close(): Promise<void>;
}

export interface McpRuntimeConfig {
  endpointRoot: string | undefined;
  captureRoot: string | undefined;
  requestTimeoutMs: number;
  sessionToken: string | undefined;
}

/**
 * 从进程环境和启动参数读取 Creator IPC 和请求超时。
 * 所有 MCP 工具默认公开；当前入口不接受任何启动参数。
 * 请求超时经 COCOS_AI_IPC_TIMEOUT_MS 配置，与 CLI 共用同一环境变量。
 *
 * @param environment 环境变量键值；缺失值使用本机默认配置。
 * @param argv 启动参数（不含 node 和入口脚本路径）。
 * @returns 可直接创建 Creator Client 和 MCP Server 的运行配置。
 */
export function readMcpRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2)
): McpRuntimeConfig {
  validateMcpArguments(argv);
  return {
    endpointRoot: environment.COCOS_AI_ENDPOINT_ROOT || undefined,
    captureRoot: environment.COCOS_AI_CAPTURE_ROOT || undefined,
    requestTimeoutMs: readRequestTimeoutMs(environment.COCOS_AI_IPC_TIMEOUT_MS),
    sessionToken: environment.COCOS_AI_SESSION_TOKEN || undefined
  };
}

function validateMcpArguments(argv: readonly string[]): void {
  const invalid = argv[0];
  if (invalid) throw new Error(`MCP_ARGUMENT_INVALID:${invalid}`);
}

/** 解析有限的正整数毫秒超时，缺省或非法时回退默认值。 */
function readRequestTimeoutMs(rawValue: string | undefined): number {
  const timeoutMs = Number(rawValue);
  return Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * 启动 MCP Transport 和本机 Creator Client，并返回幂等关闭句柄。
 *
 * @param options 已构造的 Creator Client、包含全部公开工具的 MCP Server 和 Transport。
 * @param options.creatorClient 提供 Creator Named Pipe 请求的共享客户端。
 * @param options.server 已登记全部公开工具的 MCP Server。
 * @param options.transport 当前 MCP stdio Transport。
 * @returns 可安全重复调用的运行时关闭句柄。
 */
export async function startMcpRuntime<TTransport>(options: {
  creatorClient: RuntimeCreatorClient;
  server: RuntimeMcpServer<TTransport>;
  transport: TTransport;
}): Promise<McpRuntime> {
  try {
    await options.server.connect(options.transport);
    await options.creatorClient.connect();
  } catch (error) {
    await closeRuntimeResources(options.server, options.creatorClient).catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= closeRuntimeResources(options.server, options.creatorClient);
      return closePromise;
    }
  };
}

/**
 * 使用真实 Creator IPC Client 和 stdio Transport 启动 Cocos MCP Server。
 *
 * @param environment 可选环境变量覆盖，默认使用当前进程环境。
 * @returns 已连接且可关闭的 MCP 运行时。
 */
export async function runMcpServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2)
): Promise<McpRuntime> {
  const config = readMcpRuntimeConfig(environment, argv);
  const creatorClient = new CreatorClient({
    requestTimeoutMs: config.requestTimeoutMs,
    ...(config.endpointRoot ? { endpointRoot: config.endpointRoot } : {}),
    ...(config.captureRoot ? { captureRoot: config.captureRoot } : {}),
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {})
  });
  const server = createCocosMcpServer({ creatorClient });
  const transport = new StdioServerTransport();
  patchTransportSchemaRefs(transport);
  return startMcpRuntime({ creatorClient, server, transport });
}

/**
 * 递归改写 JSON Schema：把 draft-7 风格的 definitions 容器和 #/definitions/ 引用
 * 转换为 #/$defs/ 形式。Moonshot(Kimi) 模型端只接受以 #/$defs/ 开头的 $ref，
 * 而 MCP SDK 默认按 draft-7 生成 #/definitions/ 引用，会导致模型端 400 拒绝请求。
 *
 * @param value 任意 JSON Schema 片段。
 * @returns 改写后的 JSON Schema 片段。
 */
function normalizeJsonSchemaRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonSchemaRefs(item));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof item === 'string') {
        output[key] = item.replace(/^#\/definitions\//, '#/$defs/');
      } else {
        output[key === 'definitions' ? '$defs' : key] = normalizeJsonSchemaRefs(item);
      }
    }
    return output;
  }
  return value;
}

/**
 * 包装 stdio Transport 的 send，拦截 tools/list 响应并改写其中的
 * inputSchema/outputSchema 引用路径，对协议其余消息保持透明。
 *
 * @param transport 当前 MCP stdio Transport。
 */
function patchTransportSchemaRefs(transport: StdioServerTransport): void {
  const originalSend = transport.send.bind(transport);
  transport.send = async (message: Parameters<StdioServerTransport['send']>[0]) => {
    const tools = (message as { result?: { tools?: Array<Record<string, unknown>> } })?.result?.tools;
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        if (tool.inputSchema) tool.inputSchema = normalizeJsonSchemaRefs(tool.inputSchema);
        if (tool.outputSchema) tool.outputSchema = normalizeJsonSchemaRefs(tool.outputSchema);
      }
    }
    return originalSend(message);
  };
}

/**
 * 无论 MCP Server 关闭是否失败，都继续释放 Creator Client，并保留首个错误。
 *
 * @param server 当前 MCP Server。
 * @param creatorClient 当前 Creator Client。
 */
async function closeRuntimeResources(
  server: { close(): Promise<void> },
  creatorClient: { close(): Promise<void> }
): Promise<void> {
  let firstError: unknown;
  try {
    await server.close();
  } catch (error) {
    firstError = error;
  }
  try {
    await creatorClient.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError) throw firstError;
}

/**
 * 把启动或关闭错误写入 stderr，避免污染 MCP stdio 协议输出。
 *
 * @param code 稳定运行时错误码。
 * @param error 原始异常。
 */
function writeRuntimeError(code: string, error: unknown): void {
  process.stderr.write(`${JSON.stringify({
    code,
    message: 'Cocos MCP Server 运行失败',
    details: {
      reason: error instanceof Error ? error.message : String(error)
    }
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().then((runtime) => {
    let isClosing = false;
    const shutdown = () => {
      if (isClosing) return;
      isClosing = true;
      runtime.close().then(() => {
        process.exitCode = 0;
      }).catch((error) => {
        writeRuntimeError('MCP_SERVER_CLOSE_FAILED', error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdin.once('end', shutdown);
  }).catch((error) => {
    writeRuntimeError('MCP_SERVER_START_FAILED', error);
    process.exitCode = 1;
  });
}
