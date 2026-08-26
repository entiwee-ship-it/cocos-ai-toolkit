import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createProbeServerBootstrap,
  resolveProbeRuntimePaths,
  type ProbeServerBootstrapDependencies
} from '../src/probe-bootstrap';

describe('Probe Server bootstrap', () => {
  it('服务已存在时不重复启动', async () => {
    const dependencies = createDependencies({ reachable: true });
    const bootstrap = createProbeServerBootstrap(config(), dependencies);

    await expect(bootstrap.ensureRunning()).resolves.toBe('already-running');
    expect(dependencies.startCount()).toBe(0);
  });

  it('服务不存在时启动一次并等待可达，并发调用共享同一启动过程', async () => {
    const dependencies = createDependencies({ reachable: false, reachableAfterStart: true });
    const bootstrap = createProbeServerBootstrap(config(), dependencies);

    await expect(Promise.all([
      bootstrap.ensureRunning(),
      bootstrap.ensureRunning()
    ])).resolves.toEqual(['started', 'started']);
    expect(dependencies.startCount()).toBe(1);
  });

  it('非 loopback Probe URL 不启动本地进程', async () => {
    const dependencies = createDependencies({ reachable: false });
    const bootstrap = createProbeServerBootstrap(config({ url: 'ws://192.168.1.20:32188' }), dependencies);

    await expect(bootstrap.ensureRunning()).resolves.toBe('unsupported-url');
    expect(dependencies.startCount()).toBe(0);
  });

  it('启动后超时仍不可达时返回明确错误', async () => {
    const dependencies = createDependencies({ reachable: false, reachableAfterStart: false });
    const bootstrap = createProbeServerBootstrap(config({ startupTimeoutMs: 20, pollIntervalMs: 5 }), dependencies);

    await expect(bootstrap.ensureRunning()).rejects.toThrow('PROBE_AUTO_START_TIMEOUT');
    expect(dependencies.startCount()).toBe(1);
  });

  it('从 Bridge dist 目录解析同一 Toolkit 的 Probe 和报告路径', () => {
    expect(resolveProbeRuntimePaths('E:/toolkit/packages/bridge-extension/dist')).toEqual({
      toolkitRoot: 'E:\\toolkit',
      probeEntry: 'E:\\toolkit\\packages\\probe-server\\dist\\run.js',
      reportRoot: 'E:\\toolkit\\reports'
    });
  });

  it('Bridge 加载前自检，断线后再次触发自恢复', async () => {
    const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

    expect(main).toContain('bridgeDistDirectory: __dirname');
    expect(main).toContain("event.type === 'disconnected'");
    expect(main).toContain('bridgeClient.connect()');
    expect(main).toContain('void ensureProbeServer(bootstrap)');
  });
});

function config(overrides: Partial<Parameters<typeof createProbeServerBootstrap>[0]> = {}) {
  return {
    url: 'ws://127.0.0.1:32188',
    bridgeDistDirectory: 'E:/toolkit/packages/bridge-extension/dist',
    startupTimeoutMs: 100,
    pollIntervalMs: 5,
    ...overrides
  };
}

function createDependencies(options: {
  reachable: boolean;
  reachableAfterStart?: boolean;
}): ProbeServerBootstrapDependencies & { startCount(): number } {
  let reachable = options.reachable;
  let starts = 0;
  let now = 0;
  return {
    isReachable: async () => reachable,
    startProbe: async () => {
      starts += 1;
      reachable = options.reachableAfterStart === true;
    },
    sleep: async (delayMs) => {
      now += delayMs;
    },
    now: () => now,
    startCount: () => starts
  };
}
