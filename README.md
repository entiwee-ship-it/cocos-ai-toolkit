# Cocos AI Toolkit

这是一套专门供 AI 使用的 Cocos Creator 自动化工具。开发人员仍然使用 Creator 编辑器；AI 通过 MCP Server、受限 CLI、Probe Server 和项目内 Bridge 读取或执行操作，Cocos Creator 编辑器负责真正的 Scene、Prefab、节点、组件和保存语义。

0.3.0 起为**直写架构**：每个写工具映射为一到多个原子写操作（创建/删除节点、挂载组件、修改属性……），一次调用完成执行 + 自动保存 + 逐项重读回显。事务管理器、回滚、Revision 前置、声明式 diff 流水线和全量扫描已移除（0.2.x 文档见 `docs/`，归档保留）。

## 架构

```text
AI / Codex / Kimi Code
  -> stdio MCP Server（正式 AI 入口）/ cocos-ai-probe CLI（只读诊断入口）
  -> localhost Probe Server
  -> Creator 项目内 Bridge Extension
  -> Cocos Creator Editor / Scene / AssetDB
```

外部服务不直接修改 `.prefab`、`.scene` 或 `.meta`。所有 Cocos 语义写入都必须在 Creator 内执行。

## 环境要求

- Windows。
- Cocos Creator `3.8.8`。其它 `3.8.x` 小版本尚未完成兼容认证。
- Node.js `>=20.19 <26`；最终验证使用 `v25.9.0`。
- npm；最终验证使用 `11.4.1`。
- Git；写入类操作前建议保持工作区干净，git 是唯一的还原兜底（工具本身不提供回滚）。

Creator 3.8.x 的内部 API 可能随小版本变化。任何不是 3.8.8 的版本都不能凭版本号推测兼容。

## 安装与构建

在工具仓库根目录执行：

```powershell
npm install
npm test
npm run typecheck
npm run build
```

构建会生成 MCP Server、CLI、Probe Server、协议包、Core 运行时模块和 Bridge Extension 的 `dist/`。

## 安装 Bridge

```powershell
& scripts/install-bridge.ps1 `
  -ProjectPath 'E:/xile-workspace/qyProject/xy-client' `
  -ToolkitPath (Get-Location).Path
```

Bridge 使用 Junction 指向本工具的 `packages/bridge-extension`，不会复制代码到业务仓库。安装后用 Creator 3.8.8 打开目标项目，或在 Creator 中刷新扩展。

## 启动 Probe Server

在独立终端运行：

```powershell
& scripts/start-probe-server.ps1 -Port 32188 -ReportRoot 'reports'
```

默认只监听 `127.0.0.1:32188`。Bridge 会自动连接和重连；CLI/MCP 通过同一 WebSocket Server 选择目标编辑器实例。不要把 Probe Server 暴露到外网。

## 启动 AI 正式入口 MCP Server

先启动 Probe Server，并确保目标 Creator 3.8.8 已加载 Bridge。MCP Server 使用 stdio 与 AI 客户端通信：

```powershell
$env:COCOS_AI_PROBE_SERVER_URL = 'ws://127.0.0.1:32188'
$env:COCOS_AI_MCP_REPORT_ROOT = (Resolve-Path 'reports').Path
node packages/mcp-server/dist/run.js --enable-writes
```

环境变量：

- `COCOS_AI_PROBE_SERVER_URL`：Probe Server 地址，默认 `ws://127.0.0.1:32188`。
- `COCOS_AI_MCP_REPORT_ROOT`：MCP 进程唯一授权的报告根目录，默认当前工作目录下的 `reports`。

启动参数只有 `--enable-writes`：裸启动只注册只读工具；写工具必须显式开启，环境变量不能开启写能力。0.2.x 的 `--profile` 参数已移除，传入会报 `MCP_PROFILE_REMOVED`。

本机 Codex 可以用仓库脚本重复安装：

```powershell
& scripts/install-codex-mcp.ps1 -SkipBuild      # 默认开放写工具
& scripts/check-codex-mcp.ps1
& scripts/install-codex-mcp.ps1 -SkipBuild -Readonly   # 只读会话
& scripts/check-codex-mcp.ps1 -Readonly
```

安装脚本会先备份 `%USERPROFILE%/.codex/config.toml`，只替换名为 `cocos_ai` 的条目。健康检查会核对安装模式、精确工具集合、Toolkit/MCP/Bridge 版本和源码提交，再调用 `cocos_editor_list`。修改 MCP 配置后需要重启 Codex 或新建会话。

## MCP 工具面（完整写模式 30 个）

### 编辑态只读 5 个（默认开放）

