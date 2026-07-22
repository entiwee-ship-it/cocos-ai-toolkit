/**
 * 阶段五探针：Preview 启动序列。
 * 依次验证 preview/open 启动、连接数与 URL 变化、页面 HTTP 可达性。
 *
 * 用法：node scripts/probes/phase-5/preview-launch-sequence.mjs [projectId]
 */
import { ProbeClient } from '../../../packages/client/dist/index.js';

const projectId = process.argv[2] ?? 'b7d6c25f-30f3-44e7-874a-9284c0517a3f';
const client = new ProbeClient('ws://127.0.0.1:32188', 20_000);
await client.connect();

async function call(method, args = [], timeoutMs = 10_000) {
  const started = Date.now();
  try {
    const reply = await client.request('probe.debugEditorMessage', {
      selector: { projectId },
      params: { namespace: 'preview', method, args, timeoutMs }
    });
    console.log(`[OK] preview/${method} (${Date.now() - started}ms) ${JSON.stringify(reply).slice(0, 500)}`);
    return reply.result;
  } catch (error) {
    console.log(`[FAIL] preview/${method} (${Date.now() - started}ms) ${error.message}`);
    return undefined;
  }
}

console.log('--- 启动前状态 ---');
await call('query-preview-url');
await call('query-connect-num');

console.log('--- 调用 open ---');
await call('open', [], 20_000);

console.log('--- 启动后状态 ---');
await call('query-preview-url');
await call('query-connect-num');

console.log('--- 轮询连接数（等待页面接入，最多 30s）---');
for (let i = 0; i < 10; i++) {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const num = await call('query-connect-num');
  if (typeof num === 'number' && num > 0) {
    console.log(`页面已接入，连接数=${num}`);
    break;
  }
}

console.log('--- 页面 HTTP 可达性 ---');
const url = await call('query-preview-url');
if (typeof url === 'string') {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    console.log(`HTTP ${response.status}，HTML ${text.length} 字节`);
    console.log(text.slice(0, 400).replace(/\s+/g, ' '));
  } catch (error) {
    console.log(`页面抓取失败: ${error.message}`);
  }
}

await client.close();
