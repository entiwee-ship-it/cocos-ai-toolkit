#!/usr/bin/env node

import { ProbeClient } from '@cocos-ai/client';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { createCocosMcpServer } from './server.js';

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:32188';
/** 与 CLI 默认一致的单次请求等待超时毫秒数。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

interface RuntimeProbeClient {
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
  serverUrl: string;
  enableWrites: boolean;
  requestTimeoutMs: number;
  sessionToken: string | undefined;
}

/**
 * 从进程环境和启动参数读取 Probe Server 地址、写能力开关和请求超时。
 * 写工具仅当命令行显式传入 --enable-writes 时注册，环境变量不能开启写能力；
 * 直写架构已移除工具档机制，旧的 --profile 参数一律拒绝并提示。
 * 请求超时经 COCOS_AI_PROBE_TIMEOUT_MS 配置，与 CLI 共用同一环境变量。
 *
 * @param environment 环境变量键值；缺失值使用本机默认配置。
 * @param argv 启动参数（不含 node 和入口脚本路径）。
 * @returns 可直接创建 Probe Client 和 MCP Server 的运行配置。
 */
export function readMcpRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2)
): McpRuntimeConfig {
  return {
    serverUrl: environment.COCOS_AI_PROBE_SERVER_URL ?? DEFAULT_SERVER_URL,
    enableWrites: readEnableWrites(argv),
    requestTimeoutMs: readRequestTimeoutMs(environment.COCOS_AI_PROBE_TIMEOUT_MS),
    sessionToken: environment.COCOS_AI_SESSION_TOKEN || undefined
  };
}

/** 读取写能力开关；直写架构下 --profile 已移除，传入即报错提示。 */
function readEnableWrites(argv: readonly string[]): boolean {
  if (argv.includes('--profile') || argv.some((argument) => argument.startsWith('--profile='))) {
    throw new Error('MCP_PROFILE_REMOVED：工具档机制已移除，启动参数只保留 --enable-writes');
  }
  return argv.includes('--enable-writes');
}

/** 解析有限的正整数毫秒超时，缺省或非法时回退默认值。 */
function readRequestTimeoutMs(rawValue: string | undefined): number {
  const timeoutMs = Number(rawValue);
  return Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * 先启动 MCP Transport 暴露固定工具面，再让 Probe Client 在后台持续连接，并返回幂等关闭句柄。
 *
 * @param options 已构造的 Probe Client、MCP Server（包含默认只读和可选门控工具）和 Transport。
 * @param options.probeClient 提供 Creator WebSocket 请求的共享客户端。
 * @param options.server 已登记默认只读工具和可选门控工具的 MCP Server。
 * @param options.transport 当前 MCP stdio Transport。
 * @returns 可安全重复调用的运行时关闭句柄。
 */
export async function startMcpRuntime<TTransport>(options: {
  probeClient: RuntimeProbeClient;
  server: RuntimeMcpServer<TTransport>;
  transport: TTransport;
}): Promise<McpRuntime> {
  try {
    await options.server.connect(options.transport);
    void options.probeClient.connect().catch(() => undefined);
  } catch (error) {
    await closeRuntimeResources(options.server, options.probeClient).catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= closeRuntimeResources(options.server, options.probeClient);
      return closePromise;
    }
  };
}

/**
 * 使用真实 Probe Client 和 stdio Transport 启动直写工具档 Cocos MCP Server。
 *
 * @param environment 可选环境变量覆盖，默认使用当前进程环境。
 * @returns 已连接且可关闭的 MCP 运行时。
 */
export async function runMcpServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2)
): Promise<McpRuntime> {
  const config = readMcpRuntimeConfig(environment, argv);
  const probeClient = new ProbeClient(
    config.serverUrl,
    config.requestTimeoutMs,
    undefined,
    500,
    10_000,
    config.sessionToken
  );
  const server = createCocosMcpServer({ probeClient }, { enableWrites: config.enableWrites });
  const transport = new StdioServerTransport();
  patchTransportSchemaRefs(transport);
  return startMcpRuntime({ probeClient, server, transport });
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
 * 无论 MCP Server 关闭是否失败，都继续释放 Probe Client，并保留首个错误。
 *
 * @param server 当前 MCP Server。
 * @param probeClient 当前 Probe Client。
 */
async function closeRuntimeResources(
  server: { close(): Promise<void> },
  probeClient: { close(): Promise<void> }
): Promise<void> {
  let firstError: unknown;
  try {
    await server.close();
  } catch (error) {
    firstError = error;
  }
  try {
    await probeClient.close();
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
