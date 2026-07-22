import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import WebSocket from 'ws';
import { RuntimeDriver, type RuntimeBrowser, type RuntimeBrowserPage } from '@cocos-ai/core';
import { ProbeServer } from '../src/server.js';

/** 构造纯色 PNG。 */
function createSolidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    png.data[index * 4] = rgba[0];
    png.data[index * 4 + 1] = rgba[1];
    png.data[index * 4 + 2] = rgba[2];
    png.data[index * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

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

/** 构造假浏览器页面（console 可编排触发；evaluate 按脚本内容分支返回）。 */
function createFakePage() {
  const state = {
    gotoUrls: [] as string[],
    closed: false,
    propertyReads: 0,
    clicks: [] as Array<{ x: number; y: number }>,
    keys: [] as string[],
    viewport: null as null | { width: number; height: number },
    screenshots: 0,
    consoleListeners: [] as Array<(entry: { level: string; text: string; stack?: string }) => void>,
    pageErrorListeners: [] as Array<(error: { message: string; stack?: string }) => void>
  };
  const page: RuntimeBrowserPage = {
    async goto(url: string) {
      state.gotoUrls.push(url);
    },
    async evaluate(fn) {
      const script = typeof fn === 'string' ? fn : '';
      if (script.includes('return readRuntimeHierarchy')) {
        return {
          uuid: 'u1',
          name: 'Scene',
          active: true,
          dynamic: false,
          components: [{ type: 'cc.Scene' }],
          children: [{ uuid: 'u2', name: 'toast', active: true, dynamic: true, components: [], children: [] }],
          nodeCount: 2
        } as never;
      }
      if (script.includes('return readRuntimeComponent')) {
        return {
          found: true,
          nodeUuid: 'u2',
          componentType: 'cc.Label',
          properties: { string: '确定退出？', fontSize: 28 },
          skipped: ['onClick']
        } as never;
      }
      if (script.includes('return invokeRuntimeComponentMethod')) {
        return { found: true, invoked: true, nodeUuid: 'u2', componentType: 'GameLogic', returnValue: 6 } as never;
      }
      if (script.includes('return readRuntimeProperty')) {
        // scenario 断言用例：string 属性返回固定文本
        if (script.includes('"property":"string"')) {
          return { found: true, nodeUuid: 'u2', property: 'string', value: '确定退出？' } as never;
        }
        // watch 序列：前两次 1，之后 2（第二次轮询即变化）
        state.propertyReads = (state.propertyReads ?? 0) + 1;
        return { found: true, nodeUuid: 'u2', property: 'state.hp', value: state.propertyReads > 2 ? 2 : 1 } as never;
      }
      if (script.includes('return readCanvasRect')) {
        return { x: 100, y: 50, width: 960, height: 640 } as never;
      }
      if (script.includes('return readRuntimeNodeBounds')) {
        return {
          entries: [{ path: 'Canvas/btn', found: true, hasBounds: true, rect: { x: 1, y: 1, width: 10, height: 10 }, anchor: { x: 5, y: 5 } }]
        } as never;
      }
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
    },
    async mouseClick(x: number, y: number) {
      state.clicks.push({ x, y });
      // 点击副作用产生一条日志（scenario 的 dispatch-input → assert-console 链路验证）
      state.consoleListeners.forEach((listener) => listener({ level: 'log', text: '登录成功' }));
    },
    async keyPress(key: string) {
      state.keys.push(key);
    },
    async setViewportSize(size: { width: number; height: number }) {
      state.viewport = size;
    },
    async screenshotElement() {
      state.screenshots += 1;
      return createSolidPng(960, 640, [10, 10, 10, 255]);
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

  it('runtimeHierarchy 返回协议化快照（source/dynamic 标注齐全）', async () => {
    const { driver } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const reply = await callServer(url, 'server.runtimeHierarchy', { sessionId, maxDepth: 4 });
    expect(reply.ok).toBe(true);
    const snapshot = reply.payload as {
      source: string;
      previewSessionId: string;
      root: { name: string; children: Array<{ name: string; dynamic: boolean }> };
      nodeCount?: number;
    };
    expect(snapshot.source).toBe('preview-runtime');
    expect(snapshot.previewSessionId).toBe(sessionId);
    expect(snapshot.root.name).toBe('Scene');
    expect(snapshot.root.children[0]).toMatchObject({ name: 'toast', dynamic: true });
    expect(snapshot.nodeCount).toBe(2);

    bridge.close();
    await server.stop();
  });

  it('runtimeComponent 返回协议化组件快照并保留 skipped', async () => {
    const { driver } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const reply = await callServer(url, 'server.runtimeComponent', { sessionId, path: 'Scene/toast', componentType: 'cc.Label' });
    expect(reply.ok).toBe(true);
    const snapshot = reply.payload as {
      source: string;
      nodeUuid: string;
      properties: Record<string, unknown>;
      skipped?: string[];
    };
    expect(snapshot.source).toBe('preview-runtime');
    expect(snapshot.nodeUuid).toBe('u2');
    expect(snapshot.properties).toMatchObject({ string: '确定退出？', fontSize: 28 });
    expect(snapshot.skipped).toEqual(['onClick']);

    bridge.close();
    await server.stop();
  });

  it('runtimeInvoke 透传方法调用结果', async () => {
    const { driver } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const reply = await callServer(url, 'server.runtimeInvoke', {
      sessionId, path: 'Scene/panel', componentType: 'GameLogic', method: 'add', args: [2, 3]
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload).toMatchObject({ invoked: true, returnValue: 6 });

    bridge.close();
    await server.stop();
  });

  it('runtimeWatch 在属性变化时返回变化记录', async () => {
    const { driver } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const reply = await callServer(url, 'server.runtimeWatch', {
      sessionId, path: 'Scene/panel', componentType: 'GameLogic', property: 'state.hp',
      intervalMs: 1, timeoutMs: 5_000
    });
    expect(reply.ok).toBe(true);
    const result = reply.payload as { timedOut: boolean; initialValue: unknown; changes: Array<{ from: unknown; to: unknown }> };
    expect(result.timedOut).toBe(false);
    expect(result.initialValue).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ from: 1, to: 2 });

    bridge.close();
    await server.stop();
  });

  it('runtimeDispatchInput 按画布偏移派发点击并直接派发按键', async () => {
    const { driver, pages } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const tapReply = await callServer(url, 'server.runtimeDispatchInput', { sessionId, inputType: 'tap', x: 480, y: 320 });
    expect(tapReply.ok).toBe(true);
    expect(tapReply.payload).toMatchObject({ dispatched: true, pageX: 580, pageY: 370 });
    expect(pages[0].state.clicks).toEqual([{ x: 580, y: 370 }]);

    const keyReply = await callServer(url, 'server.runtimeDispatchInput', { sessionId, inputType: 'key', key: 'Escape' });
    expect(keyReply.ok).toBe(true);
    expect(pages[0].state.keys).toEqual(['Escape']);

    bridge.close();
    await server.stop();
  });

  it('runtimeCapture 截图落盘并返回协议化产物（单张与多分辨率）', async () => {
    const captureRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-captures-'));
    const { driver, pages } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver, captureRoot });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const single = await callServer(url, 'server.runtimeCapture', { sessionId });
    expect(single.ok).toBe(true);
    const singleResult = single.payload as { files: Array<{ path: string; width: number; height: number; cropped: boolean }> };
    expect(singleResult.files).toHaveLength(1);
    expect(singleResult.files[0]).toMatchObject({ width: 960, height: 640, cropped: false });
    const saved = await readFile(singleResult.files[0].path);
    expect(saved.subarray(1, 4).toString()).toBe('PNG');
    expect(singleResult.files[0].path).toContain(captureRoot);

    const multi = await callServer(url, 'server.runtimeCapture', {
      sessionId,
      resolutions: [{ width: 720, height: 1280 }, { width: 1280, height: 720 }]
    });
    const multiResult = multi.payload as { files: Array<{ requestedResolution?: { width: number }; actualResolution?: { width: number } }> };
    expect(multiResult.files).toHaveLength(2);
    expect(multiResult.files[0].requestedResolution).toEqual({ width: 720, height: 1280 });
    expect(pages[0].state.screenshots).toBe(3);
    expect(pages[0].state.viewport).toEqual({ width: 1480, height: 920 });

    const conflict = await callServer(url, 'server.runtimeCapture', {
      sessionId,
      resolution: { width: 720, height: 1280 },
      resolutions: [{ width: 1280, height: 720 }]
    });
    expect(conflict.ok).toBe(false);

    bridge.close();
    await server.stop();
  });

  it('runtimeRunScenario 全链路步骤编排并产出报告', async () => {
    const captureRoot = await mkdtemp(join(tmpdir(), 'cocos-ai-scenario-'));
    const { driver, pages } = createFakeDriver();
    const server = new ProbeServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_000, runtimeDriver: driver, captureRoot });
    const address = await server.start();
    const url = `ws://127.0.0.1:${address.port}`;
    const bridge = await connectFakeBridge({ url });

    // 基准图像：与 fake 截图同款的纯色 PNG（差异比例 0）
    const baselinePath = join(captureRoot, 'baseline.png');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(baselinePath, createSolidPng(960, 640, [10, 10, 10, 255]));

    const launched = await callServer(url, 'server.previewLaunch', { selector: { projectId: 'project-1' }, params: {} });
    const sessionId = (launched.payload as { sessionId: string }).sessionId;

    const reply = await callServer(url, 'server.runtimeRunScenario', {
      sessionId,
      steps: [
        { kind: 'launch' },
        { kind: 'wait-node', path: 'Canvas/btn', timeoutMs: 500 },
        { kind: 'assert-property', path: 'Canvas/btn', property: 'cc.Label.string', expected: '确定退出？' },
        { kind: 'dispatch-input', inputType: 'tap', x: 100, y: 100 },
        { kind: 'assert-console', pattern: '登录成功', timeoutMs: 500 },
        { kind: 'capture' },
        { kind: 'assert-image-diff', baselinePath: 'baseline.png', threshold: 0.01 }
      ]
    });
    expect(reply.ok).toBe(true);
    const report = reply.payload as { passed: boolean; steps: Array<{ kind: string; passed: boolean; evidence?: string }> };
    expect(report.passed).toBe(true);
    expect(report.steps.map((step) => step.kind)).toEqual([
      'launch', 'wait-node', 'assert-property', 'dispatch-input', 'assert-console', 'capture', 'assert-image-diff'
    ]);
    expect(report.steps[5].evidence).toContain(captureRoot);
    expect(report.steps[6].evidence).toContain(captureRoot);

    // 逃逸截图根目录的基准路径必须被拒绝
    const escape = await callServer(url, 'server.runtimeRunScenario', {
      sessionId,
      steps: [{ kind: 'assert-image-diff', baselinePath: '../../outside.png', threshold: 0.01 }]
    });
    const escapeReport = escape.payload as { passed: boolean; steps: Array<{ passed: boolean; error?: string }> };
    expect(escapeReport.passed).toBe(false);
    expect(escapeReport.steps[0].error).toContain('BASELINE_PATH_OUT_OF_ROOT');

    bridge.close();
    await server.stop();
  });
});
