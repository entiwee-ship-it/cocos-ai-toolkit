import { describe, expect, it } from 'vitest';
import { ProbeClientError } from '@cocos-ai/client';
import { normalizeToolError, toToolResult } from '../src/tool-result.js';

describe('MCP structured tool errors', () => {
  it('Probe 错误保留结构化字段并继续提供可读文本', async () => {
    const result = await toToolResult(Promise.reject(new ProbeClientError({
      code: 'PROBE_SERVER_UNAVAILABLE',
      message: 'Probe Server 当前不可用',
      details: { state: 'reconnecting', url: 'ws://127.0.0.1:32188' },
      nextAction: '等待自动恢复后重试',
      retryable: true
    })));

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'PROBE_SERVER_UNAVAILABLE',
          retryable: true,
          details: { state: 'reconnecting' }
        }
      }
    });
    expect(result.content[0].text).toContain('等待自动恢复后重试');
  });

  it('遗留 CODE:details 异常只在统一适配层提取稳定 code', () => {
    expect(normalizeToolError(new Error('NODE_NOT_FOUND:node-1'))).toMatchObject({
      code: 'NODE_NOT_FOUND',
      retryable: false
    });
  });

  it('成功值仍保留文本与 structuredContent 兼容结果', async () => {
    await expect(toToolResult(Promise.resolve({ ok: true }))).resolves.toMatchObject({
      structuredContent: { ok: true },
      content: [{ type: 'text', text: '{"ok":true}' }]
    });
  });
});
