import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import contributions, { resetSimulatorRuntimeServer } from '../src/simulator-runtime-server.js';

type Handler = (request: Record<string, any>, response: MockResponse, next: () => void) => void | Promise<void>;

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  ended = false;
  sentFile = '';

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(value: unknown): void {
    this.body = value;
    this.ended = true;
  }

  end(value?: string): void {
    this.body = value;
    this.ended = true;
  }

  sendFile(path: string): void {
    this.sentFile = path;
    this.ended = true;
  }
}

const staticHandler = contributions[0].handle as Handler;
const runtimeHandler = contributions[1].handle as Handler;
const loopback = { remoteAddress: '127.0.0.1' };

beforeEach(resetSimulatorRuntimeServer);

describe('simulator runtime preview server', () => {
  it('只提供固定运行代理文件', () => {
    const response = new MockResponse();
    let next = 0;
    staticHandler({ path: '/plugins/cocos-ai/runtime-agent.js' }, response, () => { next += 1; });
    expect(response.sentFile.replace(/\\/g, '/')).toMatch(/bridge-extension\/static\/runtime-agent\.js$/);
    expect(next).toBe(0);
  });

  it('在同一 runtimeId 上完成 evaluate 命令往返', async () => {
    await runtimeHandler({ method: 'GET', url: '/cocos-ai/runtime/command?runtimeId=sim-1', socket: loopback }, new MockResponse(), () => {});

    const evaluation = new MockResponse();
    await runtimeHandler({
      method: 'POST',
      path: '/cocos-ai/runtime/evaluate',
      body: { runtimeId: 'sim-1', expression: '1 + 1' },
      socket: loopback
    }, evaluation, () => {});
    expect(evaluation.ended).toBe(false);

    const command = new MockResponse();
    await runtimeHandler({ method: 'GET', url: '/cocos-ai/runtime/command?runtimeId=sim-1', socket: loopback }, command, () => {});
    expect(command.body).toMatchObject({ runtimeId: 'sim-1', expression: '1 + 1' });
    const id = (command.body as { id: string }).id;

    const receipt = new MockResponse();
    await runtimeHandler({
      method: 'POST',
      path: '/cocos-ai/runtime/result',
      body: { id, runtimeId: 'sim-1', ok: true, value: 2 },
      socket: loopback
    }, receipt, () => {});
    expect(receipt.statusCode).toBe(204);
    expect(evaluation.body).toEqual({ ok: true, value: 2 });
  });

  it('拒绝非回环地址发起运行时命令', async () => {
    const response = new MockResponse();
    await runtimeHandler({ method: 'GET', path: '/cocos-ai/runtime/status', socket: { remoteAddress: '192.168.1.50' } }, response, () => {});
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'LOOPBACK_REQUIRED' });
  });
});

