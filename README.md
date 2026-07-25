# Cocos AI Toolkit

这是一套专门供 AI 使用的 Cocos Creator 自动化工具。开发人员仍然使用 Creator 编辑器；AI 通过受限 CLI、Probe Server 和项目内 Bridge 读取或执行操作，Cocos Creator 编辑器负责真正的 Scene、Prefab、节点、组件、Undo 和保存语义。

阶段 0 已在真实游戏前端 `xy-client` 的隔离 Git Worktree 和 Cocos Creator 3.8.8 上完成验证，结论为 **GO**。阶段 1 已建立完整只读协议、CLI 和 AI 正式使用的 stdio MCP Server，并已在当前真实 `xy-client`（含未提交内容）上完成无污染全量只读验收扫描：375 个 Scene/Prefab 全部处理，节点、组件、属性、Override 解码率 100%，扫描前后真实项目 Git 状态逐字一致。阶段 1 收口复核结论为 **GO**（严格限定 Creator 3.8.8），详见 [阶段 1 最终发现](docs/phase-1-findings.md)。

## 架构

```text
AI / Codex
  -> stdio MCP Server（正式 AI 入口）/ cocos-ai-probe CLI（诊断入口）
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
- Git；建议在写入前记录当前状态，隔离 Worktree 为可选调试手段，不是日常使用前置条件。

Creator 3.8.x 的内部 API 可能随小版本变化。任何不是 3.8.8 的版本都必须先运行 `scripts/run-phase-0-validation.ps1`，不能只凭版本号判断兼容。

## 安装与构建

在工具仓库根目录执行：

```powershell
npm install
npm test
npm run typecheck
npm run build
```

构建会生成 MCP Server、CLI、Probe Server、协议包、Core 扫描器和 Bridge Extension 的 `dist/`。

## 可选：创建隔离游戏项目

需要做破坏性实验、批量回归或验证新写能力时，可以创建隔离 Worktree：

```powershell
& scripts/create-xy-client-worktree.ps1 `
  -SourceRepo 'E:/xile-workspace/qyProject/xy-client' `
  -WorktreePath 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' `
  -BranchName 'codex/cocos-ai-probe'
```

脚本会拒绝覆盖既有目录，并要求目标位于 `E:/xile-workspace/worktrees`。

## 安装 Bridge

```powershell
& scripts/install-bridge.ps1 `
  -ProjectPath 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' `
  -ToolkitPath (Get-Location).Path
```

Bridge 使用 Junction 指向本工具的 `packages/bridge-extension`，不会复制代码到业务仓库。安装后用 Creator 3.8.x 打开隔离项目，或刷新扩展：

```powershell
& 'C:/ProgramData/cocos/editors/Creator/3.8.8/CocosCreator.exe' `
  --project 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' `
  --can-show-upgrade-dialog false
```

日常开发可以直接给真实项目安装 Bridge 并执行事务写入。Revision、重读验证和回滚由工具内部负责；只有出现 `outcome-unknown` 或 `manual-recovery-required` 时才停止后续写入并保留证据。

## 启动 Probe Server

在独立终端运行：

```powershell
& scripts/start-probe-server.ps1 -Port 32188 -ReportRoot 'reports'
```

默认只监听 `127.0.0.1:32188`。Bridge 会自动连接和重连；CLI 通过同一 WebSocket Server 选择目标编辑器实例。
Server 在真实监听成功后会向 stdout 输出 `probe-server.ready` JSON。统一验证脚本会等待该事件，而不是依赖固定延时。已经执行过 `npm run build` 时可传 `-SkipBuild`，该参数不会在构建产物缺失时静默启动旧代码。

如需非默认地址，给 Bridge 和 CLI 设置同一个 `COCOS_AI_PROBE_SERVER_URL`。不要把阶段 0 Server 暴露到外网。

## 启动 AI 正式入口 MCP Server

先启动 Probe Server，并确保目标 Creator 3.8.8 已加载 Bridge。MCP Server 使用 stdio 与 AI 客户端通信，使用 WebSocket 与 Probe Server 通信：

```powershell
$env:COCOS_AI_PROBE_SERVER_URL = 'ws://127.0.0.1:32188'
$env:COCOS_AI_MCP_REPORT_ROOT = (Resolve-Path 'reports').Path
node packages/mcp-server/dist/run.js
```

环境变量：

- `COCOS_AI_PROBE_SERVER_URL`：Probe Server 地址，默认 `ws://127.0.0.1:32188`。
- `COCOS_AI_MCP_REPORT_ROOT`：MCP 进程唯一授权的报告根目录，默认当前工作目录下的 `reports`。

