import { describe, expect, it } from 'vitest';
import {
  RequestRouter,
  RequestRouterError,
  toServerErrorPayload
} from '../src/request-router.js';

describe('RequestRouter structured errors', () => {
  it('Bridge 失败载荷不经过字符串 JSON 包装并可直接转发给客户端', async () => {
    const router = new RequestRouter();
    const pending = router.wait('request-a', 1_000).catch((error: unknown) => error);
    const bridgePayload = {
      code: 'PROPERTY_READONLY',
      message: 'Creator 拒绝写入只读属性',
      details: { propertyPath: 'spriteFrame' },
      stage: 'apply',
      nextAction: '改用可写属性或移除该计划项'
    };

    router.complete('request-a', false, bridgePayload);
    const error = await pending;

    expect(error).toBeInstanceOf(RequestRouterError);
    expect((error as RequestRouterError).payload).toEqual(bridgePayload);
    expect(toServerErrorPayload(error)).toEqual(bridgePayload);
  });

  it('只读请求超时返回可重试错误并保留方法、请求和编辑器身份', async () => {
    const router = new RequestRouter();
    const error = await router.wait('request-read', 5, {
      method: 'probe.node',
      editorInstanceId: 'editor-1'
    }).catch((caught: unknown) => caught) as RequestRouterError;

    expect(error.payload).toMatchObject({
      code: 'SERVER_REQUEST_TIMEOUT',
      retryable: true,
      details: {
        requestId: 'request-read',
        method: 'probe.node',
        editorInstanceId: 'editor-1'
      }
    });
  });

  it('写请求超时继续返回 OUTCOME_UNKNOWN 并禁止盲重试', async () => {
    const router = new RequestRouter();
    const error = await router.wait('request-write', 5, {
      method: 'probe.directWrite',
      editorInstanceId: 'editor-1'
    }).catch((caught: unknown) => caught) as RequestRouterError;

    expect(error.payload).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      retryable: false,
      nextAction: expect.stringContaining('禁止重试')
    });
  });

  it('Server 遗留 CODE:details 异常在边界转换为稳定 code', () => {
    expect(toServerErrorPayload(new Error('RUNTIME_HIERARCHY_UNAVAILABLE:{"found":false}')))
      .toMatchObject({ code: 'RUNTIME_HIERARCHY_UNAVAILABLE' });
  });
});
