import { describe, expect, it, vi } from 'vitest';
import { WorkbenchHost } from '../src/workbench-host.js';

describe('WorkbenchHost', () => {
  it('只在回环地址提供三栏页面，并把树、组件、写入和原生窗口绑定到同一会话', async () => {
    const stopHierarchy = vi.fn(async () => undefined);
    const stopOrder: string[] = [];
    let nativeState = {
      state: 'idle' as const,
      parentProcessId: process.pid,
      childProcessId: 30228,
      parentWindowHandle: null as string | null,
      simulatorWindowHandle: null as string | null,
      embeddedWindowHandle: null as string | null,
      error: null as string | null
    };
    const nativeHost = {
      setHighlight: vi.fn(),
      getStatus: vi.fn(() => nativeState),
      start: vi.fn(async () => {
        nativeState = {
          ...nativeState,
          state: 'ready' as const,
          parentWindowHandle: '1001',
          simulatorWindowHandle: '2002',
          embeddedWindowHandle: '3003'
        };
        return nativeState;
      }),
      stop: vi.fn(async () => {
        stopOrder.push('native-host');
        nativeState = { ...nativeState, state: 'idle' as const };
      })
    };
    let runtimeConnected = false;
    const request = vi.fn(async (method: string, payload: unknown) => {
      if (method === 'server.previewLaunch') {
        runtimeConnected = true;
        return {
          sessionId: 'session-1',
          runtimeInstanceId: 'runtime-1',
          state: 'ready',
          actualResolution: { width: 852, height: 393 }
        };
      }
      if (method === 'probe.simulatorRuntimeStatus') {
        return { connected: runtimeConnected, runtimeId: runtimeConnected ? 'runtime-1' : null };
      }
      if (method === 'server.runtimeComponent') {
        return { componentType: 'Boost', properties: { speed: 2 } };
      }
      if (method === 'server.runtimeNode') {
        return { nodeUuid: 'node-1', previewSessionId: (payload as any).sessionId, path: (payload as any).path, origin: { kind: 'prefab', assetUuid: 'prefab-1', sourceUrl: 'db://assets/ui.prefab', available: true } };
      }
      if (method === 'probe.assetReveal') return { selected: true, uuid: 'prefab-1' };
      if (method === 'server.runtimeSetProperty') {
        return { written: true, readback: (payload as { value?: unknown }).value };
      }
      if (method === 'server.runtimeDispatchInput') {
        return { dispatched: true, ...(payload as Record<string, unknown>) };
      }
      if (method === 'server.previewStop') {
        stopOrder.push('runtime-session');
        runtimeConnected = false;
        return { closed: true };
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`);
    });
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      request,
      streamRuntimeHierarchy: vi.fn(async (_sessionId: string, listener: (snapshot: Record<string, any>) => void) => {
        listener({
          sceneUuid: 'scene-1',
          sceneEpoch: 1,
          revision: 7,
          nodeCount: 2,
          root: {
            name: 'main',
            path: '/main~0',
            uuid: 'scene-1',
            active: true,
            components: [],
            children: [{
              name: 'root',
              path: '/main~0/root~0',
              uuid: 'node-1',
              active: true,
              components: [{ type: 'Boost' }],
              children: []
            }]
          }
        });
        return stopHierarchy;
      })
    };
    let forwardNativeInput: ((input: any) => void) | undefined;
    const createNativeHost = vi.fn((options: { onInput: (input: any) => void }) => {
      forwardNativeInput = options.onInput;
      return nativeHost;
    });
    const host = new WorkbenchHost(
      { projectId: 'project-1', editorInstanceId: 'editor-1' },
      client,
      createNativeHost
    );
    const { url } = await host.start();

    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      await expect(fetch(`${url}api/health`).then((response) => response.json())).resolves.toEqual({ ok: true });
      await expect(host.readSnapshot()).resolves.toMatchObject({ status: 'idle', session: null });
      expect(request).not.toHaveBeenCalledWith('server.previewLaunch', expect.anything());

      const idleNativeWindow = await fetch(`${url}api/native-window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', x: 10, y: 10, width: 100, height: 100, viewportWidth: 500, viewportHeight: 500 })
      });
      expect(idleNativeWindow.status).toBe(409);

      const pageResponse = await fetch(url);
      const page = await pageResponse.text();
      expect(pageResponse.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(page).toContain('实时节点树');
      expect(page).toContain('运行时属性');
      expect(page).toContain('原生模拟器');

      const invalidComponent = await fetch(`${url}api/component`);
      expect(invalidComponent.status).toBe(400);
      await expect(invalidComponent.json()).resolves.toEqual({ error: 'COMPONENT_QUERY_INVALID' });

      const state = await fetch(`${url}api/start`, { method: 'POST' }).then((response) => response.json());
      expect(state).toMatchObject({
        status: 'ready',
        userStopped: false,
        session: { sessionId: 'session-1', runtimeInstanceId: 'runtime-1' },
        hierarchy: { sceneEpoch: 1, revision: 7, nodeCount: 2 }
      });
      expect(request).toHaveBeenCalledWith('server.previewLaunch', {
        selector: { projectId: 'project-1', editorInstanceId: 'editor-1' },
        params: { platform: 'creator-simulator' }
      });
      await fetch(`${url}api/selection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1', path: '/main~0/root~0' }) });
      // 独立工具直接请求宿主，沿用页面会话及选择，无需再 launch 一个 RuntimeController。
      await expect(host.readSnapshot({ view: 'node' })).resolves.toMatchObject({ previewSessionId: 'session-1', path: '/main~0/root~0', origin: { sourceUrl: 'db://assets/ui.prefab' } });
      await expect(host.readSnapshot({ view: 'component', componentType: 'Boost' })).resolves.toMatchObject({ properties: { speed: 2 } });
      expect(request).toHaveBeenCalledWith('server.runtimeComponent', { sessionId: 'session-1', path: '/main~0/root~0', componentType: 'Boost', inspector: true });
      expect((await fetch(`${url}api/node?sessionId=old&path=%2Fmain~0`)).status).toBe(409);
      const reveal = await fetch(`${url}api/reveal-source`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-1', path: '/main~0/root~0', assetUuid: 'prefab-1' }) });
      expect(await reveal.json()).toMatchObject({ selected: true, uuid: 'prefab-1' });
      expect(request.mock.calls.filter(([method]) => method === 'server.previewLaunch')).toHaveLength(1);
      await expect(host.readSnapshot({ view: 'overview', sessionId: 'session-old' })).rejects.toThrow('WORKBENCH_SESSION_CHANGED');
      const reconnect = await fetch(`${url}api/reconnect`, { method: 'POST' });
      expect(reconnect.status).toBe(404);

      await expect(fetch(`${url}api/hierarchy`).then((response) => response.json())).resolves.toMatchObject({
        root: { name: 'main', children: [{ name: 'root' }] }
      });
      await expect(fetch(`${url}api/component?path=%2Fmain~0%2Froot~0&componentType=Boost`).then((response) => response.json()))
        .resolves.toEqual({ componentType: 'Boost', properties: { speed: 2 } });

      const invalidWrite = await fetch(`${url}api/property`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', path: '', componentType: 'Boost', property: 'speed', value: 3 })
      });
      expect(invalidWrite.status).toBe(400);

      const staleWrite = await fetch(`${url}api/property`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-old', path: '/main~0/root~0', componentType: 'Boost', property: 'speed', value: 3 })
      });
      expect(staleWrite.status).toBe(409);
      await expect(staleWrite.json()).resolves.toEqual({ error: 'WORKBENCH_SESSION_CHANGED' });

      await expect(fetch(`${url}api/property`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', path: '/main~0/root~0', componentType: 'Boost', property: 'speed', value: 3 })
      }).then((response) => response.json())).resolves.toEqual({ written: true, readback: 3 });

      const invalidNativeWindow = await fetch(`${url}api/native-window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', x: 0, y: 0, width: 0, height: 0, viewportWidth: 1500, viewportHeight: 860 })
      });
      expect(invalidNativeWindow.status).toBe(400);

      const staleNativeWindow = await fetch(`${url}api/native-window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-old', x: 10, y: 10, width: 100, height: 100, viewportWidth: 500, viewportHeight: 500 })
      });
      expect(staleNativeWindow.status).toBe(409);

      await expect(fetch(`${url}api/native-window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session-1',
          parentTitle: 'Cocos AI 运行工作台',
          x: 850,
          y: 180,
          width: 600,
          height: 276,
          viewportWidth: 1500,
          viewportHeight: 860
        })
      }).then((response) => response.json())).resolves.toMatchObject({
        state: 'ready',
        childProcessId: 30228,
        parentWindowHandle: '1001',
        simulatorWindowHandle: '2002',
        embeddedWindowHandle: '3003'
      });
      expect(nativeHost.start).toHaveBeenCalledWith({
        x: 850,
        y: 180,
        width: 600,
        height: 276,
        viewportWidth: 1500,
        viewportHeight: 860
      });
      expect(createNativeHost).toHaveBeenCalledWith(expect.objectContaining({
        parentProcessId: process.pid,
        childProcessId: 0,
        onInput: expect.any(Function)
      }));

      forwardNativeInput?.({ type: 'pointerup', x: 426, y: 196, button: 0, buttons: 0 });
      for (const input of [
        { type: 'pointermove', x: 423, y: 193, button: 0, buttons: 0 },
        { type: 'pointerdown', x: 426, y: 196, button: 0, buttons: 1 }
      ]) {
        const response = await fetch(`${url}api/native-input`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'session-1', ...input })
        });
        expect(response.status).toBe(202);
      }
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith('server.runtimeDispatchInput', expect.objectContaining({
        sessionId: 'session-1', inputType: 'pointerdown', x: 426, y: 196, button: 0, buttons: 1
      })));
      const nativeInputs = request.mock.calls
        .filter(([method]) => method === 'server.runtimeDispatchInput')
        .map(([, input]) => input as Record<string, unknown>);
      expect(nativeInputs.map((input) => input.inputType)).toEqual(['pointerup', 'pointermove', 'pointerdown']);

      await expect(fetch(`${url}api/native-highlight`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', viewport: { width: 852, height: 393 }, points: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }], anchor: { x: 2, y: 3 } })
      }).then((response) => response.json())).resolves.toEqual({ accepted: true });
      expect(nativeHost.setHighlight).toHaveBeenCalledWith(expect.objectContaining({ viewport: { width: 852, height: 393 } }));

      // 运行探针迟到时，概览不能把旧 runtime 与已停止的 session 拼在一起。
      let releaseOverview: () => void = () => undefined;
      request.mockImplementationOnce(() => new Promise((resolve) => {
        releaseOverview = () => resolve({ connected: true, runtimeId: 'runtime-1' });
      }));
      const pendingOverview = host.readSnapshot({ view: 'overview', sessionId: 'session-1' });
      await expect(fetch(`${url}api/stop`, { method: 'POST' }).then((response) => response.json())).resolves.toMatchObject({
        status: 'idle',
        userStopped: true,
        session: null,
        runtime: { connected: false }
      });
      releaseOverview();
      await expect(pendingOverview).rejects.toThrow('WORKBENCH_SESSION_CHANGED');

      const lateNativeWindow = await fetch(`${url}api/native-window`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', x: 10, y: 10, width: 100, height: 100, viewportWidth: 500, viewportHeight: 500 })
      });
      expect(lateNativeWindow.status).toBe(409);
    } finally {
      await host.stop();
    }

    expect(stopHierarchy).toHaveBeenCalledOnce();
    expect(nativeHost.stop).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('server.previewStop', { sessionId: 'session-1' });
    expect(stopOrder).toEqual(['runtime-session', 'native-host']);
  });
});
