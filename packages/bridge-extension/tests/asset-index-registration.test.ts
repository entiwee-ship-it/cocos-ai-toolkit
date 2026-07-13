import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRIDGE_CAPABILITIES } from '../src/editor-state';

describe('asset index registration', () => {
  it('同时登记 Bridge 能力、WebSocket handler 和 Creator 消息入口', () => {
    const packageJson = JSON.parse(readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8'
    )) as {
      contributions?: {
        messages?: Record<string, { methods?: string[] }>;
      };
    };
    const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

    expect(BRIDGE_CAPABILITIES).toContain('probe.assetIndex');
    expect(mainSource).toContain("'probe.assetIndex': () => probeAssetIndex()");
    expect(mainSource).toContain("'probe-asset-index': () => probeAssetIndex()");
    expect(packageJson.contributions?.messages?.['probe-asset-index']).toEqual({
      methods: ['probe-asset-index']
    });
  });
});
