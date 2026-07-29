# MCP Usability Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整修复 `docs/2026-07-27-mcp-usability-gap-report.md` 尚未完成的五类真实使用缺口，并以统一 `0.2.0` 版本发布可识别的新运行时。

**Architecture:** 保持 Creator Bridge 是唯一资产与文档写入引擎。MCP 高层工具负责目标资产编排、结构化错误和预览验证，协议层描述数组引用与 Prefab Override，Bridge 事务层执行并记录阶段化结果；所有新行为先由失败测试锁定，再实现最小生产代码。

**Tech Stack:** TypeScript、Zod、Model Context Protocol SDK、Vitest、Cocos Creator 3.8.8 Editor.Message、PowerShell。

---

### Task 1: 收口 Prefab 场景工具档

**Files:**
- Modify: `packages/mcp-server/src/run.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Create: `packages/mcp-server/src/prefab-tools.ts`
- Test: `packages/mcp-server/tests/profile.test.ts`
- Test: `packages/mcp-server/tests/prefab-tools.test.ts`
- Test: `scripts/codex-install.test.ts`
- Test: `scripts/skill-contract.test.ts`

- [x] 先用工具集合、启动参数、安装脚本和技能合同测试固定 `prefab`/`full` profile。
- [x] 运行定向测试并观察 profile 与高层工具缺失导致的 RED。
- [x] 实现默认 7/4 个 Prefab 工具与兼容 33 个 full 工具。
- [x] 运行定向测试，确认 7 个测试文件、78 个测试通过。

### Task 2: 自动定位目标文档并返回可用 Revision

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Test: `packages/mcp-server/tests/tools.test.ts`

- [x] 新增失败测试：`source-prefab` 目标未打开时调用 `probe.openAsset`，轮询直到 `editor.state.document.assetUuid` 与目标一致。
- [x] 新增失败测试：`current-document` 目标身份不一致时返回 `TARGET_DOCUMENT_NOT_OPEN`，错误包含目标 UUID/路径和下一步动作。
- [x] 新增失败测试：`cocos_design_preview` 调用 `probe.writeRevision` 并返回可直接传给 apply 的完整 `revision`。
- [x] 运行 `npm test -- packages/mcp-server/tests/tools.test.ts`，确认三类行为均因缺失而 RED。
- [x] 在 `readDesignContext()` 前加入目标文档解析、自动打开和有界就绪等待；preview 捕获并输出 `RevisionPrecondition`。
- [x] 重跑定向测试，确认 GREEN。

### Task 3: 透传结构化错误与事务阶段

**Files:**
- Modify: `packages/protocol/src/write.ts`
- Modify: `packages/bridge-extension/src/transaction-manager.ts`
- Modify: `packages/probe-server/src/request-router.ts`
- Modify: `packages/probe-server/src/server.ts`
- Modify: `packages/client/src/client.ts`
- Modify: `packages/mcp-server/src/run.ts`
- Test: `packages/bridge-extension/tests/transaction-manager.test.ts`
- Test: `packages/probe-server/tests/request-router.test.ts`
- Test: `packages/probe-server/tests/server.test.ts`
- Test: `packages/client/tests/client.test.ts`

- [x] 新增失败测试：Bridge 的 `code/details/message` 经 Probe Server 和 Client 后保持结构不丢失。
- [x] 新增失败测试：事务状态记录 `plan/prepare/apply/save/verify` 阶段、输入摘要、原始错误和 `nextAction`。
- [x] 新增失败测试：超时错误返回当前阶段而不是裸 `Request timed out`。
- [x] 逐层实现结构化错误序列化/反序列化；保持旧字符串错误兼容。
- [x] 将写入默认超时提高到 180 秒，并让事务阶段信息进入 MCP 错误输出。
- [x] 重跑各层定向测试，确认 GREEN。

### Task 4: 数组引用与嵌套属性写入

**Files:**
- Modify: `packages/protocol/src/design.ts`
- Modify: `packages/protocol/src/transaction.ts`
- Modify: `packages/core/src/design-diff.ts`
- Modify: `packages/core/src/design-plan.ts`
- Modify: `packages/core/src/design-apply.ts`
- Modify: `packages/bridge-extension/src/write-creator-deps.ts`
- Modify: `packages/bridge-extension/src/write-verifier.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Test: `packages/protocol/tests/transaction.test.ts`
- Test: `packages/core/tests/design-diff.test.ts`
- Test: `packages/core/tests/design-apply.test.ts`
- Test: `packages/bridge-extension/tests/write-verifier.test.ts`

