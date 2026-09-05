# Cocos AI Toolkit

这是一套专门供 AI 使用的 Cocos Creator 自动化工具。开发人员仍然使用 Creator 编辑器；AI 通过 MCP Server、受限 CLI 和项目内 Bridge 读取或执行操作，Cocos Creator 编辑器负责真正的 Scene、Prefab、节点、组件和保存语义。

当前版本为 `0.9.1`，提供 42 个公开 MCP 工具：编辑态写入按调用独立执行、自动保存并逐项重读验证；运行态工具负责 Preview、交互采样和视觉证据。

## 架构

```text
AI / Codex / Kimi Code
  -> stdio MCP Server（正式 AI 入口）/ cocos-ai CLI（诊断入口）
  -> Windows Named Pipe（每次调用建立短连接）
  -> Creator 项目内 Bridge Extension（进程内端点）
  -> Cocos Creator Editor / Scene / AssetDB
```

外部服务不直接修改 `.prefab`、`.scene` 或 `.meta` JSON 内容，这些序列化内容的语义写入必须在 Creator 内执行。删除边界单独处理：只有 `.prefab` 必须经过 Creator/MCP；非 Prefab 资源文件可以直接通过文件系统删除，无需 Creator/MCP，同时删除同名 `.meta` 文件（如存在）。这是整文件删除，不是手改 `.meta` JSON。

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

构建会生成 MCP Server、CLI、协议包、Core 运行时模块和 Bridge Extension 的 `dist/`。

## 安装 Bridge

```powershell

& scripts/install-bridge.ps1 `
  -ProjectPath 'E:/xile-workspace/worktrees/cocos-ai-blank/Cocos-ai' `
  -ToolkitPath 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0'
```

Bridge 使用 Junction 指向运行时 Worktree 的 `packages/bridge-extension`，不会复制代码。默认只允许隔离 Worktree；已经明确授权保存项目时才传 `-AllowSavedProject`。安装后用 Creator 3.8.8 打开目标项目，或在 Creator 中刷新扩展。

## Creator 本机直连与工具管理面板

Bridge Extension 加载时会在 Creator 进程内创建 Windows Named Pipe，并在当前用户的本地数据目录登记端点。MCP/CLI 每次工具调用建立一次短连接，返回结果后立即关闭；不监听 TCP 端口，不启动独立后台服务，也没有 WebSocket 心跳或重连状态机。

在 Creator 顶部菜单选择 **Cocos AI → 打开工具管理**，会打开独立管理窗口，可以直接查看扩展版本、发布日期、构建指纹、项目身份、Named Pipe 状态、Scene/AssetDB、当前文档和 Preview 状态。窗口内也可以刷新状态或打开 Creator 扩展管理器。

管理窗口提供“运行状态”和“工具列表”两个切换页。“工具列表”由 Bridge 返回当前版本的完整 MCP 工具目录，按编辑器、资源、节点与组件、Prefab 与文档、Preview 与运行态分组，并标出只读、编辑器操作和潜在删除风险。

通常无需配置端点目录。只有隔离测试需要覆盖时才使用 `COCOS_AI_ENDPOINT_ROOT`。运行态截图由当前 MCP 进程管理并写入 `reports/runtime-captures`。

## 启动 AI 正式入口 MCP Server

确保目标 Creator 3.8.8 已加载 Bridge。MCP Server 使用 stdio 与 AI 客户端通信：

```powershell
node packages/mcp-server/dist/run.js
```

环境变量：

- `COCOS_AI_ENDPOINT_ROOT`：可选 Creator 端点描述目录，通常无需配置。
- `COCOS_AI_IPC_TIMEOUT_MS`：可选单次 Creator IPC 请求超时，默认 180000 毫秒。

MCP Server 不再使用工具开关；裸启动即注册全部工具。启动参数必须为空，其它参数以稳定错误拒绝。

本机 Codex 可以用仓库脚本重复安装：

```powershell
& scripts/install-codex-mcp.ps1 -SkipBuild
& scripts/check-codex-mcp.ps1
```

升级到 0.9.1 后重新运行一次安装脚本，Codex 配置会移除旧的工具开关参数；此版本不再接受 `--enable-writes` 或 `-Readonly`，启动 MCP 即公开全部工具。

安装脚本默认把 Codex MCP 指向固定运行 Worktree。健康检查会核对安装模式、精确工具集合、Creator 在线状态、Bridge 版本、Bridge 内容构建指纹、精确 capability 集合和项目 Bridge Junction 目标。修改 MCP 配置后需要重启 Codex 或新建会话。

## MCP 工具面（全部公开 42 个）

### 编辑态只读 11 个（默认开放）