AI 客户端配置 MCP 命令时，应直接执行 `node <工具仓库绝对路径>/packages/mcp-server/dist/run.js`，并通过环境变量固定上述地址和报告根。stdout 专用于 MCP 协议；启动和关闭错误只写 stderr。

本机 Codex 可以用仓库脚本重复安装。默认直接开放写工具：

```powershell
& scripts/install-codex-mcp.ps1 -SkipBuild
& scripts/check-codex-mcp.ps1

# 只有明确需要只读会话时才传：
& scripts/install-codex-mcp.ps1 -SkipBuild -Readonly
& scripts/check-codex-mcp.ps1 -Readonly
```

安装脚本会先备份 `%USERPROFILE%/.codex/config.toml`，只替换名为 `cocos_ai` 的条目。默认附加 `--enable-writes`；传 `-Readonly` 才关闭写工具。健康检查会核对安装模式、Probe 端口、实际启动 stdio MCP、列出工具并调用 `cocos_editor_list`。修改 MCP 配置后需要重启 Codex 或新建会话。

## 更新运行时到最新代码

AI 客户端的 MCP 配置固定指向运行时 Worktree（默认 `E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0`）下的构建产物，入口路径不变。日常保持最新只需要在主仓库检出执行一次：

```powershell
& E:/xile-workspace/cocos-ai-toolkit/scripts/update-runtime.ps1
```

脚本会依次完成：fetch 远程并把运行时 Worktree 的本地 `runtime` 分支重置到 `origin/master`、依赖清单变化时执行 `npm install`、代码变化或产物缺失时执行全量 `npm run build`、重启 Probe Server 并等待端口就绪。运行时 Worktree 存在未提交的 tracked 改动时会中止，避免覆盖手工修改。

执行完后按提示生效：MCP Server 是 AI 客户端在会话启动时拉起的 stdio 进程，需要重启 Kimi Code / Codex 会话加载新构建；若 Bridge Extension 有变更，还需要在 Cocos Creator 中刷新/重启扩展。常用参数：`-SkipProbeRestart` 只同步代码和构建不重启 Probe，`-Force` 强制重新安装依赖和构建，`-TargetRef` 可指定同步到其它远程引用。

MCP 默认注册以下十七个只读工具：

| 工具 | 用途 |
| --- | --- |
| `cocos_editor_list` | 列出全部已连接 Creator 实例；唯一不要求 `projectId` 的全局入口 |
| `cocos_editor_state` | 读取并校验指定编辑器状态 |
| `cocos_asset_search` | 搜索完整 AssetDB 索引并分页返回资产 |
| `cocos_asset_inspect` | 读取单资产详情、可选原始 Meta、依赖和反向使用者 |
| `cocos_component_schema` | 读取默认或自定义组件的完整 Schema、脚本 UUID/路径和可选原始 Dump |
| `cocos_document_snapshot` | 读取当前文档的摘要或完整 Creator 分页快照 |
| `cocos_prefab_graph` | 扫描项目、落盘完整 Prefab 图，并分页返回节点和边 |
| `cocos_project_scan` | 执行可断点续扫的完整项目只读扫描并分页返回文档摘要 |
| `cocos_design_inspect` | 读取当前文档或指定子树的声明式结构、组件、Override 和风险摘要 |
| `cocos_design_plan` | 对比当前文档与目标文档，生成最小差异和有序计划 |
| `cocos_design_preview` | 渲染逐项操作、Override、影响面和风险，零执行 |
| `cocos_preview_sessions` | 列出工具管理的 Preview 页面会话 |
| `cocos_runtime_get_hierarchy` | 读取 Preview 运行时整树或指定 `path` 子树，可排除 inactive 子树 |
| `cocos_runtime_inspect_component` | 读取运行时组件属性包 |
| `cocos_runtime_get_console` | 按游标和级别读取运行时 Console |
| `cocos_runtime_watch_property` | 有界监听运行时属性变化 |
| `cocos_runtime_capture` | 截图、裁剪及节点边界/锚点叠加 |

