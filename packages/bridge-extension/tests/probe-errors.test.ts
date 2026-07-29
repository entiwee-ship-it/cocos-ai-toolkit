import { describe, expect, it } from 'vitest';
import { ProbeError, toProbeErrorPayload } from '../src/probe-errors.js';

describe('Probe error payload', () => {
  it('保留稳定 code、Creator 原始 message 和结构化 details', () => {
    const payload = toProbeErrorPayload(new ProbeError(
      'PROPERTY_READONLY',
      { propertyPath: 'spriteFrame', creatorMessage: 'The property is readonly' },
      'Creator 拒绝写入只读属性'
    ));

    expect(payload).toEqual({
      code: 'PROPERTY_READONLY',
      message: 'Creator 拒绝写入只读属性',
      details: { propertyPath: 'spriteFrame', creatorMessage: 'The property is readonly' }
    });
  });

  it('普通异常不再把原始错误文本冒充稳定错误码', () => {
    expect(toProbeErrorPayload(new Error('Editor.Message request failed'))).toEqual({
      code: 'BRIDGE_HANDLER_FAILED',
      message: 'Editor.Message request failed',
      details: {}
    });
  });
});
