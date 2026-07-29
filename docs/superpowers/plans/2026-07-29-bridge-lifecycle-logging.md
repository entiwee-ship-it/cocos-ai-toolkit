# Bridge Lifecycle Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cocos Creator 控制台输出可验证 Bridge 真实加载、连接、握手、重连和卸载状态的低噪声生命周期日志。

**Architecture:** `BridgeClient` 通过可选生命周期回调暴露传输事件，并识别 Probe Server 的 `bridge.hello` 确认；`main.ts` 把事件格式化为固定前缀和单行 JSON。日志不改变现有协议处理、重试策略或写入能力。

**Tech Stack:** TypeScript、ws、Vitest、Cocos Creator 3.8.8 Extension API。

---

### Task 1: BridgeClient 生命周期事件

**Files:**
- Modify: `packages/bridge-extension/src/bridge-client.ts`
- Test: `packages/bridge-extension/tests/bridge-client.test.ts`

- [x] 新增失败测试：本地 WebSocket Server 接收 hello 并确认后，事件顺序包含 `connecting/socket-open/hello-sent/ready`。
- [x] 新增失败测试：连接关闭后输出 `disconnected/retry-scheduled`，`dispose()` 输出 `disposed` 且不再重连。
- [x] 运行 `npm test -- packages/bridge-extension/tests/bridge-client.test.ts`，确认因生命周期回调缺失而 RED。
- [x] 为 `BridgeClientOptions` 增加可选 `onLifecycleEvent`，实现握手响应识别和现有重试节点事件。
- [x] 重跑定向测试，确认 GREEN。

### Task 2: Creator 控制台日志与版本升级

**Files:**
- Modify: `packages/bridge-extension/src/main.ts`
- Create: `packages/bridge-extension/tests/main-lifecycle-logging.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/*/package.json`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `scripts/check-codex-mcp.mjs`

- [x] 新增失败测试：`main.ts` 使用 `[CocosAI][Bridge]` 输出 `LOAD_START`，并把 BridgeClient 生命周期事件转为单行日志。
- [x] 运行定向测试，确认日志入口缺失而 RED。
- [x] 实现统一日志函数；加载日志包含版本、Creator、项目、PID、Probe URL、能力数量，卸载输出 `UNLOAD`。
- [x] 将所有包、内部依赖、Bridge、MCP 和健康检查统一升级为 `0.2.3`，运行版本一致性测试。
- [x] 重跑 Bridge 定向测试，确认 GREEN。

### Task 3: 构建与真实运行时验收

**Files:**
- Evidence only: `reports/mcp/0.2.3-live/`

- [x] 运行 `npm test`、`npm run typecheck`、`npm run build` 和 `git diff --check`。
- [ ] 用户手动刷新或重启 Creator，确认控制台出现 `[CocosAI][Bridge] READY` 和 `version=0.2.3`。
- [ ] 运行 `npm run codex:check`，确认 MCP 与 Bridge 运行时版本均为 `0.2.3`。
- [ ] 重跑 Prefab Override apply/revert 即时验收，确认不切换文档即可回到源值且覆盖数量为零。
- [ ] 显式暂存本任务和原计划文件，排除 `reports/mcp/`，中文提交并推送 `master`。

### Task 4: 中文控制台日志

**Files:**
- Modify: `packages/bridge-extension/src/main.ts`
- Modify: `packages/bridge-extension/tests/main-lifecycle-logging.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/*/package.json`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `scripts/check-codex-mcp.mjs`

- [x] 将日志行为测试改为要求中文事件名称和中文 JSON 字段，并将版本一致性测试目标改为 `0.2.4`。
- [x] 运行定向测试，确认英文日志和 `0.2.3` 版本导致 RED。
- [x] 实现中文事件及字段映射，统一升级到 `0.2.4`。
- [x] 重跑定向测试、全量测试、类型检查、构建和差异检查。
- [ ] 用户刷新或重启 Creator 后，运行 `npm run codex:check` 并确认控制台出现中文初始化完成日志。
