import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('bridge extension manifest', () => {
  it('注册主进程、Scene 进程、独立工具管理窗口和最外层主菜单', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      main?: string;
      panels?: Record<string, Record<string, unknown>>;
      contributions?: {
        scene?: { script?: string };
        menu?: Array<Record<string, unknown>>;
        messages?: Record<string, { methods?: string[] }>;
      };
    };

    expect(manifest.main).toBe('./dist/main.js');
    expect(manifest.contributions?.scene?.script).toBe('./dist/scene.js');
    expect(manifest.panels?.default).toMatchObject({
      title: 'i18n:cocos-ai-bridge.panel_title',
      type: 'simple',
      main: './dist/panels/default'
    });
    expect(manifest.contributions?.menu).toContainEqual(expect.objectContaining({
      path: 'Cocos AI',
      label: 'i18n:cocos-ai-bridge.open_panel',
      message: 'open-panel'
    }));
    expect(manifest.contributions?.messages?.['open-panel']?.methods).toEqual(['openPanel']);
    expect(manifest.contributions?.messages?.['manager-state']?.methods).toEqual(['queryManagerState']);
    expect(manifest.contributions?.messages?.['open-extension-manager']?.methods).toEqual([
      'openExtensionManager'
    ]);

    const panelSource = readFileSync(
      new URL('../src/panels/default/index.ts', import.meta.url),
      'utf8'
    );
    expect(panelSource).toContain('Editor.Panel.define');
    expect(panelSource).toContain("Editor.Message.request('cocos-ai-bridge', 'manager-state')");
    expect(panelSource).toContain('发布日期');
    expect(panelSource).toContain('overflow: auto');
  });

  it('为 Creator 本地扩展管理器提供双语摘要和详情元数据', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      version: string;
      description: string;
      author: string;
      date: string;
      platform: string[];
      editor: string;
    };
    const zhDetail = readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8');
    const enDetail = readFileSync(new URL('../README.en.md', import.meta.url), 'utf8');
    const zhI18n = readFileSync(new URL('../i18n/zh.js', import.meta.url), 'utf8');
    const enI18n = readFileSync(new URL('../i18n/en.js', import.meta.url), 'utf8');

    expect(manifest).toMatchObject({
      description: 'i18n:cocos-ai-bridge.description',
      author: 'Enti',
      date: '2026-09-04',
      platform: ['win32'],
      editor: '>=3.8.0 <3.9.0'
    });
    for (const detail of [zhDetail, enDetail]) {
      expect(detail).toContain(`V${manifest.version}`);
      expect(detail).toContain(manifest.date);
      expect(detail).toContain(manifest.author);
      expect(detail).toContain(manifest.editor);
      expect(detail).toContain('win32');
    }
    expect(zhI18n).toContain('Cocos AI 工具管理');
    expect(enI18n).toContain('Cocos AI Tool Manager');
  });
});
