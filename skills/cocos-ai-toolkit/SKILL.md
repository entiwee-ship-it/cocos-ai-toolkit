---
name: cocos-ai-toolkit
description: 当任务涉及 Cocos Creator 3.8.x 项目的场景/Prefab（预制体）查看或修改、UI 节点与组件调整、Inspector 属性读写、资产依赖分析、运行时 Preview 验证（截图、层级、控制台、输入派发、动画/过渡的逐帧采样）时使用。覆盖 Creator 项目的编辑器探针、事务式写入、声明式构建（design inspect/plan/preview/apply/verify）和 Preview 运行时工具。不用于纯脚本代码修改（直接改 .ts 源码文件时不需要本工具链）。
---

# Cocos AI Toolkit 使用技能

通过 MCP 工具（`cocos_*` 前缀）操作 Cocos Creator 编辑器和 Preview 运行时。本技能随 cocos-ai-toolkit 仓库分发；工具的权威细节见仓库 `README.md`。

## 架构与前置条件

链路：AI ↔ MCP Server（stdio）↔ Probe Server（默认 `ws://127.0.0.1:32188`）↔ Bridge 扩展（Cocos Creator 内）/ Preview 页面（Playwright）。

开工前按顺序确认：

1. `cocos_editor_list` 能列出目标编辑器实例。**列表为空 = Probe Server 没启动或 Creator 没加载 Bridge 扩展**，先让用户处理，不要硬试后续工具。
2. 后续所有编辑器侧调用都用第 1 步拿到的 `projectId`。
3. 运行时（Preview）工具需要先 `cocos_preview_launch` 拿到 `sessionId`；已有会话用 `cocos_preview_sessions` 查。

## 工具分组与使用时机

### 只读探针（先读再写，永远从读开始）

- `cocos_editor_state`：编辑器状态 + 当前文档身份（assetUuid/mode/dirty）。**写操作前先拿它确认打开的是哪个文档**。
- `cocos_document_snapshot`：当前文档分页快照（节点+组件+引用），大文档用 cursor 翻页。
- `cocos_component_schema`：单个组件的完整 Inspector Schema（属性、类型、引用、可见性）。
- `cocos_asset_search` / `cocos_asset_inspect`：按路径/类型搜资产；查单个资产的 Meta、依赖和反向使用者（改资产前评估影响面）。
- `cocos_project_scan` / `cocos_prefab_graph`：全项目只读扫描 / Prefab 引用图，产出授权报告，用于大范围分析。

### 事务式写入（改场景/Prefab 的唯一正确方式）

- 流程：`cocos_write_prepare`（带 revision 前置 + 幂等键）→ `cocos_write_confirm`（执行+保存+重读验证）→ 失败或存疑时 `cocos_transaction_rollback`；`cocos_transaction_status` / `cocos_transaction_list` 查状态。
- **纪律**：绝不绕过事务直接改；出现 `outcome-unknown` 或 `manual-recovery-required` 立即停手保留证据；revision 过期就重取快照重来，不要强行 confirm。
- 结构性/批量改动优先走声明式流程而不是逐条 write：`cocos_design_inspect` → `cocos_design_plan`（生成最小差异计划）→ `cocos_design_preview`（渲染影响面，不写入）→ `cocos_design_apply`（事务执行+逐项验证+失败回滚）→ `cocos_design_verify`（独立重读核对）。`cocos_design_export` 可把现有文档导出为可 round-trip 的声明式目标。

### Preview 运行时（验证"跑起来对不对"）

- 会话：`cocos_preview_launch`（指定分辨率）→ 用完 `cocos_preview_stop`。
- 读取：`cocos_runtime_get_hierarchy`（**优先用 `path` 查关键子树 + `includeInactive:false`，不要默认拉全树**，全树必截断）；`cocos_runtime_inspect_component`（组件属性包）；`cocos_runtime_get_console`（seq 游标增量拉日志，error 带堆栈）。
- 动作：`cocos_runtime_invoke_method`（白名单参数，可直接触发组件方法如过渡动画）；`cocos_runtime_dispatch_input`（画布 CSS 像素坐标点击/按键，**回执不代表游戏响应，必须后续断言验证**）；`cocos_runtime_instantiate_prefab`（运行时挂载，不写工程）。
- 取证：
  - `cocos_runtime_capture`：静态截图（支持多分辨率、裁剪、节点边界/锚点叠加）。**只能证明最终画面，不能证明动画过程**。
  - `cocos_runtime_sample_window`：**验证动画/过渡的首选**。单次调用内逐帧（或定间隔）采样组件属性，可先 `trigger` 触发方法，节点销毁记为 `nodeValid=false` 证据帧。220ms 级交叉淡化也能拿到逐帧时间线。
  - `cocos_runtime_watch_property`：等某个属性变化（server 轮询），适合等状态就位，不适合密集采样。
- 编排：`cocos_runtime_run_scenario` 把 launch/wait-node/assert-property/dispatch-input/assert-console/capture/assert-image-diff 编成步骤序列，产出逐项证据报告，适合回归验证。

## 取证纪律（真实项目踩坑总结）

1. **结构化数据为真值，截图为辅助证据**。说"验证过"必须有结构化断言（属性值、层级、控制台）支撑，不能只放截图。
2. 验证动画交接（如登录页→大厅）：用 `sample_window` 的 `trigger` 触发 + 逐帧采样，覆盖整个过渡窗口；"触发后再查返回 node-not-found"只能证明交接完成，证明不了过程。
3. 修复后复验要**重新取全套证据**，不能沿用修复前一轮的截图/快照。
4. 每次写操作后必须重读验证（design_apply 自带逐项验证；write_confirm 后手动 snapshot 核对关键属性）。

## 环境维护

- MCP Server 入口在 AI 客户端配置里固定指向某个构建产物路径（安装时确定）。仓库代码更新后：重新 `npm run build`（或你的部署脚本，如仓库自带的 `scripts/update-runtime.ps1`），然后**重启 AI 会话**加载新构建；Bridge 扩展（`packages/bridge-extension`）有变更时，还需在 Cocos Creator 中刷新/重启扩展。
- 如果你的部署用运行时 Worktree 分离（开发检出与 MCP 加载目录分离），不要直接改 MCP 加载目录里的代码，在开发检出里改并走更新流程。

## 常见排障

- `cocos_editor_list` 为空 → Probe Server 未运行或 Creator 未加载 Bridge；检查 Probe 端口与 Creator 扩展状态。
- Preview 工具报会话不存在 → 先 `cocos_preview_launch`；Preview 页面崩溃后重新 launch。
- 层级返回 `truncated:true` → 改用 `path` 查子树，或 `includeInactive:false` 过滤隐藏节点。
- 写事务 revision 冲突 → 文档已被改动，重新 snapshot 取最新 revision 再 prepare。
