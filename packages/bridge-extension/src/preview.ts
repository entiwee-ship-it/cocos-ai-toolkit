import { get } from 'node:http';
import { ProbeError } from './probe-errors';

/**
 * Preview 生命周期封装。
 * Creator 3.8.8 实测结论：
 * preview/open 启动 server 但不打开页面；页面停止无公开消息；
 * query-preview-url/query-connect-num 可用。核心逻辑与 Editor 绑定解耦（依赖注入便于测试）。
 */

/** 编辑器消息调用接口（Editor.Message.request 的最小子集）。 */
export interface PreviewMessageSource {
  request(namespace: string, method: string, ...args: unknown[]): Promise<unknown>;
}

/** preview server HTTP 就绪探测接口。 */
export interface PreviewHttpProbe {
  isReady(url: string, timeoutMs: number): Promise<boolean>;
}

export interface PreviewOpenOptions {
  /** HTTP 就绪等待总超时，默认 10000。 */
  readyTimeoutMs?: number;
  /** HTTP 就绪轮询间隔，默认 200。 */
  readyPollMs?: number;
}

/**
 * 启动 preview server 并等待页面 HTTP 可达。
 *
 * @param source 编辑器消息接口。
 * @param http HTTP 就绪探测接口。
 * @param options 等待参数。
 * @returns preview 页面 URL（原始值，host 规范化由调用方负责）。
 */
export async function openPreviewServer(
  source: PreviewMessageSource,
  http: PreviewHttpProbe,
  options: PreviewOpenOptions = {}
): Promise<{ url: string }> {
  await source.request('preview', 'open');
  const url = await source.request('preview', 'query-preview-url');
  if (typeof url !== 'string' || !url) {
    throw new ProbeError('PREVIEW_URL_UNAVAILABLE');
  }
  const timeoutMs = options.readyTimeoutMs ?? 10_000;
  const pollMs = options.readyPollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await http.isReady(url, Math.min(pollMs * 5, 2_000))) {
      return { url };
    }
    if (Date.now() >= deadline) {
      throw new ProbeError('PREVIEW_SERVER_NOT_READY', { url, timeoutMs });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * 读取 preview server 状态；server 未启动时返回不可用状态而非抛错。
 *
 * @param source 编辑器消息接口。
 * @returns URL、接入页面数与 server 运行标记。
 */
export async function readPreviewStatus(
  source: PreviewMessageSource
): Promise<{ url: string | null; connectNum: number; serverRunning: boolean }> {
  try {
    const url = await source.request('preview', 'query-preview-url');
    const connectNum = await source.request('preview', 'query-connect-num');
    return {
      url: typeof url === 'string' && url ? url : null,
      connectNum: typeof connectNum === 'number' && Number.isFinite(connectNum) ? connectNum : 0,
      serverRunning: typeof url === 'string' && Boolean(url)
    };
  } catch {
    return { url: null, connectNum: 0, serverRunning: false };
  }
}

/**
 * 刷新全部已接入的 preview 页面。
 *
 * @param source 编辑器消息接口。
 * @returns 刷新确认与当前连接数。
 */
export async function reloadPreviewPages(
  source: PreviewMessageSource
): Promise<{ reloaded: true; connectNum: number }> {
  await source.request('preview', 'reload-terminal');
  const connectNum = await source.request('preview', 'query-connect-num');
  return {
    reloaded: true,
    connectNum: typeof connectNum === 'number' && Number.isFinite(connectNum) ? connectNum : 0
  };
}

/** Editor.Message 绑定（生产路径）。 */
export const editorPreviewMessageSource: PreviewMessageSource = {
  request: (namespace, method, ...args) =>
    (Editor.Message.request as (ns: string, msg: string, ...rest: unknown[]) => Promise<unknown>)(namespace, method, ...args)
};

/** 基于 node:http 的 preview server 就绪探测（生产路径）。 */
export const nodeHttpPreviewProbe: PreviewHttpProbe = {
  isReady: (url, timeoutMs) =>
    new Promise<boolean>((resolve) => {
      const request = get(url, { timeout: timeoutMs }, (response) => {
        response.resume();
        resolve(response.statusCode !== undefined && response.statusCode < 500);
      });
      request.on('timeout', () => {
        request.destroy();
        resolve(false);
      });
      request.on('error', () => resolve(false));
    })
};
