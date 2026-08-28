import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAssetIndex } from '../src/asset-index';
import { BRIDGE_CAPABILITIES } from '../src/bridge-state';

const originalEditorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Editor');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEditorDescriptor) {
    Object.defineProperty(globalThis, 'Editor', originalEditorDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, 'Editor');
});

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
    expect(BRIDGE_CAPABILITIES).toContain('probe.assetSearch');
    expect(mainSource).toContain("'probe.assetIndex': (payload) => probeAssetIndex(payload)");
    expect(mainSource).toContain("'probe.assetSearch': (payload) => probeAssetSearch(payload)");
    expect(mainSource).toContain("'probe-asset-index': (request) => probeAssetIndex(request)");
    expect(mainSource).toContain('operation.finally(invalidateAssetIndexCache)');
    expect(mainSource).not.toContain('cachedScriptPathsByUuid');
    expect(packageJson.contributions?.messages?.['probe-asset-index']).toEqual({
      methods: ['probe-asset-index']
    });
  });

  it('AssetDB 返回非数组时生成空索引而不是中断 Bridge', async () => {
    const requestEditorMessage = vi.fn(async () => ({ unexpected: true }));
    Object.defineProperty(globalThis, 'Editor', {
      configurable: true,
      value: { Message: { request: requestEditorMessage } }
    });

    await expect(probeAssetIndex()).resolves.toEqual({
      assets: [],
      scripts: [],
      documents: [],
      unresolved: []
    });
    expect(requestEditorMessage).toHaveBeenCalledWith(
      'asset-db',
      'query-assets',
      undefined,
      expect.any(Array)
    );
  });
});
