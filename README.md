# Cocos AI Toolkit

这是一套专门供 AI 使用的 Cocos Creator 自动化工具。开发人员仍然使用 Creator 编辑器；AI 通过受限 CLI、Probe Server 和项目内 Bridge 读取或执行操作，Cocos Creator 编辑器负责真正的 Scene、Prefab、节点、组件、Undo 和保存语义。

阶段 0 已在真实游戏前端 `xy-client` 的隔离 Git Worktree 和 Cocos Creator 3.8.8 上完成验证，结论为 **GO**。当前仓库仍是技术探针，不是生产版完整工具；阶段 1 将扩展完整只读扫描、组件 Schema、Prefab 引用图和覆盖率。

## 架构

```text
AI / Codex
  -> cocos-ai-probe CLI
  -> localhost Probe Server
  -> Creator 项目内 Bridge Extension
  -> Cocos Creator Editor / Scene / AssetDB
```

外部服务不直接修改 `.prefab`、`.scene` 或 `.meta`。所有 Cocos 语义写入都必须在 Creator 内执行。

## 环境要求

- Windows。
- Cocos Creator `3.8.x`；阶段 0 实际验证版本为 `3.8.8`。
- Node.js `>=20.19 <26`；最终验证使用 `v25.9.0`。
- npm；最终验证使用 `11.4.1`。
- Git，且真实项目与写探针项目必须分离为不同工作区。

Creator 3.8.x 的内部 API 可能随小版本变化。任何不是 3.8.8 的版本都必须先运行 `scripts/run-phase-0-validation.ps1`，不能只凭版本号判断兼容。

## 安装与构建

在工具仓库根目录执行：

```powershell
npm install
npm test
npm run typecheck
npm run build
```

构建会生成 CLI、Probe Server、协议包和 Bridge Extension 的 `dist/`。

## 创建隔离游戏项目

禁止把 Bridge 安装到真实 `E:/xile-workspace/qyProject/xy-client`。先创建隔离 Worktree：

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

真实项目 Creator 实例可以继续运行，但不能安装 Bridge，也不能作为写探针目标。

## 启动 Probe Server

在独立终端运行：

```powershell
& scripts/start-probe-server.ps1 -Port 32188 -ReportRoot 'reports'
```

默认只监听 `127.0.0.1:32188`。Bridge 会自动连接和重连；CLI 通过同一 WebSocket Server 选择目标编辑器实例。

如需非默认地址，给 Bridge 和 CLI 设置同一个 `COCOS_AI_PROBE_SERVER_URL`。不要把阶段 0 Server 暴露到外网。

## 选择编辑器和准备样本

先查询当前连接实例：

```powershell
node packages/cli/dist/index.js editors
```

记录隔离实例返回的 `projectId` 和 `editorInstanceId`。目标实例的 `projectPath` 必须等于隔离 Worktree。

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
```

CLI 只允许预定义命令，不提供任意 JavaScript 执行入口。

## 两阶段 Undo 写探针

写探针只用于隔离 Worktree，节点名必须以 `CocosAiProbe_` 开头：

```powershell
$prepare = node packages/cli/dist/index.js probe-undo-save-prepare `
  --project-id <project-id> `
  --editor-instance-id <editor-id> `
  --project-path 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe' `
  --document-uuid <prefab-asset-uuid> `
  --probe-name CocosAiProbe_<unique-id> | ConvertFrom-Json

node packages/cli/dist/index.js probe-undo-save-confirm `
  --project-id <project-id> `
  --editor-instance-id <editor-id> `
  --transaction-id $prepare.transactionId `
  --expected-revision $prepare.revision

node packages/cli/dist/index.js probe-undo-save-status `
  --project-id <project-id> `
  --editor-instance-id <editor-id> `
  --transaction-id $prepare.transactionId
```

`confirm` 必须匹配 prepare 返回的 Revision。重复 confirm 返回同一事务，不会重复创建节点；最终成功状态必须是 `rolled-back`，不能只依据请求是否返回来判断成功。

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

## 安全边界

- Bridge 仅连接 `127.0.0.1`。
- 不允许执行任意 JavaScript。
- 不允许向真实项目安装 Bridge 或运行写探针。
- 外部进程不得直接写 `.prefab`、`.scene` 或 `.meta`。
- Scene、Undo、保存和恢复全部由 Creator 执行；外部只读磁盘计算指纹。
- `prepare` 拒绝 Dirty 文档、已有同名探针和错误项目路径。
- `confirm` 拒绝 Revision 冲突、过期事务和错误事务身份。
- 无法结构化的数据必须保留原始 Dump 并明确进入缺口分类。
- Creator 3.8.x 小版本变化必须通过真实统一验证，不允许推测兼容。

## 清理顺序

1. 如果启动过事务，先用 `probe-undo-save-status` 确认不是 `executing`、`outcome-unknown` 或 `manual-recovery-required`。
2. 保存或关闭隔离 Creator 中需要保留的人工内容，然后停止**隔离项目** Creator；不要关闭真实项目 Creator。
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
- [Creator 3.8.8 能力来源矩阵](docs/creator-3.8.8-capability-matrix.md)
- [xy-client 样本选择](docs/xy-client-sample-selection.md)
