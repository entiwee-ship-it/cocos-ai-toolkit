#!/usr/bin/env node

import { ProbeClient } from '@cocos-ai/client';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCocosMcpServer } from './server.js';

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:32188';
const DEFAULT_REPORT_ROOT = 'reports';

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
  reportRoot: string;
  enableWrites: boolean;
}

/**
 * 从进程环境和启动参数读取 Probe Server 地址、MCP 服务端授权报告根和写能力开关。
 * 写工具仅当命令行显式传入 --enable-writes 时注册，环境变量不能开启写能力。
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
    reportRoot: resolve(environment.COCOS_AI_MCP_REPORT_ROOT ?? DEFAULT_REPORT_ROOT),
    enableWrites: argv.includes('--enable-writes')
  };
}

/**
 * 先连接唯一 Probe Client，再启动 MCP Transport，并返回幂等关闭句柄。
 *
 * @param options 已构造的 Probe Client、MCP Server 和 Transport。
 * @param options.probeClient 提供 Creator WebSocket 请求的共享客户端。
 * @param options.server 已登记八个只读工具的 MCP Server。
 * @param options.transport 当前 MCP stdio Transport。
 * @returns 可安全重复调用的运行时关闭句柄。
 */
export async function startMcpRuntime<TTransport>(options: {
  probeClient: RuntimeProbeClient;
  server: RuntimeMcpServer<TTransport>;
  transport: TTransport;
}): Promise<McpRuntime> {
  try {
    await options.probeClient.connect();
    await options.server.connect(options.transport);
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
 * 使用真实 Probe Client 和 stdio Transport 启动 Cocos 只读 MCP Server。
 *
 * @param environment 可选环境变量覆盖，默认使用当前进程环境。
 * @returns 已连接且可关闭的 MCP 运行时。
 */
export async function runMcpServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv.slice(2)
): Promise<McpRuntime> {
  const config = readMcpRuntimeConfig(environment, argv);
  const probeClient = new ProbeClient(config.serverUrl);
  const server = createCocosMcpServer(
    { probeClient, reportRoot: config.reportRoot },
    { enableWrites: config.enableWrites }
  );
  const transport = new StdioServerTransport();
  return startMcpRuntime({ probeClient, server, transport });
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
