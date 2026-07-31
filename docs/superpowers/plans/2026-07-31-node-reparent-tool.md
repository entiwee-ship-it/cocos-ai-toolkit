# Cocos Node Reparent Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cocos AI Toolkit 0.3.1 增加受约束、写后回读的 `cocos_node_reparent` 公共 MCP 工具。

**Architecture:** 复用现有 direct-tools 的项目选择、节点路径解析和 `probe.directWrite` 调用，只新增 MCP schema/handler。Bridge 已支持 `node.reparent`，本次不修改协议和执行器。

**Tech Stack:** TypeScript、MCP SDK、Vitest、Cocos Creator Bridge 0.3.1。

---

### Task 1: 固定工具注册和请求负载合同

**Files:**
- Modify: `E:/xile-workspace/cocos-ai-toolkit/packages/mcp-server/tests/direct-tools.test.ts`

- [x] **Step 1: 写工具注册失败测试**

在写模式的 `registerDirectTools` 用例中增加：

```ts
expect(registeredNames).toContain('cocos_node_reparent');
```

并在只读模式用例增加：

```ts
expect(registeredNames).not.toContain('cocos_node_reparent');
```

- [x] **Step 2: 写 UUID 请求负载失败测试**

调用 `cocos_node_reparent`：

```ts
await callTool('cocos_node_reparent', {
  projectId: 'project-1',
  nodeUuid: 'child-uuid',
  newParentUuid: 'parent-uuid',
  siblingIndex: 2,
});
```

断言 Probe 收到：

```ts
expect(request).toMatchObject({
  method: 'probe.directWrite',
  params: {
    operations: [{
      type: 'node.reparent',
      nodeUuid: 'child-uuid',
      newParentUuid: 'parent-uuid',
      siblingIndex: 2,
    }],
  },
});
```

- [x] **Step 3: 写路径解析和参数互斥失败测试**

路径用例传 `path` 与 `newParentPath`，模拟层级解析到两个 UUID；错误用例分别同时提供/都不提供两组寻址参数，并传 `siblingIndex: -1`，断言 handler 在发送写请求前拒绝。

- [x] **Step 4: 运行测试确认预期失败**

Run: `npx vitest run packages/mcp-server/tests/direct-tools.test.ts`

Expected: FAIL，首个失败为未注册 `cocos_node_reparent`。

### Task 2: 实现最小 MCP 包装

**Files:**
- Modify: `E:/xile-workspace/cocos-ai-toolkit/packages/mcp-server/src/direct-tools.ts`
- Test: `E:/xile-workspace/cocos-ai-toolkit/packages/mcp-server/tests/direct-tools.test.ts`

- [x] **Step 1: 定义输入 schema**

在现有节点写工具附近增加：

```ts
const nodeReparentInput = z.object({
  projectId: z.string().min(1),
  editorInstanceId: z.string().min(1).optional(),
  nodeUuid: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  newParentUuid: z.string().min(1).optional(),
  newParentPath: z.string().min(1).optional(),
  siblingIndex: z.number().int().nonnegative().optional(),
}).superRefine((value, context) => {
  if (Number(Boolean(value.nodeUuid)) + Number(Boolean(value.path)) !== 1) {
    context.addIssue({ code: 'custom', message: 'nodeUuid 或 path 必须且只能提供一个' });
  }
  if (Number(Boolean(value.newParentUuid)) + Number(Boolean(value.newParentPath)) !== 1) {
    context.addIssue({ code: 'custom', message: 'newParentUuid 或 newParentPath 必须且只能提供一个' });
  }
});
```

- [x] **Step 2: 注册 handler 并转发原子操作**

复用当前 direct-tools 中的路径解析和 `probe.directWrite` helper，形成唯一操作：

```ts
const operation = {
  type: 'node.reparent' as const,
  nodeUuid: resolvedNodeUuid,
  newParentUuid: resolvedParentUuid,
  ...(input.siblingIndex === undefined ? {} : { siblingIndex: input.siblingIndex }),
};
```

工具说明必须注明迁移保留节点身份、直写自动保存、失败即停。

- [x] **Step 3: 运行定向测试确认通过**

Run: `npx vitest run packages/mcp-server/tests/direct-tools.test.ts`

Expected: PASS。

### Task 3: 更新工具清单和运行时验收

**Files:**
- Modify: `E:/xile-workspace/cocos-ai-toolkit/README.md`
- Modify: `E:/xile-workspace/cocos-ai-toolkit/skills/cocos-ai-toolkit/SKILL.md`
- Modify if count is hard-coded: `E:/xile-workspace/cocos-ai-toolkit/scripts/check-codex-mcp.ps1`

- [x] **Step 1: 更新工具数和文档**

把 MCP 工具面从 27 更新到 28，在直写工具表与技能意图表中加入：

```text
cocos_node_reparent：把现有节点迁移到新父节点，可选 siblingIndex；源节点和父节点分别支持 UUID/路径二选一。
```

- [x] **Step 2: 运行完整验证**

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 全部退出 0，完整测试无新增警告。

- [ ] **Step 3: 提交 Toolkit 实现**

```powershell
git add -- packages/mcp-server/src/direct-tools.ts packages/mcp-server/tests/direct-tools.test.ts README.md skills/cocos-ai-toolkit/SKILL.md scripts/check-codex-mcp.ps1 docs/superpowers/plans/2026-07-31-node-reparent-tool.md
git commit -m "功能：增加节点迁移直写工具"
```

不暂存 `reports/mcp/`。

- [ ] **Step 4: 同步固定运行时**

```powershell
& E:/xile-workspace/cocos-ai-toolkit/scripts/update-runtime.ps1
& E:/xile-workspace/cocos-ai-toolkit/scripts/check-codex-mcp.ps1
```

Expected: 健康检查显示源码提交、MCP 与 Bridge 均为 0.3.1、`toolCount: 28`。版本常量已同步，Creator 需要刷新或重启 Bridge，Codex MCP 需要用户重启后加载第 28 个工具。
