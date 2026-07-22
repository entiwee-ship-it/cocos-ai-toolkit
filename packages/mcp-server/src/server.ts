import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CocosReadonlyToolService,
  CocosDesignToolService,
  CocosWriteToolService,
  registerCocosDesignGatedTools,
  registerCocosDesignReadonlyTools,
  registerCocosReadonlyTools,
  registerCocosWriteTools,
  type CocosReadonlyToolServiceOptions
} from './tools.js';
import {
  CocosRuntimeToolService,
  registerCocosRuntimeGatedTools,
  registerCocosRuntimeReadonlyTools
} from './runtime-tools.js';

export const COCOS_READONLY_TOOL_NAMES = [
  'cocos_editor_list',
  'cocos_editor_state',
  'cocos_asset_search',
  'cocos_asset_inspect',
  'cocos_component_schema',
  'cocos_document_snapshot',
  'cocos_prefab_graph',
  'cocos_project_scan',
  'cocos_design_inspect',
  'cocos_design_plan',
  'cocos_design_preview',
  'cocos_preview_sessions',
  'cocos_runtime_get_hierarchy',
  'cocos_runtime_inspect_component',
  'cocos_runtime_get_console',
  'cocos_runtime_watch_property',
  'cocos_runtime_capture'
] as const;

export const COCOS_WRITE_TOOL_NAMES = [
  'cocos_write_prepare',
  'cocos_write_confirm',
  'cocos_transaction_status',
  'cocos_transaction_list',
  'cocos_transaction_rollback',
  'cocos_preview_launch',
  'cocos_preview_stop',
  'cocos_runtime_invoke_method',
  'cocos_runtime_dispatch_input',
  'cocos_runtime_run_scenario',
  'cocos_design_apply'
] as const;

/** 只有显式 enableWrites 才注册、但本身不修改 Creator 的设计工具。 */
export const COCOS_GATED_READONLY_TOOL_NAMES = [
  'cocos_design_verify',
  'cocos_design_export'
] as const;

/** MCP 运行时开关；写能力必须显式开启，默认保持只读。 */
export interface CocosMcpRuntimeOptions {
  enableWrites?: boolean;
}

/**
 * 创建 Cocos MCP Server：默认暴露阶段一基础只读工具和阶段四三个声明式只读工具；
 * 默认同时开放声明式 inspect/plan/preview；仅当显式 enableWrites（对应启动参数
 * --enable-writes）时追加注册阶段二写工具和 design apply/verify/export。
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
  registerCocosDesignReadonlyTools(server, new CocosDesignToolService(options, readonlyService));
  registerCocosRuntimeReadonlyTools(server, new CocosRuntimeToolService(options, readonlyService));
  if (runtime.enableWrites === true) {
    const writeService = new CocosWriteToolService(options, readonlyService);
    registerCocosWriteTools(server, writeService);
    registerCocosRuntimeGatedTools(server, new CocosRuntimeToolService(options, readonlyService));
    registerCocosDesignGatedTools(
      server,
      new CocosDesignToolService(options, readonlyService, writeService)
    );
  }
  return server;
}