编辑态工具除 `cocos_editor_list` 外都必须传 `projectId`；同一项目连接多个 Creator 实例时还必须传 `editorInstanceId`，工具不会按“最近连接”隐式选择。Preview 与运行时工具使用 `sessionId` 绑定工具自行启动的页面会话。

`cocos_project_scan` 和 `cocos_prefab_graph` 的完整报告与 checkpoint 只会写入 `COCOS_AI_MCP_REPORT_ROOT`。AI 只能传相对 `.json` 路径；绝对路径、盘符、UNC、完整 `..` 分段、目录、符号链接和越界 Junction 都会在任何 Creator 请求前被拒绝。MCP 响应只包含摘要、有界页和不透明 cursor，不会把完整项目报告一次塞进 AI 上下文。cursor 翻页读取已落盘报告，不会重新打开 Creator 资产。

MCP Server 裸启动仍保持只读；Codex 安装脚本默认为开发环境附加 `--enable-writes`。事务写工具、Preview 启停、运行时动作和 `cocos_design_apply/verify/export` 在该参数存在时注册：

```powershell
node packages/mcp-server/dist/run.js --enable-writes
```

门控运行时工具包括 `cocos_preview_launch`、`cocos_preview_stop`、`cocos_runtime_invoke_method`、`cocos_runtime_sample_window`、`cocos_runtime_dispatch_input`、`cocos_runtime_instantiate_prefab` 和 `cocos_runtime_run_scenario`。当前 Preview 通道由 Probe Server 自行启动外部 Chrome/Edge 页面；运行时 Prefab 实例化只改页面内存，不写工程文件。apply 与运行时动作标注为破坏性；verify/export 虽然只读，但与 apply 共用门控。声明式与运行时 MCP 调用都会写入报告根下的审计日志。

`cocos_runtime_sample_window` 在单次页面执行内完成整个采样窗口，适合验证 220ms 一类容易被跨进程轮询错过的短过渡。它支持逐帧或固定间隔采样、采样前安全调用一个组件方法，并在节点中途销毁后保留 `nodeValid: false` 的证据帧：

```json
{
  "sessionId": "<preview-session-id>",
  "path": "Scene/Canvas/login",
  "componentType": "LoginView",
  "properties": ["opacity", "state.progress"],
  "mode": "perFrame",
  "durationMs": 220,
  "trigger": { "method": "startTransition", "args": [] }
}
```

固定间隔模式把 `mode` 改为 `{ "intervalMs": 20 }`。异步 trigger 不会阻塞首帧采样；窗口结束时仍未完成则 `trigger.pending` 为 `true`。`properties` 最多 20 项，`durationMs` 最大 55000；高刷新率下样本超过 3600 条时结果带 `truncated: true`。

## 选择编辑器和准备样本

先查询当前连接实例：

```powershell
node packages/cli/dist/index.js editors
```

记录目标实例返回的 `projectId` 和 `editorInstanceId`，并核对 `projectPath` 是本次准备操作的真实项目或可选 Worktree。

统一验证前，在 Creator 中打开目标 Prefab。也可以先确认目标 UUID 已被 AssetDB 识别，再调用：

```powershell
node packages/cli/dist/index.js assets --project-id <project-id> --editor-instance-id <editor-id> --pattern ClubView --uuid <prefab-asset-uuid>
node packages/cli/dist/index.js open-asset --project-id <project-id> --editor-instance-id <editor-id> --uuid <prefab-asset-uuid>
node packages/cli/dist/index.js hierarchy --project-id <project-id> --editor-instance-id <editor-id> --depth 20
```

运行期节点和组件 UUID 在每次重新打开 Prefab 后都会变化，不能缓存到配置：

- `SampleNodeUuid`：当前 hierarchy 中目标节点的 `identity.objectUuid`。
- `SampleComponentUuid`：该节点 `components[].value` 中的自定义组件 UUID。
- `NestedPrefabNodeUuid`：嵌套 Prefab 实例节点的 `identity.objectUuid`。
- `TestPrefabUuid`：稳定的 Prefab Asset UUID。

## CLI 命令

