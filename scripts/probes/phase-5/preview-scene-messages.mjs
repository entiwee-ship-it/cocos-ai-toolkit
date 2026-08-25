/**
 * 阶段五探针：Preview 与 Scene 剩余消息矩阵。
 * 覆盖 preview 页面管理消息与 scene/snapshot 截图入口。
 * 注意：本批消息有状态副作用，按序执行并观察。
 *
 * 用法：node scripts/probes/phase-5/preview-scene-messages.mjs [projectId]
 */
import { ProbeClient } from '../../../packages/client/dist/index.js';

const projectId = process.argv[2] ?? 'b7d6c25f-30f3-44e7-874a-9284c0517a3f';
const client = new ProbeClient('ws://127.0.0.1:32188', 20_000, undefined, 500, 10_000, process.env.COCOS_AI_SESSION_TOKEN);
await client.connect();

async function call(namespace, method, args = [], timeoutMs = 10_000) {
  const started = Date.now();
  try {
    const reply = await client.request('probe.debugEditorMessage', {
      selector: { projectId },
      params: { namespace, method, args, timeoutMs }
    });
    console.log(`[OK] ${namespace}/${method} (${Date.now() - started}ms) ${JSON.stringify(reply).slice(0, 400)}`);
    return reply.result;
  } catch (error) {
    console.log(`[FAIL] ${namespace}/${method} (${Date.now() - started}ms) ${error.message}`);
    return undefined;
  }
}

console.log('--- scene/snapshot（Scene 视图截图）---');
await call('scene', 'snapshot');

console.log('--- preview/change-platform 查询当前平台（send 改 browser 再查 URL）---');
await call('preview', 'query-preview-url');

console.log('--- preview/reload-terminal（刷新已接入页面）---');
await call('preview', 'reload-terminal');

console.log('--- preview/preview-scene-in-browser ---');
await call('preview', 'preview-scene-in-browser');

console.log('--- preview/open-terminal（Ctrl+P 菜单动作，toggle 观察）---');
await call('preview', 'open-terminal');
await new Promise((resolve) => setTimeout(resolve, 3_000));
await call('preview', 'query-connect-num');

console.log('--- preview/restart-simulator ---');
await call('preview', 'restart-simulator');

await client.close();
