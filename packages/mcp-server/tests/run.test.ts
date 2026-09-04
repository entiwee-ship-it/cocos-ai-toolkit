import { describe, expect, it } from 'vitest';
import { readMcpRuntimeConfig, startMcpRuntime } from '../src/run.js';

describe('Cocos MCP stdio runtime', () => {
  it('先连接 MCP Transport，再初始化 Creator Client，并且关闭操作幂等', async () => {
    const events: string[] = [];
    const creatorClient = {
      async connect() { events.push('creator.connect'); },
      async close() { events.push('creator.close'); }
    };
    const server = {
      async connect(transport: { name: string }) { events.push(`server.connect:${transport.name}`); },
      async close() { events.push('server.close'); }
    };
    const runtime = await startMcpRuntime({ creatorClient, server, transport: { name: 'stdio' } });
    await Promise.all([runtime.close(), runtime.close()]);
    expect(events).toEqual([
      'server.connect:stdio',
      'creator.connect',
      'server.close',
      'creator.close'
    ]);
  });

  it('MCP Transport 连接失败时仍关闭 Server 和 Creator Client', async () => {
    const events: string[] = [];
    const creatorClient = {
      async connect() { events.push('creator.connect'); },
      async close() { events.push('creator.close'); }
    };
    const server = {
      async connect() {
        events.push('server.connect');
        throw new Error('STDIO_CONNECT_FAILED');
      },
      async close() { events.push('server.close'); }
    };
    await expect(startMcpRuntime({
      creatorClient,
      server,
      transport: { name: 'stdio' }
    })).rejects.toThrow('STDIO_CONNECT_FAILED');
    expect(events).toEqual(['server.connect', 'server.close', 'creator.close']);
  });

  it('读取 Named Pipe 运行配置，不再接受 Probe 地址', () => {
    expect(readMcpRuntimeConfig({
      COCOS_AI_ENDPOINT_ROOT: 'C:/ipc/endpoints',
      COCOS_AI_CAPTURE_ROOT: 'C:/captures',
      COCOS_AI_SESSION_TOKEN: 'secret-token'
    })).toEqual({
      endpointRoot: 'C:/ipc/endpoints',
      captureRoot: 'C:/captures',
      enableWrites: false,
      requestTimeoutMs: 180_000,
      sessionToken: 'secret-token'
    });
    expect(readMcpRuntimeConfig({})).toEqual({
      endpointRoot: undefined,
      captureRoot: undefined,
      enableWrites: false,
      requestTimeoutMs: 180_000,
      sessionToken: undefined
    });
  });

  it('仅接受正整数 IPC 超时，非法值回退默认值', () => {
    expect(readMcpRuntimeConfig({ COCOS_AI_IPC_TIMEOUT_MS: '120000' }).requestTimeoutMs).toBe(120_000);
    for (const value of ['0', '-1', '1.5', 'not-a-number']) {
      expect(readMcpRuntimeConfig({ COCOS_AI_IPC_TIMEOUT_MS: value }).requestTimeoutMs).toBe(180_000);
    }
  });

  it('写工具只能通过 --enable-writes 显式开启', () => {
    expect(readMcpRuntimeConfig({}, ['--enable-writes']).enableWrites).toBe(true);
    expect(readMcpRuntimeConfig({ COCOS_AI_MCP_ENABLE_WRITES: 'true' }, []).enableWrites).toBe(false);
    expect(() => readMcpRuntimeConfig({}, ['--unknown'])).toThrow('MCP_ARGUMENT_INVALID');
  });
});
