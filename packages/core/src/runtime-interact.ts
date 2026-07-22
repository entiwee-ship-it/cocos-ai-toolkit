import { isDeepStrictEqual } from 'node:util';

/**
 * 运行态属性监听（阶段五）：server 侧有界轮询，变化时返回。
 * 拉取式语义适配现有请求-响应通道，无需新增推送通道。
 */

export interface WatchPropertyOptions {
  /** 轮询间隔毫秒，默认 200。 */
  intervalMs?: number;
  /** 总超时毫秒，默认 10000。 */
  timeoutMs?: number;
  /** 收集的变化条数上限，默认 1（首次变化即返回）。 */
  maxChanges?: number;
  /** 时间源（测试可注入）。 */
  now?: () => Date;
}

export interface WatchPropertyChange {
  from: unknown;
  to: unknown;
  timestamp: string;
}

export interface WatchPropertyResult {
  /** 达到超时仍未收集满变化时为 true。 */
  timedOut: boolean;
  initialValue: unknown;
  changes: WatchPropertyChange[];
}

/**
 * 轮询读取直至值变化、收集满或超时。
 *
 * @param read 单次属性读取（返回当前值的序列化形态）。
 * @param options 轮询参数。
 * @returns 变化记录与超时标记。
 */
export async function watchRuntimeProperty(
  read: () => Promise<unknown>,
  options: WatchPropertyOptions = {}
): Promise<WatchPropertyResult> {
  const intervalMs = options.intervalMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxChanges = options.maxChanges ?? 1;
  const now = options.now ?? (() => new Date());
  const deadline = Date.now() + timeoutMs;

  const initialValue = await read();
  let lastValue = initialValue;
  const changes: WatchPropertyChange[] = [];

  while (true) {
    if (changes.length >= maxChanges) {
      return { timedOut: false, initialValue, changes };
    }
    if (Date.now() >= deadline) {
      return { timedOut: changes.length < maxChanges, initialValue, changes };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    const value = await read();
    if (!isDeepStrictEqual(value, lastValue)) {
      changes.push({ from: lastValue, to: value, timestamp: now().toISOString() });
      lastValue = value;
    }
  }
}
