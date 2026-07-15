/** WebSocket 单条消息的默认最大接收字节数。 */
export const DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

/**
 * 解析 WebSocket 单条消息的有限接收上限。
 *
 * @param maxPayload 调用方显式配置的最大接收字节数；未提供时使用默认值。
 * @returns 可安全传给 ws 的正整数接收上限。
 */
export function resolveWebSocketMaxPayload(
  maxPayload = DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES
): number {
  if (!Number.isSafeInteger(maxPayload) || maxPayload <= 0) {
    throw new Error('INVALID_WEBSOCKET_MAX_PAYLOAD');
  }
  return maxPayload;
}
