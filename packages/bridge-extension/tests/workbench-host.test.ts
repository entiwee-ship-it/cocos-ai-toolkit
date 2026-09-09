import { describe, expect, it, vi } from 'vitest';
import { WorkbenchHost } from '../src/workbench-host.js';

describe('WorkbenchHost', () => {
  it('只在回环地址提供三栏页面，并把树、组件、写入和原生窗口绑定到同一会话', async () => {
    const stopHierarchy = vi.fn(async () => undefined);
    let nativeState = {
      state: 'idle' as const,
      parentProcessId: process.pid,
      childProcessId: 30228,
      parentWindowHandle: null as string | null,
      simulatorWindowHandle: null as string | null,
      error: null as string | null
    };
    const nativeHost = {
      getStatus: vi.fn(() => nativeState),
      start: vi.fn(async () => {
        nativeState = {
          ...nativeState,
          state: 'ready' as const,
          parentWindowHandle: '1001',
          simulatorWindowHandle: '2002'
        };
        return nativeState;
      }),
      stop: vi.fn(async () => {
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
      if (method === 'server.runtimeSetProperty') {
        return { written: true, readback: (payload as { value?: unknown }).value };
      }
      if (method === 'server.previewStop') {
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
    const createNativeHost = vi.fn(() => nativeHost);
    const host = new WorkbenchHost(
      { projectId: 'project-1', editorInstanceId: 'editor-1' },
      client,
      createNativeHost
    );
    const { url } = await host.start();

    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      await expect(fetch(`${url}api/health`).then((response) => response.json())).resolves.toEqual({ ok: true });

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
        session: { sessionId: 'session-1', runtimeInstanceId: 'runtime-1' },
        hierarchy: { sceneEpoch: 1, revision: 7, nodeCount: 2 }
      });
      expect(request).toHaveBeenCalledWith('server.previewLaunch', {
        selector: { projectId: 'project-1', editorInstanceId: 'editor-1' },
        params: { platform: 'creator-simulator' }
      });
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
        body: JSON.stringify({ path: '', componentType: 'Boost', property: 'speed', value: 3 })
      });
      expect(invalidWrite.status).toBe(400);

      await expect(fetch(`${url}api/property`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/main~0/root~0', componentType: 'Boost', property: 'speed', value: 3 })
      }).then((response) => response.json())).resolves.toEqual({ written: true, readback: 3 });

      const invalidNativeWindow = await fetch(`${url}api/native-window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 0, y: 0, width: 0, height: 0, viewportWidth: 1500, viewportHeight: 860 })
      });
      expect(invalidNativeWindow.status).toBe(400);

      await expect(fetch(`${url}api/native-window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
        simulatorWindowHandle: '2002'
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
        childProcessId: 0
      }));
    } finally {
      await host.stop();
    }

    expect(stopHierarchy).toHaveBeenCalledOnce();
    expect(nativeHost.stop).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('server.previewStop', { sessionId: 'session-1' });
  });
});
