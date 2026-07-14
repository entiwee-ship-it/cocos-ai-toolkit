import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRIDGE_CAPABILITIES } from '../src/editor-state';

describe('document snapshot registration', () => {
  it('登记 Bridge、Creator 消息和 Scene 扫描入口，并注入脚本 UUID 路径映射', () => {
    const packageJson = JSON.parse(readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8'
    )) as {
      contributions?: {
        messages?: Record<string, { methods?: string[] }>;
      };
    };
    const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const sceneSource = readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');

    expect(BRIDGE_CAPABILITIES).toContain('probe.documentSnapshot');
    expect(mainSource).toContain("'probe.documentSnapshot': (payload) => probeDocumentSnapshot(payload)");
    expect(mainSource).toContain("'probe-document-snapshot': (request) => probeDocumentSnapshot(request)");
    expect(mainSource).toContain('scriptPathsByUuid');
    expect(sceneSource).toContain('scanCurrentDocument');
    expect(sceneSource).toContain('probeDocumentSnapshot');
    expect(packageJson.contributions?.messages?.['probe-document-snapshot']).toEqual({
      methods: ['probe-document-snapshot']
    });
  });
});