| 工具 | 用途 |
| --- | --- |
| `cocos_editor_list` | 列出当前可通过 Named Pipe 访问的 Creator；唯一不要求 `projectId` 的全局入口 |
| `cocos_editor_state` | 读取当前文档 UUID、dirty、Scene/AssetDB ready、选择和 Preview 状态 |
| `cocos_extension_manager_open` | 直接打开目标 Creator 的内置扩展管理器，不修改项目或扩展启用状态 |
| `cocos_tool_manager_open` | 直接打开目标 Creator 中的 Cocos AI 工具管理面板 |
| `cocos_asset_search` | Bridge 内大小写无关包含搜索，短缓存复用全量索引；Bridge 只返回当前结果页，MCP cursor 仅编码分页位置和 revision |
| `cocos_asset_inspect` | 按 UUID 直接读取资产详情、Meta、依赖和反向使用者 |
| `cocos_hierarchy` | 读取当前文档节点树；默认返回紧凑结构并省略递归 `raw`，深层 `rootPath` 原生读取目标子树并保留 `truncated`；`query/fields/summary` 可进一步投影，明确 `compact=false` 才请求完整 raw |
| `cocos_node_read` | 读取单节点、`prefabInstance`、`writeCapabilities` 和可选编辑态 bounds；默认省略节点/组件结构 raw，`fields/propertyPaths/summary` 可进一步投影，明确 `compact=false` 才请求完整 raw |
| `cocos_nodes_read` | 批量读取最多 32 个 UUID/path，逐项返回 found/error；内部节点与寻址层级均走紧凑响应并限制输出预算 |
| `cocos_prefab_open` | 当前文档 clean 时通过 Creator 打开 Prefab 并等待身份就绪；dirty 时返回 `DOCUMENT_SAVE_REQUIRED` 且不切换 |
| `cocos_scene_open` | 当前文档 clean 时通过 Creator 打开 Scene 并等待身份就绪；dirty 时返回 `DOCUMENT_SAVE_REQUIRED` 且不切换 |

节点和层级读取默认走紧凑结果。明确请求 `compact=false` 的完整 raw 如果超出 Bridge 预算，会自动降级为紧凑结果并返回 `output.compacted=true`；不要对 `PROBE_OUTPUT_TOO_LARGE` 反复重试同一请求。

### 编辑态动作与直写 18 个（默认公开；序列化写入自动保存并逐项重读回显）

| 工具 | 用途 |
| --- | --- |
| `cocos_node_create` | 在父节点（parentUuid 或 parentPath）下创建节点 |
| `cocos_node_rename` | 按 nodeUuid 或 path 重命名节点并保存回读 |
| `cocos_node_set_transform` | 按 nodeUuid 或 path 修改局部 position/rotation/scale，未提供的分量保持不变 |
| `cocos_node_select` | 清空旧节点选择并单选目标；只改变编辑器选择状态，不保存文档 |
| `cocos_node_reparent` | 把现有节点迁移到新父节点并保存；源节点和新父节点分别支持 UUID/路径二选一，可选 siblingIndex |
| `cocos_node_delete` | 按 nodeUuid 或 path 删除节点及子树，不可回滚 |
| `cocos_component_add` | 在节点上挂载组件；自定义脚本组件必须提供 scriptUuid |
| `cocos_component_set_property` | 修改组件属性值或绑定 Inspector 事件；支持 `items[2]` 嵌套和 `Component.EventHandler[]`，expectedOldValue 不一致时拒绝写入 |
| `cocos_prefab_instantiate` | 在父节点下实例化 Prefab；支持 parentUuid/parentPath，保存重开后返回稳定实例身份 |
| `cocos_prefab_unpack` | 按节点移除 Prefab 关联；current 仅移除当前关联，complete 递归移除嵌套关联，源资产 UUID 必须精确匹配 |
| `cocos_prefab_create` | 把当前文档节点生成为 Prefab，自动保存、重开并在 dirty 时补保存，再验证重建实例、资产身份和 clean 状态 |
| `cocos_prefab_rename` | 按 UUID 在原目录内重命名 Prefab，通过 Creator AssetDB 保持 UUID 并拒绝覆盖 |
| `cocos_document_save` | 保存当前 Prefab 或 Scene 文档，并重读确认 dirty 已清除 |
| `cocos_prefab_delete` | 按 UUID 删除 Prefab 资产；不可回滚，必须精确确认 URL，存在反向引用时需二次确认 |
| `cocos_asset_manage` | 通过 Creator AssetDB 移动、重命名或删除资源；删除必须精确确认 URL，存在反向引用时需要二次确认 |
| `cocos_asset_import` | 把磁盘文件（图片/音频等）导入为项目资产并触发 AssetDB 导入 |
| `cocos_asset_refresh` | 重新导入资产并尝试触发 TypeScript 编译 |
| `cocos_batch_write` | 一次直发多项 `node.*` / `component.*` 操作；不接受 `asset.*` / `prefab.*`，只减少 MCP 往返；失败时 `executedOps` 之前的修改可能已生效 |

