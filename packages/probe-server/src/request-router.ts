interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface RequestErrorPayload {
  code: string;
  message: string;
  details: unknown;
  stage?: string;
  nextAction?: string;
  retryable?: boolean;
}

export interface RequestContext {
  method: string;
  editorInstanceId: string;
}

export class RequestRouterError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly stage?: string;
  readonly nextAction?: string;

  constructor(readonly payload: RequestErrorPayload) {
    super(formatRequestError(payload));
    this.name = 'RequestRouterError';
    this.code = payload.code;
    this.details = payload.details;
    this.stage = payload.stage;
    this.nextAction = payload.nextAction;
  }
}

export class RequestRouter {
  private readonly pending = new Map<string, PendingRequest>();

  /**
   * 登记一个等待 Bridge 响应的请求。
   *
   * @param requestId 请求标识。
   * @param timeoutMs 等待响应的最大毫秒数。
   * @returns Bridge 响应载荷。
   */
  wait(requestId: string, timeoutMs: number, context?: RequestContext): Promise<unknown> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        const outcomeUnknown = context ? isPotentialWriteMethod(context.method) : true;
        reject(new RequestRouterError({
          code: outcomeUnknown ? 'OUTCOME_UNKNOWN' : 'SERVER_REQUEST_TIMEOUT',
          message: `等待 Bridge 响应超过 ${timeoutMs}ms`,
          details: {
            timeoutMs,
            elapsedMs: Date.now() - startedAt,
            requestId,
            ...(context ?? {})
          },
          stage: outcomeUnknown ? 'unknown' : 'bridge-request',
          nextAction: outcomeUnknown
            ? '先重读当前文档状态；确认结局前禁止重试写入'
            : '确认 Creator Bridge 在线后重试该只读请求',
          retryable: !outcomeUnknown
        }));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout });
    });
  }

  /**
   * 使用 Bridge 响应完成对应请求。
   *
   * @param correlationId Bridge 返回的关联请求标识。
   * @param ok Bridge 是否成功执行请求。
   * @param payload 成功载荷或错误详情。
   * @returns 是否找到等待中的请求。
   */
  complete(correlationId: string, ok: boolean, payload: unknown): boolean {
    const request = this.pending.get(correlationId);
    if (!request) {
      return false;
    }

    clearTimeout(request.timeout);
    this.pending.delete(correlationId);

    if (ok) {
      request.resolve(payload);
    } else {
      request.reject(new RequestRouterError(normalizeRequestErrorPayload(payload)));
    }

    return true;
  }

  /**
   * 终止所有未完成请求，供 Server 关闭时清理。
   */
  abortAll(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('SERVER_STOPPED'));
    }
    this.pending.clear();
  }
}

export function toServerErrorPayload(error: unknown): RequestErrorPayload {
  if (error instanceof RequestRouterError) return error.payload;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code) {
      return {
        code: record.code,
        message: typeof record.message === 'string' && record.message ? record.message : record.code,
        details: record.details ?? {},
        ...(typeof record.stage === 'string' ? { stage: record.stage } : {}),
        ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {}),
        ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {})
      };
    }
  }
  if (error instanceof Error) {
    const message = error.message || 'UNKNOWN_SERVER_ERROR';
    const code = readStableErrorCode(message, 'UNKNOWN_SERVER_ERROR');
    return {
      code,
      message,
      details: {},
      retryable: code === 'EDITOR_INSTANCE_DISCONNECTED'
    };
  }
  return { code: 'UNKNOWN_SERVER_ERROR', message: 'Unknown server error', details: {} };
}

function normalizeRequestErrorPayload(payload: unknown): RequestErrorPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { code: 'BRIDGE_REQUEST_FAILED', message: 'Bridge request failed', details: payload };
  }
  const record = payload as Record<string, unknown>;
  const code = typeof record.code === 'string' && record.code ? record.code : 'BRIDGE_REQUEST_FAILED';
  const message = typeof record.message === 'string' && record.message ? record.message : code;
  return {
    code,
    message,
    details: record.details ?? {},
    ...(typeof record.stage === 'string' ? { stage: record.stage } : {}),
    ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {})
  };
}

function isPotentialWriteMethod(method: string): boolean {
  return method === 'probe.directWrite'
    || method === 'probe.saveDocument'
    || method === 'probe.importAsset'
    || method === 'probe.createPrefab'
    || method === 'probe.deleteAsset'
    || method === 'probe.refreshAsset';
}

function formatRequestError(payload: RequestErrorPayload): string {
  return [
    payload.code,
    payload.message !== payload.code ? payload.message : null,
    payload.stage ? `stage=${payload.stage}` : null,
    payload.nextAction ? `nextAction=${payload.nextAction}` : null
  ].filter(Boolean).join(': ');
}
import { readStableErrorCode } from '@cocos-ai/protocol';
