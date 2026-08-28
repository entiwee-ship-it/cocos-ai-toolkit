import { describe, expect, it } from 'vitest';
import { readStableErrorCode } from '../src/error.js';

describe('structured error compatibility', () => {
  it('只在协议兼容边界解析遗留 CODE:details 文本', () => {
    expect(readStableErrorCode('NODE_NOT_FOUND:node-1', 'FALLBACK')).toBe('NODE_NOT_FOUND');
    expect(readStableErrorCode('普通错误', 'FALLBACK')).toBe('FALLBACK');
  });
});