```powershell
# 已连接编辑器
node packages/cli/dist/index.js editors

# 编辑器状态
node packages/cli/dist/index.js state --project-id <project-id> --editor-instance-id <editor-id>

# 资产列表、详情、Meta、依赖和反向使用者
node packages/cli/dist/index.js assets --project-id <project-id> --editor-instance-id <editor-id> --pattern <text> [--uuid <asset-uuid>]

# 打开资产
node packages/cli/dist/index.js open-asset --project-id <project-id> --editor-instance-id <editor-id> --uuid <asset-uuid>

# 层级、节点、组件和 Prefab 来源
node packages/cli/dist/index.js hierarchy --project-id <project-id> --editor-instance-id <editor-id> --depth 20
node packages/cli/dist/index.js node --project-id <project-id> --editor-instance-id <editor-id> --uuid <node-uuid>
node packages/cli/dist/index.js component --project-id <project-id> --editor-instance-id <editor-id> --uuid <component-uuid>
node packages/cli/dist/index.js prefab --project-id <project-id> --editor-instance-id <editor-id> --node-uuid <nested-prefab-node-uuid>

# 阶段 1 完整资产索引和组件 Schema
node packages/cli/dist/index.js asset-index --project-id <project-id> --editor-instance-id <editor-id>
node packages/cli/dist/index.js component-schema --project-id <project-id> --editor-instance-id <editor-id> --uuid <component-uuid>

# 当前文档分页快照
node packages/cli/dist/index.js document-snapshot --project-id <project-id> --editor-instance-id <editor-id> --mode full --page-size 100

# 本地聚合 Prefab 图
node packages/cli/dist/index.js prefab-graph --project-id <project-id> --editor-instance-id <editor-id>

# 项目全量只读扫描；报告和 checkpoint 只能落在显式 report-root 内
node packages/cli/dist/index.js scan-project `
  --project-id <project-id> `
  --editor-instance-id <editor-id> `
  --report-root 'reports' `
  --report 'phase-1/project-scan.json'

# 阶段四声明式 inspect / plan / preview / apply / verify / export
node packages/cli/dist/index.js design-inspect --project-id <project-id> [--root-uuid <node-uuid>]
node packages/cli/dist/index.js design-plan --project-id <project-id> --target '<target-json>'
node packages/cli/dist/index.js design-preview --project-id <project-id> --target '<target-json>'
node packages/cli/dist/index.js design-apply --project-id <project-id> --target '<target-json>' [--execution-id <id>] [--revision '<revision-json>']
node packages/cli/dist/index.js design-verify --project-id <project-id> --target '<target-json>'
node packages/cli/dist/index.js design-export --project-id <project-id> [--root-uuid <node-uuid>] [--scope current-document|source-prefab|apply-to-source] [--asset-uuid <uuid>]

# 阶段五 Preview 与运行时读取/动作
node packages/cli/dist/index.js preview-launch --project-id <project-id> [--resolution 720x1280]
node packages/cli/dist/index.js preview-sessions [--project-id <project-id>]
node packages/cli/dist/index.js runtime-hierarchy --session-id <session-id>
node packages/cli/dist/index.js runtime-component --session-id <session-id> --path <node-path> --component-type <type>
node packages/cli/dist/index.js runtime-console --session-id <session-id>
node packages/cli/dist/index.js runtime-capture --session-id <session-id>
node packages/cli/dist/index.js runtime-instantiate --session-id <session-id> --asset-uuid <prefab-uuid> --parent-path <node-path> [--x 0 --y 0]
node packages/cli/dist/index.js preview-stop --session-id <session-id>
```

CLI 只允许预定义命令，不提供任意 JavaScript 执行入口。

## 阶段 2 事务式写入命令

写命令走事务管理器：每个事务必须携带 `transactionId`、幂等键和 Revision 前置；
`scope` 只允许 `current-document`（`source-prefab`/`apply-to-source` 属阶段 3，直接拒绝）。

```powershell
# 准备写事务（--request 为符合写事务协议的 JSON）
node packages/cli/dist/index.js write-prepare `
  --project-id <project-id> `
  --editor-instance-id <editor-id> `
  --request '{"transactionId":"tx-1","idempotencyKey":"key-1","scope":"current-document","revision":{"document":null,"hierarchy":null,"assetDatabase":null,"scriptCompilation":null},"operations":[{"type":"node.rename","nodeUuid":"n1","name":"NewName"}],"save":true,"undoGroup":"rename-node"}'

