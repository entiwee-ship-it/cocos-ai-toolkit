import { describe, expect, it } from 'vitest';
import {
  readMcpRuntimeConfig,
  startMcpRuntime
} from '../src/run.js';

describe('Cocos MCP stdio runtime', () => {
  it('先连接 MCP Transport，再后台连接 Probe Client，并且关闭操作幂等', async () => {
    const events: string[] = [];
    const probeClient = {
      async connect() {
        events.push('probe.connect');
      },
      async close() {
        events.push('probe.close');
      }
    };
    const server = {
      async connect(transport: { name: string }) {
        events.push(`server.connect:${transport.name}`);
      },
      async close() {
        events.push('server.close');
      }
    };

    const runtime = await startMcpRuntime({
      probeClient,
      server,
      transport: { name: 'stdio' }
    });
    await Promise.all([runtime.close(), runtime.close()]);

    expect(events).toEqual([
      'server.connect:stdio',
      'probe.connect',
      'server.close',
      'probe.close'
    ]);
  });

  it('MCP Transport 连接失败时关闭 Server 和 Probe Client', async () => {
    const events: string[] = [];
    const probeClient = {
      async connect() {
        events.push('probe.connect');
      },
      async close() {
        events.push('probe.close');
      }
    };
    const server = {
      async connect() {
        events.push('server.connect');
        throw new Error('STDIO_CONNECT_FAILED');
      },
      async close() {
        events.push('server.close');
      }
    };

    await expect(startMcpRuntime({
      probeClient,
      server,
      transport: { name: 'stdio' }
    })).rejects.toThrow('STDIO_CONNECT_FAILED');
    expect(events).toEqual([
      'server.connect',
      'server.close',
      'probe.close'
    ]);
  });

  it('Probe 长时间离线不阻塞 MCP stdio 初始化', async () => {
    let closeProbe = false;
    const runtime = await startMcpRuntime({
      probeClient: {
        connect: () => new Promise<void>(() => undefined),
        async close() { closeProbe = true; }
      },
      server: {
        async connect() {},
        async close() {}
      },
      transport: { name: 'stdio' }
    });

    await runtime.close();
    expect(closeProbe).toBe(true);
  });

  it('从环境变量读取 Probe 地址和会话 Token', () => {
    expect(readMcpRuntimeConfig({
      COCOS_AI_PROBE_SERVER_URL: 'ws://127.0.0.1:40000',
      COCOS_AI_SESSION_TOKEN: 'secret-token'
    })).toEqual({
      serverUrl: 'ws://127.0.0.1:40000',
      enableWrites: false,
      requestTimeoutMs: 180000,
      sessionToken: 'secret-token'
    });
    expect(readMcpRuntimeConfig({})).toEqual({
      serverUrl: 'ws://127.0.0.1:32188',
      enableWrites: false,
      requestTimeoutMs: 180000,
      sessionToken: undefined
    });
  });

  it('仅接受正整数 Probe 超时，非法值回退默认值', () => {
    expect(readMcpRuntimeConfig({ COCOS_AI_PROBE_TIMEOUT_MS: '120000' }).requestTimeoutMs).toBe(120000);
    for (const value of ['0', '-1', '1.5', 'not-a-number']) {
      expect(readMcpRuntimeConfig({ COCOS_AI_PROBE_TIMEOUT_MS: value }).requestTimeoutMs).toBe(180000);
    }
  });

  it('写工具仅当显式 --enable-writes 启动参数存在时开放', () => {
    expect(readMcpRuntimeConfig({}, ['--enable-writes']).enableWrites).toBe(true);
    expect(readMcpRuntimeConfig({}, []).enableWrites).toBe(false);
    expect(readMcpRuntimeConfig({ COCOS_AI_MCP_ENABLE_WRITES: 'true' }, []).enableWrites).toBe(false);
  });

  it('旧的 --profile 参数一律拒绝并提示已移除', () => {
    expect(() => readMcpRuntimeConfig({}, ['--profile=prefab'])).toThrow('MCP_PROFILE_REMOVED');
    expect(() => readMcpRuntimeConfig({}, ['--profile', 'full'])).toThrow('MCP_PROFILE_REMOVED');
  });
});
