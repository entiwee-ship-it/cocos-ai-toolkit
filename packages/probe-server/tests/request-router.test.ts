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
});
