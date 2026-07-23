import { describe, expect, it } from 'vitest';
import {
  openPreviewServer,
  readPreviewStatus,
  reloadPreviewPages,
  type PreviewHttpProbe,
  type PreviewMessageSource
} from '../src/preview.js';

function createSource(handler: (namespace: string, method: string) => unknown) {
  const calls: Array<{ namespace: string; method: string }> = [];
  const source: PreviewMessageSource = {
    request: async (namespace, method) => {
      calls.push({ namespace, method });
      return handler(namespace, method);
    }
  };
  return { source, calls };
}

function createHttpProbe(sequence: boolean[]): PreviewHttpProbe & { calls: number } {
  const probe = {
    calls: 0,
    isReady: async () => {
      probe.calls += 1;
      return sequence.length > 0 ? sequence.shift()! : false;
    }
  };
  return probe;
}

describe('openPreviewServer', () => {
  it('调用 preview/open 并等待 HTTP 就绪后返回 URL', async () => {
    const { source, calls } = createSource((namespace, method) => {
      if (method === 'query-preview-url') return 'http://192.168.1.23:7457';
      return undefined;
    });
    const http = createHttpProbe([false, true]);
    const result = await openPreviewServer(source, http, { readyPollMs: 1, readyTimeoutMs: 1_000 });
    expect(result).toEqual({ url: 'http://192.168.1.23:7457' });
    expect(calls.map((call) => call.method)).toEqual(['open', 'query-preview-url']);
    expect(http.calls).toBe(2);
  });

  it('HTTP 持续未就绪时抛出明确错误', async () => {
    const { source } = createSource(() => 'http://192.168.1.23:7457');
    const http = createHttpProbe([]);
    await expect(openPreviewServer(source, http, { readyPollMs: 1, readyTimeoutMs: 5 }))
      .rejects.toThrow('PREVIEW_SERVER_NOT_READY');
  });

  it('URL 不可用时抛出明确错误', async () => {
    const { source } = createSource(() => undefined);
    const http = createHttpProbe([]);
    await expect(openPreviewServer(source, http, { readyPollMs: 1, readyTimeoutMs: 5 }))
      .rejects.toThrow('PREVIEW_URL_UNAVAILABLE');
  });
});

describe('readPreviewStatus', () => {
  it('聚合 URL 与连接数', async () => {
    const { source } = createSource((_namespace, method) => {
      if (method === 'query-preview-url') return 'http://192.168.1.23:7457';
      if (method === 'query-connect-num') return 2;
      return undefined;
    });
    await expect(readPreviewStatus(source)).resolves.toEqual({
      url: 'http://192.168.1.23:7457',
      connectNum: 2,
      serverRunning: true
    });
  });

  it('preview server 未启动时返回不可用状态而非抛错', async () => {
    const { source } = createSource(() => {
      throw new Error('not running');
    });
    await expect(readPreviewStatus(source)).resolves.toEqual({
      url: null,
      connectNum: 0,
      serverRunning: false
    });
  });
});

describe('reloadPreviewPages', () => {
  it('发送 reload-terminal 并回传当前连接数', async () => {
    const { source, calls } = createSource((_namespace, method) => {
      if (method === 'query-connect-num') return 1;
      return undefined;
    });
    await expect(reloadPreviewPages(source)).resolves.toEqual({ reloaded: true, connectNum: 1 });
    expect(calls.map((call) => call.method)).toEqual(['reload-terminal', 'query-connect-num']);
  });
});
