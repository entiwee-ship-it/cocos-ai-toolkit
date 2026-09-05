import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface ToolCatalogEntry {
  name: string;
  group: string;
  writeRequired: boolean;
  destructive?: boolean;
  summary: string;
}

const catalogPath = new URL('../tool-catalog.json', import.meta.url);
const directToolsPath = new URL('../../mcp-server/src/direct-tools.ts', import.meta.url);
const runtimeToolsPath = new URL('../../mcp-server/src/runtime-tools.ts', import.meta.url);

describe('工具管理窗口清单', () => {
  it('与 MCP 当前实际注册工具及写入门控保持一致', async () => {
    const [catalogText, directSource, runtimeSource] = await Promise.all([
      readFile(catalogPath, 'utf8'),
      readFile(directToolsPath, 'utf8'),
      readFile(runtimeToolsPath, 'utf8')
    ]);
    const catalog = JSON.parse(catalogText) as ToolCatalogEntry[];
    const registeredNames = [directSource, runtimeSource].flatMap((source) =>
      [...source.matchAll(/server\.registerTool\('([^']+)'/g)].map((match) => match[1])
    );
    const writeRequiredNames = [
      ...readNameArray(directSource, 'COCOS_DIRECT_WRITE_TOOL_NAMES'),
      ...readNameArray(runtimeSource, 'COCOS_RUNTIME_GATED_TOOL_NAMES')
    ];

    expect(catalog.map((tool) => tool.name)).toEqual(registeredNames);
    expect(catalog.filter((tool) => tool.writeRequired).map((tool) => tool.name)).toEqual(writeRequiredNames);
    expect(new Set(catalog.map((tool) => tool.name)).size).toBe(catalog.length);
    expect(catalog.every((tool) => tool.group && tool.summary)).toBe(true);
  });

  it('面板包含状态和工具两个切换页', async () => {
    const panelSource = await readFile(new URL('../src/panels/default/index.ts', import.meta.url), 'utf8');
    expect(panelSource).toContain('id="statusTab"');
    expect(panelSource).toContain('id="toolsTab"');
    expect(panelSource).toContain('renderTools(tools.items, tools.version)');
  });
});

function readNameArray(source: string, exportName: string): string[] {
  const match = source.match(new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) throw new Error(`TOOL_NAME_ARRAY_NOT_FOUND:${exportName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}