# 确认执行 / 查询状态 / 只列未完成事务 / 回滚
node packages/cli/dist/index.js write-confirm --project-id <project-id> --transaction-id tx-1
node packages/cli/dist/index.js transaction-status --project-id <project-id> --transaction-id tx-1
node packages/cli/dist/index.js transaction-list --project-id <project-id>
node packages/cli/dist/index.js transaction-rollback --project-id <project-id> --transaction-id tx-1
```

- 相同幂等键重试返回原事务状态（带 `duplicateOf`），不会重复写入。
- Revision 前置不一致返回 `REVISION_CONFLICT` 及冲突明细；执行超时标记 `outcome-unknown`，禁止盲目重试。
- 写事务审计落盘到 `<报告根>/write-journal/<transactionId>.jsonl`（JSONL，含调用来源、参数、验证结果和状态历史）；CLI 默认报告根为 `reports`，可用 `COCOS_AI_REPORT_ROOT` 覆盖。

MCP 写工具（`cocos_write_prepare` 等五个和 `cocos_design_apply`）以及阶段四门控只读工具
（`cocos_design_verify`、`cocos_design_export`）默认不注册，仅当 MCP Server 以显式
`--enable-writes` 启动时开放；环境变量无法开启。响应按协议 Schema 校验，声明式调用和写事务均写入审计。

## 运行统一 Phase 0 验证

Creator 已打开目标 Prefab、Probe Server 已连接后执行：

```powershell
& scripts/run-phase-0-validation.ps1 `
  -ProjectId '<project-id>' `
  -EditorInstanceId '<editor-id>' `
  -SampleNodeUuid '<current-node-uuid>' `
  -SampleComponentUuid '<current-custom-component-uuid>' `
  -NestedPrefabNodeUuid '<current-nested-prefab-node-uuid>' `
  -TestPrefabUuid '<stable-prefab-asset-uuid>'
