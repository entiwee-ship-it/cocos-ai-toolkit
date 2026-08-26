import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  createProbeServerBootstrap,
  isProbeServerReachable,
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

  it('只有完成 Probe client.hello 握手才判定服务可达', async () => {
    const tcp = createServer();
    const tcpSockets = new Set<Socket>();
    tcp.on('connection', (socket) => {
      tcpSockets.add(socket);
      socket.once('close', () => tcpSockets.delete(socket));
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const tcpPort = (tcp.address() as AddressInfo).port;
    await expect(isProbeServerReachable(`ws://127.0.0.1:${tcpPort}`)).resolves.toBe(false);
    for (const socket of tcpSockets) socket.destroy();
    await new Promise<void>((resolve, reject) => tcp.close((error) => error ? reject(error) : resolve()));

    const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => websocket.once('listening', resolve));
    websocket.on('connection', (socket) => {
      socket.once('message', () => {
        socket.send(JSON.stringify({ type: 'response', correlationId: 'client.hello', ok: true, payload: {} }));
      });
    });
    const wsPort = (websocket.address() as AddressInfo).port;
    await expect(isProbeServerReachable(`ws://127.0.0.1:${wsPort}`)).resolves.toBe(true);
    for (const client of websocket.clients) client.terminate();
    await new Promise<void>((resolve, reject) => websocket.close((error) => error ? reject(error) : resolve()));
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