- [x] 新增失败测试：`references[path]` 接受引用数组，diff/plan 生成单个数组引用写操作。
- [x] 新增失败测试：运行时值解析递归处理数组和嵌套 ccclass 对象中的 Node/Component/Asset 引用。
- [x] 新增失败测试：verify 对引用数组逐项比较类型、UUID 和顺序。
- [x] 新增能力矩阵测试：Enum 数值、嵌套对象数组和常用内置/自定义组件属性可 roundtrip。
- [x] 扩展协议和递归值解析，保持单引用输入向后兼容。
- [x] 重跑协议、Core、Bridge 定向测试，确认 GREEN。

### Task 5: 资产操作与子树抽取

**Files:**
- Modify: `packages/protocol/src/transaction.ts`
- Modify: `packages/bridge-extension/src/prefab-writer.ts`
- Modify: `packages/bridge-extension/src/write-creator-deps.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Test: `packages/bridge-extension/tests/prefab-writer.test.ts`
- Test: `packages/mcp-server/tests/tools.test.ts`

- [x] 新增失败测试：AssetDB `move-asset`、`delete-asset`、`save-asset-meta` 均通过 Bridge 事务执行并验证身份。
- [x] 新增失败测试：`document.extract_subtree` 物化为 `prefab.create_from_node`，原位置由 Creator 自动转换为实例。
- [x] 新增失败测试：不存在、覆盖、UUID 漂移和不可逆删除均返回可行动门禁错误。
- [x] 实现 `cocos_asset_create/delete/move/write_meta` 及设计层 `document.extract_subtree`；禁止空 Prefab JSON 模板路径。
- [x] 重跑 Bridge/MCP 定向测试，确认 GREEN。

### Task 6: 嵌套 Prefab Override 语义

**Files:**
- Modify: `packages/protocol/src/transaction.ts`
- Modify: `packages/core/src/design-plan.ts`
- Modify: `packages/core/src/design-apply.ts`
- Modify: `packages/bridge-extension/src/prefab-writer.ts`
- Modify: `packages/bridge-extension/src/write-verifier.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Test: `packages/core/tests/design-plan.test.ts`
- Test: `packages/core/tests/design-apply.test.ts`
- Test: `packages/bridge-extension/tests/prefab-writer.test.ts`

- [x] 新增失败测试：实例内部 nodePath 生成 `prefab.instance_override`，不再退化为静默无效的普通 set-property。
- [x] 新增失败测试：`prefab.revert_override` 精确移除目标属性覆盖并重读验证。
- [x] 使用 Creator 3.8.8 的 `PrefabInstance.propertyOverrides`、`TargetInfo` 和 `PropertyOverrideInfo` 构造/移除覆盖记录。
- [x] 让 `design_inspect` 输出实例根与内部路径的稳定寻址信息。
- [x] 重跑 Core/Bridge/MCP 定向测试，确认 GREEN。

### Task 7: 写后预览验证与使用手册

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/runtime-tools.ts`
- Create: `docs/usage-playbook.md`
- Test: `packages/mcp-server/tests/tools.test.ts`
- Test: `packages/mcp-server/tests/runtime-tools.test.ts`

- [x] 新增失败测试：`design_apply.verifyPreview` 在提交成功后执行 scenario，失败时保留已提交事实并返回验证报告。
- [x] 复用 `runtime.run_scenario` 编排 wait-node/assert-property/capture，不复制运行时驱动。
- [x] 文档覆盖新建界面、拆分子树、嵌套实例、数组绑定、Enum 五个端到端场景及错误码下一步动作。
- [x] 重跑 MCP 定向测试，确认 GREEN。

### Task 8: 统一版本、发布门禁与真实验收

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/*/package.json`
- Modify: `packages/bridge-extension/src/main.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `scripts/check-codex-mcp.mjs`
- Create: `scripts/version-consistency.test.ts`

- [ ] 先新增失败测试：根包、所有 workspace、Bridge 握手、MCP 握手和健康检查版本必须一致，且相对 `origin/master` 已变化。
- [ ] 统一升级为 `0.2.0`，健康检查输出明确安装版本和源码提交。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm run build`、`git diff --check`。
- [ ] 在真实 Creator 3.8.8 / xy-client 上按报告六条验收标准执行；不直接写 `.prefab/.scene/.meta`。
- [ ] 再次 `git fetch origin master`，确认本地可快进且没有远端新提交。
- [ ] 只暂存本任务文件，中文提交并推送 `master`；每次 push 前版本检查必须通过。
- [ ] 将 detached runtime 对齐新提交，重建并运行 `npm run codex:check`，保留 `reports/mcp/` 与历史 recovery patch。
