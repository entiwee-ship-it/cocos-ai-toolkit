import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = process.env.COCOS_AI_MCP_ENTRY;
if (!entry) throw new Error('COCOS_AI_MCP_ENTRY_REQUIRED');
const enableWrites = process.env.COCOS_AI_MCP_ENABLE_WRITES !== 'false';

const timeoutMs = Number(process.env.COCOS_AI_CHECK_TIMEOUT_MS ?? 15_000);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: enableWrites ? [entry, '--enable-writes'] : [entry],
  env: {
    ...process.env,
    COCOS_AI_PROBE_SERVER_URL: process.env.COCOS_AI_PROBE_SERVER_URL ?? 'ws://127.0.0.1:32188',
    COCOS_AI_MCP_REPORT_ROOT: process.env.COCOS_AI_MCP_REPORT_ROOT ?? 'reports'
  },
  stderr: 'pipe'
});
const client = new Client({ name: 'cocos-ai-health-check', version: '0.1.0' });

const withTimeout = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

try {
  await withTimeout(client.connect(transport), 'MCP_CONNECT');
  const listed = await withTimeout(client.listTools(), 'TOOLS_LIST');
  const names = listed.tools.map((tool) => tool.name);
  if (!names.includes('cocos_editor_list')) throw new Error('COCOS_EDITOR_LIST_MISSING');
  if (enableWrites && !names.includes('cocos_write_prepare')) throw new Error('WRITE_TOOL_MISSING');
  if (!enableWrites && names.includes('cocos_write_prepare')) throw new Error('WRITE_TOOL_EXPOSED_BY_DEFAULT');
  const editorResult = await withTimeout(
    client.callTool({ name: 'cocos_editor_list', arguments: {} }),
    'COCOS_EDITOR_LIST'
  );
  if (editorResult.isError) throw new Error(`COCOS_EDITOR_LIST_FAILED:${JSON.stringify(editorResult.content)}`);
  process.stdout.write(JSON.stringify({ ok: true, toolCount: names.length, editors: editorResult.structuredContent ?? null }) + '\n');
} finally {
  await client.close().catch(() => undefined);
}
