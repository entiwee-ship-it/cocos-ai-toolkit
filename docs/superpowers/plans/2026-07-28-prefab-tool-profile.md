# Prefab Tool Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 默认只向 AI Agent 暴露 7 个 Prefab 场景工具，同时通过 `full` profile 原样保留 33 个底层工具。

**Architecture:** 新建独立 `prefab-tools.ts` 组合现有只读、声明式和事务服务；`server.ts` 只负责按 profile 注册对应工具面。启动脚本解析 profile，安装、健康检查、README 和技能统一使用同一默认值。

**Tech Stack:** TypeScript、Zod、Model Context Protocol SDK、Vitest、PowerShell。

---

### Task 1: Profile 契约

**Files:**
- Modify: `packages/mcp-server/tests/run.test.ts`
- Modify: `packages/mcp-server/tests/tools.test.ts`
- Modify: `packages/mcp-server/tests/runtime-tools.test.ts`
- Modify: `packages/mcp-server/src/run.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] 在 `run.test.ts` 先断言缺省 profile 为 `prefab`，`--profile=full` 和 `--profile full` 解析为 `full`，未知 profile 抛出 `MCP_PROFILE_INVALID`。
- [ ] 在 `tools.test.ts` 先断言默认写入档精确注册 7 个工具、默认只读档精确注册 4 个工具、`full` 写入档仍精确注册 33 个工具。
- [ ] 运行 `npm test -- packages/mcp-server/tests/run.test.ts packages/mcp-server/tests/tools.test.ts`，确认因 profile 尚未实现而失败。
- [ ] 在 `server.ts` 增加 `CocosMcpToolProfile`、高层工具名常量和 profile 分支；旧工具测试 harness 显式使用 `profile: 'full'`。
- [ ] 在 `run.ts` 增加严格 profile 参数解析，并传给 `createCocosMcpServer`。
- [ ] 重跑定向测试，确认 profile 契约通过。

### Task 2: Prefab 只读门面

**Files:**
- Create: `packages/mcp-server/src/prefab-tools.ts`
- Create: `packages/mcp-server/tests/prefab-tools.test.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] 先写 search 测试：底层结果同时含 scene 与 prefab 时只返回 prefab，cursor 分页稳定。
- [ ] 先写 inspect 测试：按 `asset inspect -> open -> editor state -> document snapshot` 顺序调用，并拒绝非 Prefab。
- [ ] 先写 verify 测试：自动打开 UUID 后构造固定 `current-document` target 并返回独立验证报告。
- [ ] 运行 `npm test -- packages/mcp-server/tests/prefab-tools.test.ts`，确认工具缺失导致 RED。
- [ ] 实现 `CocosPrefabToolService` 的搜索聚合、Prefab 类型门禁、打开就绪轮询、结构 inspect 与 verify。
- [ ] 注册 `cocos_prefab_search`、`cocos_prefab_inspect`、`cocos_prefab_verify`，并标记只读 annotations。
- [ ] 重跑定向测试，确认只读门面通过。

### Task 3: Prefab 写门面

**Files:**
- Modify: `packages/mcp-server/src/prefab-tools.ts`
- Modify: `packages/mcp-server/tests/prefab-tools.test.ts`

- [ ] 先写 edit 测试：`preview` 不写入；`apply` 的调用顺序必须是 open、preview、apply、verify，任一验证失败不得返回成功。
- [ ] 先写 create 测试：非法 asset URL/rootId 在 Probe 写请求前拒绝；apply 使用声明式节点分辨率执行 `prefab.create_from_node`。
- [ ] 先写 delete 测试：缺少精确 URL 确认、存在 users 但未确认影响时拒绝；apply 只执行 `prefab.delete_asset` 并确认资产消失。
- [ ] 运行定向测试，确认写门面缺失导致 RED。
- [ ] 实现 `mode: preview | apply`，所有 apply 路径内部先执行 preview。
- [ ] 实现 revision 捕获、prepare/confirm 状态门禁、创建失败的已提交设计事务逆序回滚。
- [ ] 实现删除全量引用收集、精确确认、不可回滚 annotations 与删除后 AssetDB 验证。
- [ ] 重跑定向测试，确认写门面通过。

### Task 4: 分发与技能

**Files:**
- Modify: `scripts/install-codex-mcp.ps1`
- Modify: `scripts/check-codex-mcp.ps1`
- Modify: `scripts/check-codex-mcp.mjs`
- Modify: `scripts/codex-install.test.ts`
- Modify: `README.md`
- Modify: `skills/cocos-ai-toolkit/SKILL.md`
- Create: `scripts/skill-contract.test.ts`

- [ ] 先写安装测试，断言默认配置包含 `--profile=prefab`，`-Profile full` 可选，健康检查向 stdio 子进程传入同一 profile。
- [ ] 先写技能契约测试，断言技能只列 7 个高层工具、明确禁止手写 `.prefab/.scene/.meta` JSON，并把 full 限定为排障入口。
- [ ] 运行 `npm test -- scripts/codex-install.test.ts scripts/skill-contract.test.ts`，确认 RED。
- [ ] 更新安装和健康检查脚本，按 profile 核对精确工具名称与数量。
- [ ] 重写 README 的日常工作流和工具表，把 33 个底层工具移入 full 调试说明。
- [ ] 精简技能为场景路由、preview/apply 纪律、删除确认和 full 排障边界。
- [ ] 重跑定向测试，确认分发契约通过。

### Task 5: 全量验证与发布

**Files:**
- Verify all modified files

- [ ] 运行 `npm test`，预期全部测试通过且无失败。
- [ ] 运行 `npm run typecheck`，预期退出码 0。
- [ ] 运行 `npm run build`，预期退出码 0。
- [ ] 在 Creator 与 Probe 在线时运行 `npm run codex:check`，预期 prefab 写入档工具数为 7 且 `cocos_editor_list` 成功。
- [ ] 运行 `git diff --check` 和 `git status --short --branch`，确认无空白错误且只包含本任务文件。
- [ ] 用中文提交信息提交实现并推送 `origin/master`。
- [ ] 在保留 `reports/mcp/` 等未跟踪证据的前提下，把 runtime worktree 快进到新提交并重建运行时。
