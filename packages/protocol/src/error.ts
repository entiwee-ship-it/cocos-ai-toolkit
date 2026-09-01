/** 从当前内部 `CODE:details` 错误文本中提取稳定错误码。 */
export function readStableErrorCode(message: string, fallback: string): string {
  return /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(message)?.[1] ?? fallback;
}