| 工具 | 用途 |
| --- | --- |
| `cocos_editor_list` | 列出当前连接 Probe Server 的 Creator；唯一不要求 `projectId` 的全局入口 |
| `cocos_asset_search` | 在 AssetDB 索引中按文本搜索资产（找 Prefab/脚本 UUID），cursor 分页 |
| `cocos_hierarchy` | 读取当前文档节点树；`rootPath/query/fields/summary` 可返回无重复 raw 的紧凑结果 |
| `cocos_node_read` | 按 nodeUuid 或 path 读取节点详情；`fields/propertyPaths/summary` 可精确读取组件现值并缩小输出 |
| `cocos_prefab_open` | 通过 Creator 打开 Prefab 并等待文档身份就绪 |

### 编辑态直写 12 个（`--enable-writes` 才注册；每次写入自动保存并逐项重读回显）

| 工具 | 用途 |
| --- | --- |
| `cocos_node_create` | 在父节点（parentUuid 或 parentPath）下创建节点 |
| `cocos_node_set_transform` | 按 nodeUuid 或 path 修改局部 position/rotation/scale，未提供的分量保持不变 |
| `cocos_node_reparent` | 把现有节点迁移到新父节点并保存；源节点和新父节点分别支持 UUID/路径二选一，可选 siblingIndex |
| `cocos_node_delete` | 按 nodeUuid 或 path 删除节点及子树，不可回滚 |
| `cocos_component_add` | 在节点上挂载组件；自定义脚本组件必须提供 scriptUuid |
| `cocos_component_set_property` | 修改组件属性值；propertyPath 支持 `items[2]` 嵌套；expectedOldValue 不一致时拒绝写入 |
| `cocos_prefab_create` | 把当前文档中的节点生成为 Prefab 资产 |
| `cocos_prefab_save` | 保存当前文档（手工修改后的落盘入口） |
| `cocos_prefab_delete` | 按 UUID 删除 Prefab 资产；不可回滚且不检查引用 |
| `cocos_asset_import` | 把磁盘文件（图片/音频等）导入为项目资产并触发 AssetDB 导入 |
| `cocos_asset_refresh` | 重新导入资产并尝试触发 TypeScript 编译 |
| `cocos_batch_write` | 一次直发多项 `node.*` / `component.*` 操作；不接受 `asset.*` / `prefab.*`，只减少 MCP 往返，不是事务且无回滚，失败时 `executedOps` 之前的修改可能已生效 |

节点寻址同时接受 `nodeUuid` 或 `path`（如 `Root/Panel/Button`）；组件按类型解析，兼容 `cc.` 前缀（`Label` 与 `cc.Label` 等价）。写工具响应携带 `verification.items`（逐项期望值与重读实际值），重读不符会以 `DIRECT_WRITE_VERIFY_FAILED` 报错——Creator 静默不生效的写入不会被当成成功。

### 运行态 13 个（只读组默认开放，动作组需 `--enable-writes`）

`cocos_preview_launch/stop/sessions`、`cocos_runtime_get_hierarchy/inspect_component/get_console/watch_property/capture/invoke_method/sample_window/dispatch_input/instantiate_prefab/run_scenario`：启动 Preview 页面、读取运行时节点树/组件/Console、监听属性变化、Game 视图截图（多分辨率/裁剪/节点边界叠加）、调用组件方法、派发输入和运行时实例化 Prefab。Scenario 支持 `launch`、`wait-node`、`assert-property`、`dispatch-input`、`instantiate-prefab`、`assert-console`、`capture`、`assert-image-diff`、`stop`；`stop(always:true)` 会在前序步骤默认中止后仍执行清理。视觉结果仅作辅助证据。

典型编辑流程：`cocos_asset_search` 找 UUID → `cocos_prefab_open` 打开 → `cocos_hierarchy` 寻址 → `cocos_node_read` 看现值 → `cocos_component_set_property` / `cocos_node_create` / `cocos_component_add` 修改（自动保存+回显）→ 需要视觉确认时 `cocos_preview_launch` + `cocos_runtime_capture`。

## 更新运行时到最新代码

AI 客户端的 MCP 配置固定指向运行时 Worktree（默认 `E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0`）下的构建产物，入口路径不变。日常保持最新只需要在主仓库检出执行一次：

```powershell
& E:/xile-workspace/cocos-ai-toolkit/scripts/update-runtime.ps1
```

脚本依次完成：fetch 远程并让运行时 Worktree 以 detached HEAD 对齐 `origin/master`、依赖变化时 `npm install`、代码变化或产物缺失时全量 `npm run build`、重启 Probe Server 并等待端口就绪。它不会创建额外本地分支；运行时 Worktree 存在未提交的 tracked 改动时会中止，避免覆盖手工修改。

执行完后按提示生效：MCP Server 是 AI 客户端在会话启动时拉起的 stdio 进程，需要重启 Kimi Code / Codex 会话加载新构建；若 Bridge Extension 有变更，还需要在 Cocos Creator 中刷新/重启扩展。常用参数：`-SkipProbeRestart`、`-Force`、`-TargetRef`。

## 安装 AI 使用技能

仓库自带一份使用技能（`skills/cocos-ai-toolkit/SKILL.md`），告诉 AI 各工具什么时候用、写入纪律和排障方法：

