import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOLKIT_VERSION = '0.2.5';
const entry = process.env.COCOS_AI_MCP_ENTRY;
if (!entry) throw new Error('COCOS_AI_MCP_ENTRY_REQUIRED');
const sourceCommit = process.env.COCOS_AI_SOURCE_COMMIT;
if (!sourceCommit) throw new Error('COCOS_AI_SOURCE_COMMIT_REQUIRED');
const enableWrites = process.env.COCOS_AI_MCP_ENABLE_WRITES !== 'false';
const profile = process.env.COCOS_AI_MCP_PROFILE ?? 'prefab';
if (!['prefab', 'full'].includes(profile)) throw new Error(`MCP_PROFILE_INVALID:${profile}`);
const serverModule = await import(pathToFileURL(join(dirname(entry), 'server.js')).href);
const prefabModule = await import(pathToFileURL(join(dirname(entry), 'prefab-tools.js')).href);
const assetModule = await import(pathToFileURL(join(dirname(entry), 'asset-tools.js')).href);
const PREFAB_READONLY_TOOL_NAMES = [...prefabModule.COCOS_PREFAB_READONLY_TOOL_NAMES];
const PREFAB_WRITE_TOOL_NAMES = [...prefabModule.COCOS_PREFAB_WRITE_TOOL_NAMES];
const ASSET_WRITE_TOOL_NAMES = [...assetModule.COCOS_ASSET_WRITE_TOOL_NAMES];
const FULL_READONLY_TOOL_NAMES = [...serverModule.COCOS_READONLY_TOOL_NAMES];
const FULL_WRITE_TOOL_NAMES = [
  ...serverModule.COCOS_WRITE_TOOL_NAMES,
  ...serverModule.COCOS_GATED_READONLY_TOOL_NAMES
];

const timeoutMs = Number(process.env.COCOS_AI_CHECK_TIMEOUT_MS ?? 15_000);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, `--profile=${profile}`, ...(enableWrites ? ['--enable-writes'] : [])],
  env: {
    ...process.env,
    COCOS_AI_PROBE_SERVER_URL: process.env.COCOS_AI_PROBE_SERVER_URL ?? 'ws://127.0.0.1:32188',
    COCOS_AI_MCP_REPORT_ROOT: process.env.COCOS_AI_MCP_REPORT_ROOT ?? 'reports'
  },
  stderr: 'pipe'
});
const client = new Client({ name: 'cocos-ai-health-check', version: TOOLKIT_VERSION });

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
  if (client.getServerVersion()?.version !== TOOLKIT_VERSION) {
    throw new Error(`MCP_VERSION_MISMATCH:${JSON.stringify({
      expected: TOOLKIT_VERSION,
      actual: client.getServerVersion()?.version ?? null
    })}`);
  }
  const listed = await withTimeout(client.listTools(), 'TOOLS_LIST');
  const names = listed.tools.map((tool) => tool.name);
  const expectedNames = profile === 'prefab'
    ? [
        ...PREFAB_READONLY_TOOL_NAMES,
        ...(enableWrites ? [...PREFAB_WRITE_TOOL_NAMES, ...ASSET_WRITE_TOOL_NAMES] : [])
      ]
    : [...FULL_READONLY_TOOL_NAMES, ...(enableWrites ? FULL_WRITE_TOOL_NAMES : [])];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`MCP_TOOL_PROFILE_MISMATCH:${JSON.stringify({ profile, expectedNames, names })}`);
  }
  const editorResult = await withTimeout(
    client.callTool({ name: 'cocos_editor_list', arguments: {} }),
    'COCOS_EDITOR_LIST'
  );
  if (editorResult.isError) throw new Error(`COCOS_EDITOR_LIST_FAILED:${JSON.stringify(editorResult.content)}`);
  const editors = Array.isArray(editorResult.structuredContent?.editors)
    ? editorResult.structuredContent.editors
    : [];
  const bridgeVersions = [...new Set(editors.map((editor) => editor.bridgeVersion))];
  if (bridgeVersions.some((version) => version !== TOOLKIT_VERSION)) {
    throw new Error(`BRIDGE_VERSION_MISMATCH:${JSON.stringify({
      expected: TOOLKIT_VERSION,
      actual: bridgeVersions
    })}`);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    toolkitVersion: TOOLKIT_VERSION,
    sourceCommit,
    serverVersion: client.getServerVersion(),
    bridgeVersions,
    profile,
    writeEnabled: enableWrites,
    toolCount: names.length,
    editors: editorResult.structuredContent ?? null
  }) + '\n');
} finally {
  await client.close().catch(() => undefined);
}
