import { describe, expect, it } from 'vitest';
import { CreatorClientError } from '@cocos-ai/client';
import { normalizeToolError, toToolResult } from '../src/tool-result.js';

describe('MCP structured tool errors', () => {
  it('Creator IPC 错误保留结构化字段并继续提供可读文本', async () => {
    const result = await toToolResult(Promise.reject(new CreatorClientError({
      code: 'CREATOR_IPC_UNAVAILABLE',
      message: 'Creator IPC 当前不可用',
      details: { state: 'ready', transport: 'named-pipe' },
      nextAction: '打开 Creator 后重试',
      retryable: true
    })));

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'CREATOR_IPC_UNAVAILABLE',
          retryable: true,
          details: { state: 'ready' }
        }
      }
    });
    expect(result.content[0].text).toContain('打开 Creator 后重试');
  });

  it('从本地 CODE:details 错误提取稳定 code', () => {
    expect(normalizeToolError(new Error('NODE_NOT_FOUND:node-1'))).toMatchObject({
      code: 'NODE_NOT_FOUND',
      retryable: false
    });
  });

  it('成功值同时返回人读文本与 structuredContent', async () => {
    await expect(toToolResult(Promise.resolve({ ok: true }))).resolves.toMatchObject({
      structuredContent: { ok: true },
      content: [{ type: 'text', text: '{"ok":true}' }]
    });
  });
});
