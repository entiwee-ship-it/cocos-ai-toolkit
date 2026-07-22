import { ProbeError } from './probe-errors';

interface DebugEditorMessageRequest {
  namespace?: unknown;
  method?: unknown;
  args?: unknown;
  mode?: unknown;
  timeoutMs?: unknown;
}

/**
 * 调试探针：按命名空间调用任意 Editor.Message，用于验证尚未确认的编辑器消息。
 * 仅供探针与诊断使用；目标消息不存在时 Creator 可能挂起，因此必须带超时兜底。
 *
 * @param request 调用参数。namespace 目标包名；method 消息名；args 位置参数数组；mode 为 request（默认）或 send；timeoutMs 等待超时毫秒数。
 * @returns request 模式返回消息结果；send 模式返回发送确认。
 */
export async function debugEditorMessage(request: DebugEditorMessageRequest): Promise<unknown> {
  const namespace = typeof request.namespace === 'string' ? request.namespace : '';
  const method = typeof request.method === 'string' ? request.method : '';
  if (!namespace || !method) {
    throw new ProbeError('INVALID_REQUEST', { reason: 'namespace 与 method 必须是非空字符串' });
  }
  const args = Array.isArray(request.args) ? request.args : [];
  const mode = request.mode === 'send' ? 'send' : 'request';
  const timeoutMs = typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
    ? Math.min(Math.floor(request.timeoutMs), 30_000)
    : 8_000;

  if (mode === 'send') {
    (Editor.Message.send as (ns: string, msg: string, ...rest: unknown[]) => void)(namespace, method, ...args);
    return { sent: true, namespace, method };
  }

  const result = await withTimeout(
    (Editor.Message.request as (ns: string, msg: string, ...rest: unknown[]) => Promise<unknown>)(namespace, method, ...args),
    timeoutMs,
    namespace,
    method
  );
  return { result };
}

/**
 * 为编辑器消息请求增加超时兜底，避免不存在或挂起的消息拖死探针会话。
 *
 * @param promise 编辑器消息返回的 Promise。
 * @param timeoutMs 超时毫秒数。
 * @param namespace 目标包名（仅用于错误诊断）。
 * @param method 消息名（仅用于错误诊断）。
 * @returns 消息实际返回结果。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, namespace: string, method: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProbeError('EDITOR_MESSAGE_TIMEOUT', { namespace, method, timeoutMs }));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (error instanceof ProbeError) {
          reject(error);
          return;
        }
        const message = error instanceof Error && error.message ? error.message : 'EDITOR_MESSAGE_FAILED';
        reject(new ProbeError(message, { namespace, method }));
      }
    );
  });
}
