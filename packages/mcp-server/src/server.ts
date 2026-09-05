import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CocosReadonlyToolService,
  type CocosReadonlyToolServiceOptions
} from './tools.js';
import {
  CocosRuntimeToolService,
  registerCocosRuntimeActionTools,
  registerCocosRuntimeReadonlyTools
} from './runtime-tools.js';
import {
  CocosDirectToolService,
  registerCocosDirectReadonlyTools,
  registerCocosDirectWriteTools
} from './direct-tools.js';

/**
 * 创建 Cocos MCP Server：所有工具默认公开注册。
 * 读工具和编辑器/运行态动作工具共用同一 Creator IPC 端点；
 * 写入工具仍保留自身的参数、确认、权限和回读校验。
 *
 * @param options 共享 Creator IPC Client。
 * @returns 已登记工具的 MCP Server。
 */
export function createCocosMcpServer(
  options: CocosReadonlyToolServiceOptions
): McpServer {
  const server = new McpServer({
    name: 'cocos-ai-toolkit',
    version: '0.9.0'
  });
  const readonlyService = new CocosReadonlyToolService(options);
  const runtimeService = new CocosRuntimeToolService(options, readonlyService);
  const directService = new CocosDirectToolService(readonlyService);
  registerCocosDirectReadonlyTools(server, directService);
  registerCocosDirectWriteTools(server, directService);
  registerCocosRuntimeReadonlyTools(server, runtimeService);
  registerCocosRuntimeActionTools(server, runtimeService);
  return server;
}
