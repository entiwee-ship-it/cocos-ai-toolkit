import { afterEach, describe, expect, it, vi } from 'vitest';
import { onSettingsSimulator } from '../src/simulator-runtime-preview.js';

afterEach(() => vi.unstubAllGlobals());

describe('simulator runtime preview hook', () => {
  it('运行代理置于其它插件之前且仅加载一次，使用本机回环地址', async () => {
    vi.stubGlobal('Editor', {
      Message: { request: vi.fn(async () => 7456) }
    });
    const settings = { plugins: { jsList: ['assets/existing.js'] } };

    await onSettingsSimulator(settings);
    await onSettingsSimulator(settings);

    expect(settings.plugins).toEqual({
      jsList: ['cocos-ai/runtime-agent.js', 'assets/existing.js'],
      cocosAiRuntime: {
        baseUrl: 'http://127.0.0.1:7456/cocos-ai/runtime',
        pollIntervalMs: 50
      }
    });
  });
});
