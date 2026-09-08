import { afterEach, describe, expect, it, vi } from 'vitest';
import { onSettingsSimulator } from '../src/simulator-runtime-preview.js';

afterEach(() => vi.unstubAllGlobals());

describe('simulator runtime preview hook', () => {
  it('只向第三项模拟器设置追加一次运行代理和本机回环地址', async () => {
    vi.stubGlobal('Editor', {
      Message: { request: vi.fn(async () => 7456) }
    });
    const settings = { plugins: { jsList: ['assets/existing.js'] } };

    await onSettingsSimulator(settings);
    await onSettingsSimulator(settings);

    expect(settings.plugins).toEqual({
      jsList: ['assets/existing.js', 'cocos-ai/runtime-agent.js'],
      cocosAiRuntime: {
        baseUrl: 'http://127.0.0.1:7456/cocos-ai/runtime',
        pollIntervalMs: 50
      }
    });
  });
});

