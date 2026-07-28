# Prefab 场景化工具档设计

## 目标

把 AI Agent 默认看到的 Cocos MCP 工具从 33 个底层工具缩减为 7 个 Prefab 场景工具，同时保留原有底层能力用于调试、恢复和高级操作。

默认工具面面向四类工作：查找/查看 Prefab、创建 Prefab、编辑 Prefab、删除 Prefab。Agent 不得读取、拼装或直接修改 `.prefab`、`.scene`、`.meta` JSON；所有资产和文档写入必须经过 Creator Bridge 和现有事务通道。

## 工具档

MCP 增加 `prefab` 与 `full` 两个 profile：

- `prefab`：默认值。开启写能力时只注册 7 个场景工具；只读启动时注册其中 4 个只读工具。
- `full`：兼容和调试档。严格注册现有 33 个底层工具，名称和行为保持不变。

默认 `prefab` 工具如下：

| 工具 | 只读 | 用途 |
| --- | --- | --- |
| `cocos_editor_list` | 是 | 发现在线 Creator 项目与实例 |
| `cocos_prefab_search` | 是 | 只搜索 Prefab 资产 |
| `cocos_prefab_inspect` | 是 | 校验资产类型、打开 Prefab、等待文档就绪并返回结构与引用 |
| `cocos_prefab_create` | 否 | 预览或执行“声明式创建节点树 -> Creator 从节点生成 Prefab” |
| `cocos_prefab_edit` | 否 | 打开目标 Prefab，自动预览、应用并重读验证 |
| `cocos_prefab_delete` | 否 | 检查反向引用，精确确认后事务删除资产 |
| `cocos_prefab_verify` | 是 | 打开目标 Prefab 并按声明式目标独立验证 |

`prefab` 与 `full` 工具面不叠加，避免调试档出现 39 个工具。

## 高层接口

### 查找

`cocos_prefab_search` 接收项目选择、搜索文本、页大小和高层 cursor。服务循环消费底层 AssetDB 搜索页，只返回 `cc.Prefab` 或 `.prefab` 资产，并给出准确的 Prefab 结果总数。

### 查看

`cocos_prefab_inspect` 接收 Prefab UUID。服务按顺序执行：

1. 读取资产详情和全部依赖/反向引用；
2. 拒绝非 Prefab 资产；
3. 通过 Creator AssetDB 打开资产；
4. 轮询编辑器状态，直到当前文档 UUID 与目标一致；
5. 返回声明式树、revision、风险、未解析项和引用摘要。

输出不包含原始序列化 JSON。

### 编辑与验证

`cocos_prefab_edit` 和 `cocos_prefab_verify` 接收 `uuid`、声明式 `tree` 与可选 `prune`。服务内部构造 `current-document` 目标，禁止调用方改变作用域或目标资产身份。

编辑工具使用 `mode: preview | apply`：

- `preview` 只打开、检查并生成差异预览；
- `apply` 仍先生成预览，再调用现有声明式事务执行器，最后独立重读验证；只有 apply 与 verify 都通过才返回成功状态。

### 创建

`cocos_prefab_create` 接收目标 `assetUrl`、声明式 `tree`、要转为 Prefab 的 `rootId` 和 `mode`。`assetUrl` 必须位于 `db://assets/` 且以 `.prefab` 结尾；`rootId` 必须对应目标树中的节点。

`preview` 返回节点树差异和后续 `prefab.create_from_node` 操作，不写入。

`apply` 执行：

1. 确认目标资产不存在；
2. 预览并声明式应用节点树；
3. 从声明式执行结果中取得 `rootId` 的真实节点 UUID；
4. 捕获最新 revision；
5. 以独立事务执行 `prefab.create_from_node`；
6. 确认事务 committed，重新搜索并打开新 Prefab，返回最终结构。

如果第 2 步之后的创建失败，服务按声明式事务逆序尝试回滚，并把回滚结果与原始失败一并返回/抛出。不得回退到手写 Prefab JSON 的旧路径。

### 删除

`cocos_prefab_delete` 接收 UUID、`mode`、可选确认字段：

- `preview` 返回资产 URL 和全部反向引用，不写入；
- `apply` 要求 `confirmAssetUrl` 与真实资产 URL 完全一致；
- 存在反向引用时还要求 `confirmReferenced: true`；
- 删除通过 `prefab.delete_asset` 事务执行；完成后重新查询 AssetDB，确认 UUID 已不存在。

删除不可回滚，工具 annotations 必须标为 destructive。引用检查不是回滚替代品，而是不可逆操作前的门禁。

## 启动与安装

`run.js` 支持 `--profile=prefab` 和 `--profile=full`，也接受 `--profile prefab`。缺省为 `prefab`，未知值以稳定错误拒绝。

Codex 安装脚本默认写入 `--profile=prefab --enable-writes`；`-Profile full` 可安装调试档。健康检查根据 profile 核对精确工具集合：默认写入档 7 个、默认只读档 4 个、full 写入档 33 个。

## 技能约束

配套技能只教授 7 个高层工具，并明确：

- 任何 Prefab/Scene/Meta 操作禁止手写 JSON；
- 名称或路径未知时先 search，再 inspect；
- create/edit/delete 先 preview，再 apply；
- 删除必须展示引用影响并精确确认；
- 只有排障、事务恢复、运行态取证时才切换 `full`，并使用底层工具参考。

## 兼容性与非目标

- 不删除底层工具、事务恢复、项目扫描或运行态实现。
- 不改变 Bridge 协议和现有 33 个工具的请求/响应。
- 不增加单一 `cocos_prefab_manage(action=...)` 巨型工具。
- 本阶段不承诺删除资产可回滚。
- 本阶段不使用 `scene.ts` 的空 Prefab JSON 模板创建路径。

## 验证

自动化验证覆盖：profile 解析与精确工具集合、高层搜索过滤、inspect 打开等待、edit 的 preview/apply/verify 顺序、create 的 Creator API 事务链、delete 的引用与精确确认门禁、安装和健康检查参数、技能禁写 JSON 约束。

完成后运行定向测试、`npm test`、`npm run typecheck`、`npm run build`、`npm run codex:check`（Creator/Probe 在线时）和 `git diff --check`。真实项目验证只使用 Creator/MCP，不直接改资产文件。
