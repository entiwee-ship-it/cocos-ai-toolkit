import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadonlyProbeClient } from '@cocos-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COCOS_GATED_READONLY_TOOL_NAMES,
  COCOS_READONLY_TOOL_NAMES,
  COCOS_WRITE_TOOL_NAMES,
  createCocosMcpServer
} from '../src/server.js';

const PREFAB_READONLY_TOOLS = [
  'cocos_editor_list',
  'cocos_prefab_search',
  'cocos_prefab_inspect',
  'cocos_prefab_verify'
];

const PREFAB_WRITE_TOOLS = [
  'cocos_prefab_create',
  'cocos_prefab_edit',
  'cocos_prefab_delete',
  'cocos_asset_create',
  'cocos_asset_move',
  'cocos_asset_write_meta',
  'cocos_asset_update_text',
  'cocos_asset_delete'
];

const harnesses: Array<{ server: McpServer; client: Client }> = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ server, client }) => {
    await client.close();
    await server.close();
  }));
});

describe('Cocos MCP tool profile', () => {
  it('默认 prefab 只读档只暴露四个高层工具', async () => {
    const names = await listTools({});
    expect(names).toEqual(PREFAB_READONLY_TOOLS);
  });

  it('prefab 写入档暴露 Prefab 与通用 AssetDB 高层工具', async () => {
    const tools = await listToolDefinitions({ enableWrites: true });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([...PREFAB_READONLY_TOOLS, ...PREFAB_WRITE_TOOLS]);
    expect(new Map(tools.map((tool) => [tool.name, tool.inputSchema.required ?? []]))).toEqual(new Map([
      ['cocos_editor_list', []],
      ['cocos_prefab_search', ['projectId', 'pattern']],
      ['cocos_prefab_inspect', ['projectId', 'uuid']],
      ['cocos_prefab_verify', ['projectId', 'uuid', 'tree']],
      ['cocos_prefab_create', ['projectId', 'assetUrl', 'tree', 'rootId', 'mode']],
      ['cocos_prefab_edit', ['projectId', 'uuid', 'tree', 'mode']],
      ['cocos_prefab_delete', ['projectId', 'uuid', 'mode']],
      ['cocos_asset_create', ['projectId', 'assetUrl', 'assetKind', 'mode']],
      ['cocos_asset_move', ['projectId', 'uuid', 'targetUrl', 'mode']],
      ['cocos_asset_write_meta', ['projectId', 'uuid', 'meta', 'mode']],
      ['cocos_asset_update_text', ['projectId', 'uuid', 'oldText', 'newText', 'mode']],
      ['cocos_asset_delete', ['projectId', 'uuid', 'mode']]
    ]));
    expect(tools.filter((tool) => PREFAB_READONLY_TOOLS.includes(tool.name))
      .every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.filter((tool) => ['cocos_prefab_create', 'cocos_prefab_edit'].includes(tool.name))
      .every((tool) => tool.annotations?.readOnlyHint === false && tool.annotations?.destructiveHint === false)).toBe(true);
    expect(tools.find((tool) => tool.name === 'cocos_prefab_delete')?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((tool) => tool.name === 'cocos_prefab_edit')?.inputSchema.properties)
      .toHaveProperty('operations');
  });

  it('full 写入档保留底层工具并追加通用 AssetDB 高层工具', async () => {
    const names = await listTools({ enableWrites: true, profile: 'full' });
    expect(names).toEqual([
      ...COCOS_READONLY_TOOL_NAMES,
      ...COCOS_WRITE_TOOL_NAMES,
      ...COCOS_GATED_READONLY_TOOL_NAMES
    ]);
    expect(names).toHaveLength(38);
    expect(names).not.toContain('cocos_prefab_search');
  });
});

async function listTools(runtime: { enableWrites?: boolean; profile?: 'prefab' | 'full' }) {
  return (await listToolDefinitions(runtime)).map((tool) => tool.name);
}

async function listToolDefinitions(runtime: { enableWrites?: boolean; profile?: 'prefab' | 'full' }) {
  const probeClient: ReadonlyProbeClient = {
    async request() {
      return [];
    }
  };
  const server = createCocosMcpServer(
    { probeClient, reportRoot: 'reports' },
    runtime as Parameters<typeof createCocosMcpServer>[1]
  );
  const client = new Client({ name: 'profile-test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  harnesses.push({ server, client });
  return (await client.listTools()).tools;
}
