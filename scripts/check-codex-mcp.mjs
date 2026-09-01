import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOLKIT_VERSION = '0.6.9';
const entry = process.env.COCOS_AI_MCP_ENTRY;
if (!entry) throw new Error('COCOS_AI_MCP_ENTRY_REQUIRED');
const sourceCommit = process.env.COCOS_AI_SOURCE_COMMIT;
if (!sourceCommit) throw new Error('COCOS_AI_SOURCE_COMMIT_REQUIRED');
const enableWrites = process.env.COCOS_AI_MCP_ENABLE_WRITES !== 'false';
const distDir = dirname(entry);
const directModule = await import(pathToFileURL(join(distDir, 'direct-tools.js')).href);
const runtimeModule = await import(pathToFileURL(join(distDir, 'runtime-tools.js')).href);
const bridgeDistDir = resolve(distDir, '..', '..', 'bridge-extension', 'dist');
const bridgeModule = await import(pathToFileURL(join(bridgeDistDir, 'bridge-state.js')).href);
const bridgeBuildInfo = JSON.parse(await readFile(join(bridgeDistDir, 'build-info.json'), 'utf8'));
const expectedBridgeBuildId = bridgeBuildInfo.buildId;
const expectedBridgeCapabilities = [...bridgeModule.BRIDGE_CAPABILITIES].sort();
const EXPECTED_READONLY = [
  ...directModule.COCOS_DIRECT_READONLY_TOOL_NAMES,
  ...runtimeModule.COCOS_RUNTIME_READONLY_TOOL_NAMES
];
const EXPECTED_WRITE = [
  ...directModule.COCOS_DIRECT_WRITE_TOOL_NAMES,
  ...runtimeModule.COCOS_RUNTIME_GATED_TOOL_NAMES
];

const timeoutMs = Number(process.env.COCOS_AI_CHECK_TIMEOUT_MS ?? 15_000);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, ...(enableWrites ? ['--enable-writes'] : [])],
  env: {
    ...process.env,
    COCOS_AI_PROBE_SERVER_URL: process.env.COCOS_AI_PROBE_SERVER_URL ?? 'ws://127.0.0.1:32188'
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
  const expectedNames = [...EXPECTED_READONLY, ...(enableWrites ? EXPECTED_WRITE : [])];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`MCP_TOOL_SET_MISMATCH:${JSON.stringify({ expectedNames, names })}`);
  }
  const editorResult = await withTimeout(
    client.callTool({ name: 'cocos_editor_list', arguments: {} }),
    'COCOS_EDITOR_LIST'
  );
  if (editorResult.isError) throw new Error(`COCOS_EDITOR_LIST_FAILED:${JSON.stringify(editorResult.content)}`);
  const editors = Array.isArray(editorResult.structuredContent?.editors)
    ? editorResult.structuredContent.editors
    : [];
  if (editors.length === 0) throw new Error('COCOS_EDITOR_NOT_CONNECTED');
  const bridgeVersions = [...new Set(editors.map((editor) => editor.bridgeVersion))];
  if (bridgeVersions.some((version) => version !== TOOLKIT_VERSION)) {
    throw new Error(`BRIDGE_VERSION_MISMATCH:${JSON.stringify({
      expected: TOOLKIT_VERSION,
      actual: bridgeVersions
    })}`);
  }
  const bridgeBuildIds = [...new Set(editors.map((editor) => editor.bridgeBuildId ?? null))];
  if (bridgeBuildIds.some((buildId) => buildId !== expectedBridgeBuildId)) {
    throw new Error(`BRIDGE_BUILD_ID_MISMATCH:${JSON.stringify({
      expected: expectedBridgeBuildId,
      actual: bridgeBuildIds
    })}`);
  }
  const capabilityMismatches = editors.flatMap((editor) => {
    const actual = [...editor.capabilities].sort();
    return JSON.stringify(actual) === JSON.stringify(expectedBridgeCapabilities)
      ? []
      : [{ editorInstanceId: editor.editorInstanceId, expected: expectedBridgeCapabilities, actual }];
  });
  if (capabilityMismatches.length) {
    throw new Error(`BRIDGE_CAPABILITIES_MISMATCH:${JSON.stringify(capabilityMismatches)}`);
  }
  const expectedBridgeRoot = resolve(bridgeDistDir, '..');
  for (const editor of editors) {
    const installedBridgeRoot = await realpath(join(editor.projectPath, 'extensions', 'cocos-ai-bridge'));
    if (resolve(installedBridgeRoot).toLowerCase() !== expectedBridgeRoot.toLowerCase()) {
      throw new Error(`BRIDGE_RUNTIME_MISMATCH:${JSON.stringify({
        editorInstanceId: editor.editorInstanceId,
        expected: expectedBridgeRoot,
        actual: installedBridgeRoot
      })}`);
    }
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    toolkitVersion: TOOLKIT_VERSION,
    sourceCommit,
    serverVersion: client.getServerVersion(),
    bridgeVersions,
    bridgeBuildIds,
    writeEnabled: enableWrites,
    toolCount: names.length,
    editors: editorResult.structuredContent ?? null
  }) + '\n');
} finally {
  await client.close().catch(() => undefined);
}
