import { CreatorClientError } from '@cocos-ai/client';
import { readStableErrorCode } from '@cocos-ai/protocol';

export interface StructuredToolError {
  code: string;
  message: string;
  details: unknown;
  stage?: string;
  nextAction?: string;
  retryable: boolean;
}

/**
 * 把工具成功值或异常统一转换为 MCP 文本与 structuredContent 双份结果。
 *
 * @param operation 工具执行结果或 Promise。
 * @returns 成功结果；失败时返回 isError=true 和稳定 error 对象。
 */
export async function toToolResult(operation: unknown | Promise<unknown>) {
  try {
    const value = await operation;
    const structuredContent = toStructuredContent(value);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
      structuredContent
    };
  } catch (error) {
    const structuredError = normalizeToolError(error);
    const structuredContent = { error: structuredError };
    return {
      isError: true,
      content: [{ type: 'text' as const, text: formatToolError(structuredError) }],
      structuredContent
    };
  }
}

/** 把 Creator IPC、Bridge 和本地 Error 统一为机器可读错误。 */
export function normalizeToolError(error: unknown, fallbackCode = 'TOOL_EXECUTION_FAILED'): StructuredToolError {
  if (error instanceof CreatorClientError) {
    return {
      code: error.code,
      message: error.originalMessage,
      details: error.details,
      ...(error.stage ? { stage: error.stage } : {}),
      ...(error.nextAction ? { nextAction: error.nextAction } : {}),
      retryable: error.retryable ?? isRetryableCode(error.code)
    };
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code) {
      return {
        code: record.code,
        message: typeof record.message === 'string' && record.message ? record.message : record.code,
        details: record.details ?? {},
        ...(typeof record.stage === 'string' ? { stage: record.stage } : {}),
        ...(typeof record.nextAction === 'string' ? { nextAction: record.nextAction } : {}),
        retryable: typeof record.retryable === 'boolean'
          ? record.retryable
          : isRetryableCode(record.code)
      };
    }
  }

  const message = error instanceof Error ? error.message : String(error || fallbackCode);
  const code = readStableErrorCode(message, fallbackCode);
  return {
    code,
    message,
    details: {},
    ...(code === 'CREATOR_IPC_UNAVAILABLE'
      ? { nextAction: '确认 Cocos Creator 已打开并启用 Cocos AI Bridge 扩展后重试' }
      : {}),
    retryable: isRetryableCode(code)
  };
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function formatToolError(error: StructuredToolError): string {
  return [
    `${error.code}：${error.message}`,
    error.nextAction ? `下一步：${error.nextAction}` : null
  ].filter(Boolean).join('\n');
}

function isRetryableCode(code: string): boolean {
  return code === 'CREATOR_IPC_UNAVAILABLE'
    || code === 'CREATOR_CLIENT_NOT_READY'
    || code === 'CREATOR_IPC_REQUEST_TIMEOUT';
}
