import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CocosReadonlyToolService,
  registerCocosReadonlyTools,
  type CocosReadonlyToolServiceOptions
} from './tools.js';

export const COCOS_READONLY_TOOL_NAMES = [
  'cocos_editor_list',
  'cocos_editor_state',
  'cocos_asset_search',
  'cocos_asset_inspect',
  'cocos_component_schema',
  'cocos_document_snapshot',
  'cocos_prefab_graph',
  'cocos_project_scan'
] as const;

/**
 * 创建只暴露阶段一读取能力的 Cocos MCP Server。
 *
 * @param options 共享 Probe Client 和服务器授权的报告根目录。
 * @returns 已登记八个只读工具的 MCP Server。
 */
export function createCocosMcpServer(
  options: CocosReadonlyToolServiceOptions
): McpServer {
  const server = new McpServer({
    name: 'cocos-ai-toolkit',
    version: '0.1.0'
  });
  registerCocosReadonlyTools(server, new CocosReadonlyToolService(options));
  return server;
}
