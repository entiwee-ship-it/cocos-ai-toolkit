import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeDriver } from '@cocos-ai/core';
import { DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS, ProbeServer } from './server.js';
import { launchPlaywrightBrowser } from './playwright-launcher.js';

const host = process.env.COCOS_AI_PROBE_HOST ?? '127.0.0.1';
const port = Number(process.env.COCOS_AI_PROBE_PORT ?? '32188');
const requestTimeoutMs = Number(process.env.COCOS_AI_PROBE_TIMEOUT_MS ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS);
const sessionToken = process.env.COCOS_AI_SESSION_TOKEN || undefined;
// 截图落盘根固定在工具仓库 reports 下（dist/run.js 上溯三级），不随启动 cwd 漂移。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const captureRoot = process.env.COCOS_AI_CAPTURE_ROOT ?? join(repoRoot, 'reports', 'runtime-captures');
const captureFilesPerSession = Number(process.env.COCOS_AI_CAPTURE_FILES_PER_SESSION ?? '100');

// 阶段五：装配运行态页面驱动（playwright-core + 系统 Chrome/Edge）。
const runtimeDriver = new RuntimeDriver({
  launcher: launchPlaywrightBrowser
});

const server = new ProbeServer({
  host,
  port,
  requestTimeoutMs,
  runtimeDriver,
  captureRoot,
  captureFilesPerSession,
  sessionToken
});
const address = await server.start();
console.log(JSON.stringify({ type: 'probe-server.ready', url: `ws://${address.host}:${address.port}` }));

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