```powershell
& scripts/install-skills.ps1 -Target kimi      # Kimi Code 用户级（默认）
& scripts/install-skills.ps1 -Target project   # 项目级 .agents/skills
```

默认用 Junction 挂接到仓库，仓库更新技能即更新；`-Copy` 改为复制，`-Force` 覆盖同名旧安装。

## CLI 命令（只读诊断入口）

```powershell
node packages/cli/dist/index.js editors
node packages/cli/dist/index.js state --project-id <project-id> --editor-instance-id <editor-id>
node packages/cli/dist/index.js assets --project-id <project-id> --editor-instance-id <editor-id> --pattern <text> [--uuid <asset-uuid>]
node packages/cli/dist/index.js open-asset --project-id <project-id> --editor-instance-id <editor-id> --uuid <asset-uuid>
node packages/cli/dist/index.js hierarchy --project-id <project-id> --editor-instance-id <editor-id> --depth 20
node packages/cli/dist/index.js node --project-id <project-id> --editor-instance-id <editor-id> --uuid <node-uuid>
node packages/cli/dist/index.js component --project-id <project-id> --editor-instance-id <editor-id> --uuid <component-uuid>
node packages/cli/dist/index.js prefab --project-id <project-id> --editor-instance-id <editor-id> --node-uuid <nested-prefab-node-uuid>
node packages/cli/dist/index.js asset-index --project-id <project-id> --editor-instance-id <editor-id>
node packages/cli/dist/index.js component-schema --project-id <project-id> --editor-instance-id <editor-id> --uuid <component-uuid>

# Preview 与运行时读取/动作
node packages/cli/dist/index.js preview-launch --project-id <project-id> [--resolution 720x1280]
node packages/cli/dist/index.js preview-sessions [--project-id <project-id>]
node packages/cli/dist/index.js preview-stop --session-id <session-id>
node packages/cli/dist/index.js runtime-hierarchy --session-id <session-id>
node packages/cli/dist/index.js runtime-component --session-id <session-id> --path <node-path> --component-type <type>
node packages/cli/dist/index.js runtime-console --session-id <session-id>
node packages/cli/dist/index.js runtime-capture --session-id <session-id>
node packages/cli/dist/index.js runtime-instantiate --session-id <session-id> --asset-uuid <prefab-uuid> --parent-path <node-path> [--x 0 --y 0]
```

CLI 只允许预定义命令，不提供任意 JavaScript 执行入口，写操作请使用 MCP 直写工具。0.2.x 的事务、声明式和扫描命令（`write-*`、`transaction-*`、`design-*`、`scan-project`、`prefab-graph`、`document-snapshot`）已移除。

## 运行期节点和组件 UUID

运行期节点和组件 UUID 在每次重新打开文档后都会变化，不能缓存到配置；稳定身份只有 Asset UUID + FileID + 节点路径。AI 应在每次编辑会话内通过 `cocos_hierarchy` / `cocos_node_read` 现取。

## 安全边界

- Bridge 仅连接 `127.0.0.1`。
- 不允许执行任意 JavaScript。
- 裸启动只暴露只读工具；写工具仅当显式 `--enable-writes` 启动时注册。
- **直写不提供事务和回滚**：每个写操作执行 + 自动保存 + 逐项重读即结束；失败即停，已生效的修改保留在文档中。误操作的还原手段是 git。
- 写后逐项重读是唯一生效性防线：Creator 对部分写入会静默不生效（如预制体编辑模式下嵌套实例内部），重读不符会显式报错。
- 外部进程不得直接写 `.prefab`、`.scene` 或 `.meta`。
- MCP 报告路径受服务端授权根约束，AI 不能提供绝对路径或越过根目录。
- Creator 3.8.x 小版本变化必须通过真实验证，不允许推测兼容；当前结论严格限定 3.8.8。

## 清理顺序

1. 保存或关闭本次 Creator 中需要保留的人工内容。
2. 停止 Probe Server。
3. 移除 Bridge Junction：

```powershell
& scripts/remove-bridge.ps1 `
  -ProjectPath '<目标项目路径>' `
  -ToolkitPath (Get-Location).Path
```

4. 复查业务项目 Git 状态。

## 历史归档

`docs/`（phase-0 ~ phase-5 findings、能力矩阵、可用性缺口报告、superpowers 计划）和统一验证脚本 `scripts/run-phase-0-validation.ps1`、`scripts/run-phase-1-readonly-validation.ps1`、`scripts/run-phase-2-write-validation.ps1` 为 0.2.x 事务架构的历史归档，保留供查阅；这些脚本依赖已移除的 CLI 命令，不再可运行。

## 详细结论

- [阶段 0 最终发现](docs/phase-0-findings.md)（归档）
- [阶段 1 最终发现](docs/phase-1-findings.md)（归档）
- [Creator 3.8.8 能力来源矩阵](docs/creator-3.8.8-capability-matrix.md)（归档）
- [使用手册（直写档）](docs/usage-playbook.md)
