/**
 * 阶段五探针：Preview 消息矩阵第一批（只读消息）。
 * 通过 Bridge 的 probe.debugEditorMessage 逐个调用 preview 命名空间消息，
 * 验证存在性、返回形态与挂起行为（Bridge 侧带 8s 超时兜底）。
 *
 * 用法：node scripts/probes/phase-5/preview-messages-readonly.mjs [projectId]
 */
import { ProbeClient } from '../../../packages/client/dist/index.js';

const projectId = process.argv[2] ?? 'b7d6c25f-30f3-44e7-874a-9284c0517a3f';

const CASES = [
  { namespace: 'preview', method: 'query-preview-url' },
  { namespace: 'preview', method: 'query-connect-num' },
  { namespace: 'preview', method: 'get-preview-ip' },
  { namespace: 'preview', method: 'generate-settings' }
];

const client = new ProbeClient('ws://127.0.0.1:32188', 15_000);
await client.connect();

for (const item of CASES) {
  const started = Date.now();
  try {
    const reply = await client.request('probe.debugEditorMessage', {
      selector: { projectId },
      params: { namespace: item.namespace, method: item.method, timeoutMs: 8_000 }
    });
    const text = JSON.stringify(reply);
    console.log(`[OK] ${item.namespace}/${item.method} (${Date.now() - started}ms)`);
    console.log(text.length > 2_000 ? `${text.slice(0, 2_000)}…(${text.length} bytes)` : text);
  } catch (error) {
    console.log(`[FAIL] ${item.namespace}/${item.method} (${Date.now() - started}ms) ${error.message}`);
  }
}

await client.close();
