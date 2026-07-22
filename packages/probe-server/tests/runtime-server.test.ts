import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RuntimeDriver, type RuntimeBrowser, type RuntimeBrowserPage } from '@cocos-ai/core';
import { ProbeServer } from '../src/server.js';

/** 构造一个注册即应答 probe.previewOpen 的假 Bridge。 */
async function connectFakeBridge(options: {
  url: string;
  editorInstanceId?: string;
  projectId?: string;
  previewOpenReply?: { ok: boolean; payload: unknown };
}) {
  const socket = new WebSocket(options.url);
  const editorInstanceId = options.editorInstanceId ?? 'editor-1';
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        method: 'bridge.hello',
        payload: {
          editorInstanceId,
          projectId: options.projectId ?? 'project-1',
          projectPath: 'E:/project',
          creatorVersion: '3.8.8',
          bridgeVersion: '0.1.27',
          capabilities: ['probe.previewOpen']
        }
      }));
    });
    socket.once('message', () => resolve());
    socket.once('error', reject);
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as { type?: string; requestId?: string; method?: string };
    if (message.type !== 'request' || !message.requestId) return;
    const reply = options.previewOpenReply ?? { ok: true, payload: { url: 'http://192.168.1.23:7457/' } };
    socket.send(JSON.stringify({
      type: 'response',
      correlationId: message.requestId,
      ok: reply.ok,
      payload: reply.payload
    }));
  });
  return socket;
}

/** 构造假浏览器页面（console 可编排触发）。 */
function createFakePage() {
  const state = {
    gotoUrls: [] as string[],
    closed: false,
    consoleListeners: [] as Array<(entry: { level: string; text: string; stack?: string }) => void>,
    pageErrorListeners: [] as Array<(error: { message: string; stack?: string }) => void>
  };
  const page: RuntimeBrowserPage = {
    async goto(url: string) {
      state.gotoUrls.push(url);
    },
    async evaluate() {
      return { ready: true, sceneName: 'main', childCount: 1, width: 960, height: 640 } as never;
    },
    onConsole(listener) {
      state.consoleListeners.push(listener);
    },
    onPageError(listener) {
      state.pageErrorListeners.push(listener);
    },
    async close() {
      state.closed = true;
    },
    isClosed() {
      return state.closed;
    }
  };
  return { page, state };
}

function createFakeDriver() {
  const pages: Array<ReturnType<typeof createFakePage>> = [];
  const driver = new RuntimeDriver({
    launcher: async () => {
      const fake = createFakePage();
      pages.push(fake);
      const browser: RuntimeBrowser = {
        async newPage() {
          return fake.page;
        },
        async close() {
          fake.state.closed = true;
        }
      };
      return browser;
    }
  });
  return { driver, pages };
}

/** 发送 client 请求并等待响应。 */
async function callServer(url: string, method: string, payload: unknown): Promise<{ ok: boolean; payload: unknown }> {
  const socket = new WebSocket(url);
  try {
    return await new Promise<{ ok: boolean; payload: unknown }>((resolve, reject) => {
      socket.once('open', () => {
        socket.send(JSON.stringify({ method: 'client.hello', payload: { clientName: 'runtime-test' } }));
      });
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { correlationId?: string; ok?: boolean; payload?: unknown };
        if (message.correlationId === 'client.hello') {
          socket.send(JSON.stringify({ type: 'request', requestId: 'runtime-req', method, payload }));
          return;
        }
        if (message.correlationId === 'runtime-req') {
          resolve({ ok: message.ok === true, payload: message.payload });
        }
      });
      socket.once('error', reject);
    });
  } finally {
    socket.close();
  }
}

describe('ProbeServer 运行态方法', () => {
  it('previewLaunch 经 Bridge 打开 preview server 后自 launch 浏览器并返回就绪会话', async () => {
    const { driver, pages } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const reply = await callServer(url, 'server.previewLaunch', {
      selector: { projectId: 'project-1' },
      params: { resolution: { width: 720, height: 1280 } }
    });

    expect(reply.ok).toBe(true);
    const session = reply.payload as { state: string; url: string; pageSource: string; actualResolution?: { width: number; height: number } };
    expect(session.state).toBe('ready');
    expect(session.url).toBe('http://127.0.0.1:7457/');
    expect(session.pageSource).toBe('self-launched');
    expect(session.actualResolution).toEqual({ width: 960, height: 640 });
    expect(pages[0].state.gotoUrls).toEqual(['http://127.0.0.1:7457/']);

    bridge.close();
    await server.stop();
  });

  it('previewOpen 失败时 launch 失败并透传错误', async () => {
    const { driver } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({
      url,
      previewOpenReply: { ok: false, payload: { code: 'PREVIEW_OPEN_FAILED' } }
    });

    const reply = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply.payload)).toContain('PREVIEW_OPEN_FAILED');

    bridge.close();
    await server.stop();
  });

  it('previewSessions / previewSession / previewStop 走完会话生命周期', async () => {
    const { driver, pages } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const listed = await callServer(url, 'server.previewSessions', { projectId: 'project-1' });
    expect((listed.payload as Array<{ sessionId: string }>).map((item) => item.sessionId)).toEqual([sessionId]);

    const fetched = await callServer(url, 'server.previewSession', { sessionId });
    expect((fetched.payload as { state: string }).state).toBe('ready');

    const stopped = await callServer(url, 'server.previewStop', { sessionId });
    expect(stopped.ok).toBe(true);
    expect(pages[0].state.closed).toBe(true);
    expect((await callServer(url, 'server.previewSession', { sessionId })).payload).toMatchObject({ state: 'closed' });

    bridge.close();
    await server.stop();
  });

  it('runtimeConsole 返回缓冲条目并支持游标', async () => {
    const { driver, pages } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;
    pages[0].state.consoleListeners[0]({ level: 'log', text: 'hello' });
    pages[0].state.consoleListeners[0]({ level: 'error', text: 'boom' });

    const first = await callServer(url, 'server.runtimeConsole', { sessionId });
    const firstPayload = first.payload as { entries: Array<{ text: string; level: string }>; nextSeq: number };
    expect(firstPayload.entries.map((entry) => entry.text)).toEqual(['hello', 'boom']);

    const incremental = await callServer(url, 'server.runtimeConsole', { sessionId, sinceSeq: firstPayload.nextSeq });
    expect((incremental.payload as { entries: unknown[] }).entries).toEqual([]);

    const errorsOnly = await callServer(url, 'server.runtimeConsole', { sessionId, level: 'error' });
    expect((errorsOnly.payload as { entries: Array<{ text: string }> }).entries.map((entry) => entry.text)).toEqual(['boom']);

    bridge.close();
    await server.stop();
  });

  it('未装配 runtime driver 时运行态方法返回明确错误', async () => {
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 1_000 });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;

    const reply = await callServer(url, 'server.previewSessions', {});
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply.payload)).toContain('RUNTIME_DRIVER_UNAVAILABLE');

    await server.stop();
  });
});