组件事件默认直接写入 Prefab/Scene 的 Inspector 事件数组：按钮使用 `Button.clickEvents`，Toggle 状态变化使用 `Toggle.checkEvents`，其它组件使用自身公开的 EventHandler 数组。事件元素用 `Component.EventHandler` 的 `target/component/handler/customEventData` 描述；`component` 是精确 `@ccclass` 注册名。只有动态创建或回收的节点、运行时才能确定的目标，或没有可序列化事件口的底层手势/全局事件才使用 `node.on(...)`；不要为静态按钮生成 `onLoad/start + node.on/off` 转发代码。

节点寻址严格要求 `nodeUuid` 或 `path` 二选一（如 `Root/Panel/Button`）；组件类型接受有无 `cc.` 前缀的写法（`Label` 与 `cc.Label` 等价）。写工具响应携带 `verification.items`（逐项期望值与重读实际值），重读不符会以 `DIRECT_WRITE_VERIFY_FAILED` 报错——Creator 静默不生效的写入不会被当成成功。`cocos_prefab_create` 会在直写重开后检查 dirty，必要时自动补一次保存，再确认 `dirty=false`；仍未清除才返回 `DOCUMENT_DIRTY_AFTER_PREFAB_CREATE`。`cocos_document_save` 同样以 `DOCUMENT_DIRTY_AFTER_SAVE` 拒绝伪成功。`DIRECT_WRITE_OUTCOME_UNKNOWN` 表示操作已经执行但保存或验证结局未知，必须先重读状态，确认前禁止重试。直写失败即停，已执行修改不会自动恢复。

`writeCapabilities` 会在写入前说明当前文档能否直接修改该节点。Prefab 编辑模式下，嵌套实例内容的已知无效写入会以 `NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT` 拒绝，并返回 `cocos_prefab_open` 的源 Prefab 路由；工具不会自动切换文档。文档身份暂不可判定时保持放行，继续由保存后的逐项重读验证兜底。

### 运行态 13 个（默认公开；动作工具仍执行运行态校验）

`cocos_preview_launch/stop/sessions`、`cocos_runtime_get_hierarchy/inspect_component/get_console/watch_property/capture/invoke_method/sample_window/dispatch_input/instantiate_prefab/run_scenario`：启动 Preview 页面、读取运行时节点树/组件/Console、监听属性变化、Game 视图截图（多分辨率/裁剪/节点边界叠加）、调用组件方法、派发输入和运行时实例化 Prefab。Scenario 支持 `launch`、`wait-node`、`assert-property`、`dispatch-input`、`instantiate-prefab`、`assert-console`、`capture`、`assert-image-diff`、`stop`；`stop(always:true)` 会在前序步骤默认中止后仍执行清理。视觉结果仅作辅助证据。

典型编辑流程：`cocos_editor_state` 确认当前文档；若 dirty，先用 `cocos_document_save` 确认已清除 → `cocos_asset_search` 找 UUID → `cocos_asset_inspect` 看类型/引用 → `cocos_prefab_open` / `cocos_scene_open` 打开 → `cocos_hierarchy` 寻址 → `cocos_node_read` 看现值 → 写工具修改（自动保存+回显）→ 需要视觉确认时 `cocos_preview_launch` + `cocos_runtime_capture`。

## 更新运行时到最新代码

AI 客户端的 MCP 配置固定指向运行时 Worktree（默认 `E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0`）下的构建产物，入口路径不变。日常保持最新只需要在主仓库检出执行一次：

```powershell
& E:/xile-workspace/GitHub/cocos-ai-toolkit/scripts/update-runtime.ps1
```

脚本依次完成：fetch 远程并让运行时 Worktree 以 detached HEAD 对齐 `origin/master`、依赖变化时 `npm install`、代码变化或产物缺失时全量 `npm run build`。任一步失败会尝试恢复旧提交和旧构建；脚本不会启动任何后台服务。它不会创建额外本地分支；运行时 Worktree 存在未提交的 tracked 改动时会中止，避免覆盖手工修改。

执行完后按提示生效：MCP Server 是 AI 客户端在会话启动时拉起的 stdio 进程，需要重启 Kimi Code / Codex 会话加载新构建；若 Bridge Extension 有变更，还需要在 Cocos Creator 中刷新/重启扩展。常用参数：`-Force`、`-TargetRef`。

当前直写架构的真实 Creator 3.8.8 smoke 使用隔离项目执行只读发现和一次 `cc.UITransform` no-op 直写，前后 Git 状态必须完全一致：

```powershell
npm run smoke:creator -- --project-path E:/xile-workspace/worktrees/cocos-ai-blank/Cocos-ai
```

