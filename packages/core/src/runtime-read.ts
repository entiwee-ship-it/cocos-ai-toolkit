import { RuntimeNodeSnapshotSchema, type RuntimeNodeSnapshot } from '@cocos-ai/protocol';

/**
 * 运行态读取装配：把页面注入脚本返回的原始树装配为协议快照。
 * Schema 校验在此收口——页面返回的数据不可信，必须过协议。
 */

/**
 * 装配运行时节点快照。
 *
 * @param root 页面 readRuntimeHierarchy 返回的原始树（含 nodeCount/truncated 汇总键）。
 * @param previewSessionId 来源 Preview 会话 ID。
 * @param now 时间源（测试可注入）。
 * @returns 通过协议校验的运行时节点快照。
 */
export function assembleRuntimeNodeSnapshot(
  root: unknown,
  previewSessionId: string,
  now: () => Date = () => new Date()
): RuntimeNodeSnapshot {
  const record = root && typeof root === 'object' && !Array.isArray(root)
    ? root as Record<string, unknown>
    : {};
  const { nodeCount, truncated, ...rootNode } = record;
  return RuntimeNodeSnapshotSchema.parse({
    source: 'preview-runtime',
    previewSessionId,
    capturedAt: now().toISOString(),
    root: rootNode,
    ...(typeof nodeCount === 'number' ? { nodeCount } : {}),
    ...(truncated === true ? { truncated: true } : {})
  });
}
