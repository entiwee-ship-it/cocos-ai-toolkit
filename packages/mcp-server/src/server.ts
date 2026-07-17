import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CocosReadonlyToolService,
  CocosWriteToolService,
  registerCocosReadonlyTools,
  registerCocosWriteTools,
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

export const COCOS_WRITE_TOOL_NAMES = [
  'cocos_write_prepare',
  'cocos_write_confirm',
  'cocos_transaction_status',
  'cocos_transaction_list',
  'cocos_transaction_rollback'
] as const;

/** MCP 运行时开关；写能力必须显式开启，默认保持只读。 */
export interface CocosMcpRuntimeOptions {
  enableWrites?: boolean;
}

/**
 * 创建 Cocos MCP Server：默认只暴露阶段一八个只读工具；
 * 仅当显式 enableWrites（对应启动参数 --enable-writes）时追加注册阶段二写工具。
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
    version: '0.1.0'
  });
  const readonlyService = new CocosReadonlyToolService(options);
  registerCocosReadonlyTools(server, readonlyService);
  if (runtime.enableWrites === true) {
    registerCocosWriteTools(server, new CocosWriteToolService(options, readonlyService));
  }
  return server;
}
