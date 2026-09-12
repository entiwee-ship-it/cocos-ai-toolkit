const RUNTIME_AGENT_PATH = 'cocos-ai/runtime-agent.js';

/** 在其它插件前加载运行态代理，以采集项目启动日志；不修改项目资源。 */
export async function onSettingsSimulator(settings: unknown): Promise<void> {
  const root = readObject(settings);
  const plugins = readObject(root.plugins);
  const jsList = Array.isArray(plugins.jsList)
    ? plugins.jsList.filter((value): value is string => typeof value === 'string' && value !== RUNTIME_AGENT_PATH)
    : [];
  jsList.unshift(RUNTIME_AGENT_PATH);

  const port = await Editor.Message.request('server', 'query-port');
  if (!Number.isInteger(port) || (port as number) <= 0) {
    throw new Error('PREVIEW_SERVER_PORT_UNAVAILABLE');
  }
  plugins.jsList = jsList;
  plugins.cocosAiRuntime = {
    baseUrl: `http://127.0.0.1:${port}/cocos-ai/runtime`,
    pollIntervalMs: 50
  };
  root.plugins = plugins;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
