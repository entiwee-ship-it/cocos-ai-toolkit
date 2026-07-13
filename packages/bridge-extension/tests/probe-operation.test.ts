import { describe, expect, it } from 'vitest';
import { validateProbeOperation } from '../src/probe-operation.js';

describe('validateProbeOperation', () => {
  it('只允许隔离 Worktree 和固定探针名称', () => {
    expect(validateProbeOperation({
      projectPath: 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',
      documentAssetUuid: 'asset-1', expectedNodeUuid: 'new-node', probeName: 'CocosAiProbe_123'
    }).probeName).toBe('CocosAiProbe_123');
    expect(() => validateProbeOperation({
      projectPath: 'E:/xile-workspace/qyProject/xy-client',
      documentAssetUuid: 'asset-1', expectedNodeUuid: 'new-node', probeName: 'CocosAiProbe_123'
    })).toThrow('PROBE_PROJECT_NOT_ISOLATED');
    expect(() => validateProbeOperation({
      projectPath: 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',
      documentAssetUuid: 'asset-1', expectedNodeUuid: 'new-node', probeName: 'DangerousNode'
    })).toThrow('INVALID_PROBE_NAME');
  });
});
