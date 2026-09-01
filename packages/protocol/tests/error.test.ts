import { describe, expect, it } from 'vitest';
import { readStableErrorCode } from '../src/error.js';

describe('error code extraction', () => {
  it('从内部 CODE:details 文本读取稳定 code', () => {
    expect(readStableErrorCode('NODE_NOT_FOUND:node-1', 'FALLBACK')).toBe('NODE_NOT_FOUND');
    expect(readStableErrorCode('普通错误', 'FALLBACK')).toBe('FALLBACK');
  });
});
