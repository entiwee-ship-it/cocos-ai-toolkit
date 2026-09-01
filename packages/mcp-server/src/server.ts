import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CocosReadonlyToolService,
  type CocosReadonlyToolServiceOptions
} from './tools.js';
import {
  CocosRuntimeToolService,
  registerCocosRuntimeGatedTools,
  registerCocosRuntimeReadonlyTools
} from './runtime-tools.js';
import {
  CocosDirectToolService,
  registerCocosDirectReadonlyTools,
  registerCocosDirectWriteTools
} from './direct-tools.js';

/** MCP 运行时开关；写能力必须显式开启，默认保持只读。 */
export interface CocosMcpRuntimeOptions {
  enableWrites?: boolean;
}

/**
 * 创建 Cocos MCP Server：直写架构单一工具档。
 * 默认暴露只读工具（编辑器/资产/层级/节点读取、Prefab 打开、运行态读取）；
 * 显式 enableWrites（对应启动参数 --enable-writes）时追加直写工具和运行态动作工具。
 *
 * @param options 共享 Probe Client 和服务器授权的报告根目录。
 * @param runtime 运行时开关。
 * @returns 已登记工具的 MCP Server。
 */
export function createCocosMcpServer(
  options: CocosReadonlyToolServiceOptions,
  runtime: CocosMcpRuntimeOptions = {}
): McpServer {
  const server = new McpServer({
    name: 'cocos-ai-toolkit',
    version: '0.6.9'
  });
  const readonlyService = new CocosReadonlyToolService(options);
  const runtimeService = new CocosRuntimeToolService(options, readonlyService);
  const directService = new CocosDirectToolService(readonlyService);
  registerCocosDirectReadonlyTools(server, directService);
  registerCocosRuntimeReadonlyTools(server, runtimeService);
  if (runtime.enableWrites === true) {
    registerCocosDirectWriteTools(server, directService);
    registerCocosRuntimeGatedTools(server, runtimeService);
  }
  return server;
}
