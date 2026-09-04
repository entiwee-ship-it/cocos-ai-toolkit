import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('bridge extension manifest', () => {
  it('主进程和 Scene 进程都使用稳定 dist 构建入口', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      main?: string;
      contributions?: {
        scene?: { script?: string };
        messages?: Record<string, unknown>;
      };
    };

    expect(manifest.main).toBe('./dist/main.js');
    expect(manifest.contributions?.scene?.script).toBe('./dist/scene.js');
    expect(Object.keys(manifest.contributions?.messages ?? {}).sort()).toEqual([
      'probe-asset-index',
      'probe-assets',
      'probe-component',
      'probe-editor-state',
      'probe-hierarchy',
      'probe-node',
      'probe-prefab'
    ]);
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
      date: '2026-09-01',
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
    expect(zhI18n).toContain('面向 Cocos Creator 3.8.x');
    expect(enI18n).toContain('Cocos AI editor bridge for Cocos Creator 3.8.x');
  });
});
