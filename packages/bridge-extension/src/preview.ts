import { get, request as requestHttp } from 'node:http';
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

export interface SimulatorPreviewSource extends PreviewMessageSource {
  send(namespace: string, method: string, ...args: unknown[]): void;
  setPlatform(platform: 'simulator'): Promise<void>;
}

export interface SimulatorRuntimeStatus {
  connected: boolean;
  runtimeId: string | null;
  lastSeenAt: string | null;
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

/** 按 Creator 工具栏同一流程启动第三项原生模拟器预览。 */
export async function openSimulatorPreview(
  source: SimulatorPreviewSource
): Promise<{ opened: true; platform: 'creator-simulator'; url: string | null }> {
  await source.setPlatform('simulator');
  source.send('preview', 'change-platform', 'simulator');
  await source.request('preview', 'open-terminal', undefined);
  const url = await source.request('preview', 'query-preview-url').catch(() => null);
  return {
    opened: true,
    platform: 'creator-simulator',
    url: typeof url === 'string' && url ? url : null
  };
}

/** 读取由第三项模拟器内运行代理上报的当前真实进程身份。 */
export async function readSimulatorRuntimeStatus(
  source: PreviewMessageSource
): Promise<SimulatorRuntimeStatus> {
  try {
    const baseUrl = await runtimeApiBaseUrl(source);
    const raw = await requestRuntimeJson(`${baseUrl}/status`, 'GET');
    return {
      connected: raw.connected === true,
      runtimeId: typeof raw.runtimeId === 'string' && raw.runtimeId ? raw.runtimeId : null,
      lastSeenAt: typeof raw.lastSeenAt === 'string' && raw.lastSeenAt ? raw.lastSeenAt : null
    };
  } catch {
    return { connected: false, runtimeId: null, lastSeenAt: null };
  }
}

/** 经 Creator Preview Server 把表达式交给同一个 Simulator 运行进程执行。 */
export async function evaluateSimulatorRuntime(
  source: PreviewMessageSource,
  input: { runtimeId: string; expression: string }
): Promise<unknown> {
  const baseUrl = await runtimeApiBaseUrl(source);
  const raw = await requestRuntimeJson(`${baseUrl}/evaluate`, 'POST', input);
  if (raw.ok !== true) {
    throw new ProbeError('CREATOR_SIMULATOR_RUNTIME_EVALUATION_FAILED', {
      runtimeId: input.runtimeId,
      error: raw.error
    });
  }
  return raw.value;
}

/** Editor.Message 绑定（生产路径）。 */
export const editorPreviewMessageSource: PreviewMessageSource = {
  request: (namespace, method, ...args) =>
    (Editor.Message.request as (ns: string, msg: string, ...rest: unknown[]) => Promise<unknown>)(namespace, method, ...args)
};

export const editorSimulatorPreviewSource: SimulatorPreviewSource = {
  ...editorPreviewMessageSource,
  send: (namespace, method, ...args) => {
    (Editor.Message.send as (ns: string, msg: string, ...rest: unknown[]) => void)(namespace, method, ...args);
  },
  setPlatform: () => Editor.Profile.setConfig(
    'preview',
    'preview.current.platform',
    'simulator',
    'local'
  )
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

async function runtimeApiBaseUrl(source: PreviewMessageSource): Promise<string> {
  const value = await source.request('preview', 'query-preview-url');
  if (typeof value !== 'string' || !value) throw new ProbeError('PREVIEW_URL_UNAVAILABLE');
  const url = new URL(value);
  if (url.protocol !== 'http:') throw new ProbeError('PREVIEW_URL_INVALID', { url: value });
  url.hostname = '127.0.0.1';
  url.pathname = '/cocos-ai/runtime';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function requestRuntimeJson(
  url: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<Record<string, unknown>> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = requestHttp(url, {
      method,
      timeout: 16_000,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      } : undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value: Record<string, unknown> = {};
        try {
          value = text ? JSON.parse(text) as Record<string, unknown> : {};
        } catch (error) {
          reject(error);
          return;
        }
        if ((response.statusCode ?? 500) >= 400) {
          reject(new ProbeError(
            typeof value.error === 'string' ? value.error : 'CREATOR_SIMULATOR_RUNTIME_HTTP_FAILED',
            { statusCode: response.statusCode, url }
          ));
          return;
        }
        resolve(value);
      });
    });
    request.once('timeout', () => request.destroy(new Error('CREATOR_SIMULATOR_RUNTIME_HTTP_TIMEOUT')));
    request.once('error', reject);
    request.end(payload || undefined);
  });
}