需要验证编辑态 Prefab 实例化时，在固定的空白隔离项目中追加目标/源 Prefab UUID；不要再使用已删除的临时 Probe Worktree。脚本会实例化、显式重开验证关联、删除探针节点，并比较调用前后的 Git 状态与完整 tracked diff：

```powershell
npm run smoke:creator -- `
  --project-path E:/xile-workspace/worktrees/cocos-ai-blank/Cocos-ai `
  --target-prefab-uuid <承载探针的 Prefab UUID> `
  --instantiate-prefab-uuid <待实例化的 Prefab UUID> `
  --instance-name CocosAiPrefabSmoke
```

固定最小 Creator 工程可直接验证源 Prefab 路由、拒写前不进入保存链路及 `dirty=false`：

```powershell
npm run smoke:creator:write-routing
```

在上述命令末尾追加 `--unpack-mode current` 或 `--unpack-mode complete`，可分别验证“仅移除当前关联”和“递归移除嵌套关联”；两种模式应分开运行并保留各自报告。

完整 Preview/runtime 验收使用：

```powershell
& scripts/run-runtime-validation.ps1 `
  -ProjectPath E:/xile-workspace/worktrees/cocos-ai-blank/Cocos-ai
```

## 安装 AI 使用技能

仓库自带一份使用技能（`skills/cocos-ai-toolkit/SKILL.md`），告诉 AI 各工具什么时候用、写入纪律和排障方法：

```powershell
& scripts/install-skills.ps1 -Target kimi      # Kimi Code 用户级（默认）
& scripts/install-skills.ps1 -Target project   # 项目级 .agents/skills
```

默认用 Junction 挂接到仓库，仓库更新技能即更新；`-Copy` 改为复制，`-Force` 覆盖同名旧安装。

## CLI 命令（诊断入口）

```powershell
node packages/cli/dist/index.js editors
node packages/cli/dist/index.js state --project-id <project-id> --editor-instance-id <editor-id>
node packages/cli/dist/index.js assets --project-id <project-id> --editor-instance-id <editor-id> --pattern <text>
node packages/cli/dist/index.js hierarchy --project-id <project-id> --editor-instance-id <editor-id> --depth 20
node packages/cli/dist/index.js node --project-id <project-id> --editor-instance-id <editor-id> --uuid <node-uuid>
node packages/cli/dist/index.js runtime-scenario --project-id <project-id> --steps '<包含 launch 与 stop(always:true) 的 JSON 数组>'
```

CLI 不再跨进程保存 Preview session。持续的 Preview 读取和操作使用 MCP；CLI 只保留编辑态诊断和在单个进程内完成的 `runtime-scenario`。

## 运行期节点和组件 UUID

运行期节点和组件 UUID 在每次重新打开文档后都会变化，不能缓存到配置；稳定身份只有 Asset UUID + FileID + 节点路径。AI 应在每次编辑会话内通过 `cocos_hierarchy` / `cocos_node_read` 现取。

## 安全边界

- Bridge 只监听当前 Windows 用户可访问的本机 Named Pipe，不开放网络端口。
- 不允许执行任意 JavaScript。
- 正式 Bridge 不注册任意 `Editor.Message` 或 cce 门面调试入口；临时调试探针不属于运行时能力。
- 裸启动默认公开全部 MCP 工具；工具的参数校验、AssetDB 操作确认和写后回读校验仍然生效。
- 每个直写操作执行、自动保存并逐项重读；失败即停，已生效的修改保留在文档中。误操作的还原手段是 git。
- 写后逐项重读是唯一生效性防线：Creator 对部分写入会静默不生效（如预制体编辑模式下嵌套实例内部），重读不符会显式报错。
- 外部进程不得直接修改 `.prefab`、`.scene` 或 `.meta` JSON 内容；只有 `.prefab` 删除必须经过 Creator/MCP，非 Prefab 资源文件可直接删除并同时删除同名 `.meta`。
- Creator 3.8.x 小版本变化必须通过真实验证，不允许推测兼容；当前结论严格限定 3.8.8。

## 清理顺序

1. 保存或关闭本次 Creator 中需要保留的人工内容。
2. 关闭正在使用 Cocos AI 的 Codex 任务，让 stdio MCP 和 Preview 浏览器正常退出。
3. 移除 Bridge Junction：

```powershell
& scripts/remove-bridge.ps1 `
  -ProjectPath '<目标项目路径>' `
  -ToolkitPath (Get-Location).Path
```

4. 复查业务项目 Git 状态。

## 报告治理

`npm run reports:doctor` 只读统计报告目录；`reports:archive` 和 `reports:prune` 默认只预览，只有显式追加 `-- --confirm` 才会分别移动旧报告或清理 `reports/archive`。`reports/mcp/` 和 recovery `.patch` 不属于自动归档候选。

## 文档

- [当前使用手册](docs/usage-playbook.md)