```

脚本会：

1. 记录真实项目和隔离项目的验证前 Git 状态。
2. 执行 `npm test`、`npm run typecheck`、`npm run build`。
3. 验证 `editors`、`state`、`assets`、`hierarchy`、`node`、`component`、`prefab`。
4. 以目标 UUID 的 `query-asset-info` 成功作为 AssetDB 条件等待，不使用固定启动延时。
5. 执行 `prepare -> confirm -> status`，验证 `rolled-back`、`cc.UITransform`、Position 和 Creator Undo。
6. 复查层级中不存在探针节点，Prefab SHA-256 与基线一致。
7. 比较两个游戏项目的前后 Git 状态，允许既有改动，但不允许验证新增任何改动。

每次运行使用唯一报告前缀，失败时停止后续步骤并保留已经生成的证据。`reports/*.json` 默认不提交。

## 运行统一 Phase 1 只读验证
先给目标项目安装 Bridge，并用 Cocos Creator 3.8.8 打开项目。统一脚本会自动按 `projectPath` 选择 Creator 实例，从资产索引选择 Scene/Prefab 和自定义组件样本，不需要人工提供或缓存业务 UUID：

```powershell
& scripts/run-phase-1-readonly-validation.ps1 `
  -ProjectPath 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' `
  -ReportRoot 'reports'
```

脚本固定执行静态检查、Bridge 连接、完整资产索引、样本文档全分页快照、自定义组件 Schema、Prefab 图、项目全量扫描、报告 Schema 和 Git 状态前后对比。当前认证严格限定 Creator 3.8.8；其它 3.8.x 必须先单独完成兼容认证。

验证包含一次有意的 Probe Server 中断。脚本只会终止经监听端口、仓库入口路径和进程命令行共同确认的目标 Node 进程，不会按端口盲目结束其它程序。中断前会复制一个已经有部分进度的扫描 checkpoint；Server 重启、同一 Creator Bridge 重连后，再用同一路径和同一 `scanId` 续扫。

每次运行使用唯一 `phase-1-<run-id>` 前缀，JSON 证据通过 `FileMode.CreateNew` 创建，失败时不会覆盖旧报告。中断链路至少留下以下独立证据：

- `*-server-interrupt-before.json`：中断前请求和 checkpoint 身份。
- `*-server-interrupt-error.json`：Server 停止期间的 CLI JSON 错误。
- `*-server-interrupt-reconnect.json`：Server Ready 和编辑器重连结果。
- `*-server-interrupt-recovery.json`：汇总 `beforeInterruptionRequest`、`cliInterruptionError`、`editorReconnect` 和 `resumeCheckpointResult`。

脚本启动前如果 Server 已在运行，验证会有意终止它，并按当前 `Port`、`ReportRoot` 和工具仓库构建产物启动替代实例；不保留原 PID 或自定义环境变量。如果端口原本没有 Server，验证结束后会清理脚本启动的进程。因此只能使用专用验证 Server 和端口，运行期间不要让其它任务共用。

## 运行统一 Phase 2 写入验证

先给**隔离项目**安装 Bridge，并用 Cocos Creator 3.8.8 打开隔离项目。脚本必须用 `pwsh`（7+）启动，禁止 Windows PowerShell 5.1：

```powershell
pwsh -NoProfile -File scripts/run-phase-2-write-validation.ps1 `
  -ProjectPath 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' `
  -ReportRoot 'reports'
```

脚本固定执行：静态检查、Bridge 连接与写能力检查、只读基线快照、三组事务写入（T1 节点原子写、T2 组件原子写、T3 自定义脚本挂载守卫）、保存与重读验证（`committed` 必须 `verification.passed=true`）、整事务回滚（T3→T2→T1，每次要求 `rollbackEvidence.verifiedClean=true`）、回滚后层级复查干净、Probe Server 中断恢复证据，以及工具仓库和隔离项目 Git 状态前后逐字对比。

中断链路在 `*-write-interrupt-recovery.json` 独立落证：`beforeInterruptionRequest`、`cliInterruptionError`、`editorReconnect`、`statusAfterReconnect`、`finalStatus` 和 `rollback`。重连后事务只可能是 `validated`（补执行再回滚）或 `outcome-unknown`（禁止续写直接回滚）两种已验证路径。

每次运行使用唯一 `phase-2-<run-id>` 前缀，证据经 `FileMode.CreateNew` 创建；事务审计同时写入 `reports/write-journal/<transactionId>.jsonl`。

## 安全边界

- Bridge 仅连接 `127.0.0.1`。
- 不允许执行任意 JavaScript。
- MCP Server 裸启动只暴露十七个只读工具；Codex 安装脚本默认显式传入 `--enable-writes`，`-Readonly` 可切回只读。
- 真实项目可直接写入，不强制隔离 Worktree。Revision、事务状态、保存重读和回滚验证仍保留，避免把失败或未知结局当成成功。
- 外部进程不得直接写 `.prefab`、`.scene` 或 `.meta`。
- Scene、Undo、保存和恢复全部由 Creator 执行；外部只读磁盘计算指纹。
- `prepare` 拒绝 Dirty 文档、已有同名探针和错误项目路径。
- `confirm` 拒绝 Revision 冲突、过期事务和错误事务身份。
- 无法结构化的数据必须保留原始 Dump 并明确进入缺口分类。
- MCP 报告路径受服务端授权根约束，AI 不能提供绝对路径或越过根目录。
- Creator 3.8.x 小版本变化必须通过真实统一验证，不允许推测兼容；当前结论严格限定 3.8.8。

## 清理顺序

1. 如果启动过事务，先用 `probe-undo-save-status` 确认不是 `executing`、`outcome-unknown` 或 `manual-recovery-required`。
2. 保存或关闭本次 Creator 中需要保留的人工内容；如果使用了隔离 Worktree，再停止对应 Creator。
3. 停止 Probe Server。
4. 移除 Bridge Junction：

```powershell
& scripts/remove-bridge.ps1 `
  -ProjectPath 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' `
  -ToolkitPath (Get-Location).Path
```

5. 复查真实项目和隔离项目状态：

```powershell
git -C 'E:/xile-workspace/qyProject/xy-client' status --short --branch
git -C 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' status --short --branch
```

6. 阶段 1 将立即继续时保留 Worktree。确实不再需要时，先理解并处理其中的既有改动，再由源仓库执行：

```powershell
git -C 'E:/xile-workspace/qyProject/xy-client' worktree remove 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe'
```

禁止手工递归删除 Worktree，也不要为绕过未确认改动而直接使用 `--force`。

## 详细结论

- [阶段 0 最终发现](docs/phase-0-findings.md)
- [阶段 1 最终发现](docs/phase-1-findings.md)
- [Creator 3.8.8 能力来源矩阵](docs/creator-3.8.8-capability-matrix.md)
- [xy-client 样本选择](docs/xy-client-sample-selection.md)
