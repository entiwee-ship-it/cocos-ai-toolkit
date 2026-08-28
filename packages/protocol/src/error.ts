/** 从遗留 `CODE:details` 文本中提取稳定错误码；新代码应直接传结构化 code。 */
export function readStableErrorCode(message: string, fallback: string): string {
  return /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(message)?.[1] ?? fallback;
}
