# 阶段 0 最终发现

## 最终结论：GO

阶段 0 的 12 项完成标准已经全部满足，允许开始阶段 1“完整只读协议、项目全扫描、组件 Schema、Prefab 引用图和覆盖率”设计与实现。

这个 GO 严格限定于本次实测的 Creator 3.8.8，只表示 3.8.8 的技术入口、安全事务和真实项目字段映射已经得到验证，不表示其它 3.8.x 小版本已经通过，也不表示当前探针已经是生产可用的完整 AI Cocos Creator。`cc.MissingScript`、多段 `targetInfo.localID` 和更多 Prefab 变体仍必须在阶段 1 扩充覆盖，不能被静默视为已支持。

## 最终统一验证

最终成功运行：`20260713T105629967Z-60f9e700`

| 项目 | 结果 |
| --- | --- |
| Creator | `3.8.8` |
| Bridge | `0.1.0` |
| Node.js | `v25.9.0` |
| npm | `11.4.1` |
| 自动化测试 | 7 个测试文件、48 个测试全部通过 |
| TypeScript 类型检查 | 通过 |
| 构建 | 通过 |
| Undo 事务 | `rolled-back` |
| Undo 来源 | `cce.SceneFacadeManager` |
| 恢复方式 | `asset-db-save-asset` |
| Prefab SHA-256 | 前后均为 `206dd9bdb598ffafdc806fb399e9a6aab727782fe41080a76ba84b6c0387f6c5` |
| 真实项目状态 | 验证前后均为 `## qyclub...origin/qyclub` |
| 隔离项目状态 | 验证前后都只保留 `settings/v2/packages/engine.json` 的既有生成改动 |

统一脚本按顺序完成静态检查、编辑器实例选择、状态、资产、层级、节点、自定义组件、嵌套 Prefab、两阶段 Undo 事务、回滚后层级复查、字节哈希复查和两个项目的 Git 状态对比。任一步失败都会立即停止；已经写出的报告使用唯一运行前缀保留，不覆盖早先证据。

## 已验证的 Creator 入口

### 公开扩展与消息入口

- Creator Extension `load` / `unload`。
- `Editor.App.version`、`Editor.Project.path`、`Editor.Project.uuid`。
- `Editor.Selection.getSelected('node' | 'asset')`。
- `asset-db/query-ready`、`query-assets`、`query-asset-info`、`query-asset-meta`、`open-asset`、`save-asset`。
- `scene/query-is-ready`、`query-dirty`、`query-node-tree`、`query-node`、`query-component`。
- `scene/create-node`、`create-component`、`set-property`、`save-scene`、`remove-node`、`execute-scene-script`。

上述消息入口均由 Creator 3.8.8 实际调用验证。编译类型基线是 npm 当前可用的 `@cocos/creator-types@3.8.7`，不能把类型声明本身当成 3.8.8 运行保证。

### 内部或受保护入口

- `asset-db/query-asset-dependencies`、`query-asset-users`：来自 protected types，当前真实样本可用。
- `query-node.__prefab__`、Scene 运行时 Prefab 资源与实例对象：用于读取 FileID、实例链和 Override，属于内部结构。
- `cce.SceneFacadeManager.undo()`：Creator 3.8.8 真实 Undo 入口，属于内部 API。

内部入口是当前 3.8.8 的实测事实。每个后续 3.8.x 版本都必须重新运行统一验证，尤其不能假设 `cce.SceneFacadeManager` 永久稳定。

## 节点、组件和自定义组件覆盖

最终打开的 `ClubView.prefab` 文档覆盖统计如下：

| 层级 | 当前文档数量 | 阶段 0 读取覆盖 |
| --- | ---: | --- |
| 节点层级摘要 | 74 | 74/74，全部进入规范化层级树 |
| 组件摘要 | 212 | 212/212，全部保留类型和运行时组件 UUID |
| 可识别的内置或其它非自定义组件 | 194 | 194/194 进入层级摘要 |
| 可正常加载的自定义组件 | 4 | 4/4 进入层级摘要；其中 1/4 做完整 `query-component` Schema 验证 |
| `cc.MissingScript` | 14 | 14/14 保留所在节点、运行时 UUID 和原始 Dump，但原类 Schema 无法恢复 |
| 完整节点 Dump 抽样 | 74 个节点 | 1/74，由 `query-node` 验证完整字段和组件引用 |
| 完整组件 Dump 抽样 | 212 个组件 | 1/212，由 `query-component` 验证 59 个属性和引用分类 |

这里的 74/74 和 212/212 是当前打开文档的摘要覆盖，不是整个 `xy-client` 项目的全扫描覆盖；1/74、1/212 和 1/4 是阶段 0 的详细 Dump 抽样。阶段 1 必须把详细查询扩展为项目级扫描和覆盖率报告。

- `query-node-tree --depth 20` 能读取真实节点树、节点路径、激活状态、父子关系、Prefab 状态、运行时 Object UUID 和组件摘要。
- `query-node` 能保留节点完整 Dump、Transform、默认组件、自定义组件和引用字段。
- `query-component` 已验证默认组件和可正常加载的自定义组件。
- 最终样本 `VScrollViewMode` 被识别为自定义组件，解析出：
  - 类名 `VScrollViewMode`；
  - TypeID `b9a82SIRzRA64VTpoykHpqL`；
  - 脚本 UUID `b9a82488-4734-40eb-8553-a68ca41e9a8b`；
  - 继承链 `VirtualScrollView -> cc.Component -> cc.Object`；
  - 59 个属性；
  - Node、Component、Asset 和普通值引用分类；
  - 每个属性的原始 Dump、声明类型、可见性和只读状态。
- Creator 运行时 Object UUID 每次重新打开 Prefab 都会变化。稳定身份必须使用 Asset UUID、FileID 和节点路径；运行时 UUID 只允许作为当前编辑器会话的查询参数。

## 嵌套 Prefab、FileID 和 Override

真实样本为 `ClubView.prefab` 中的 `tableItem` 实例：

| 字段 | 实测值或结果 |
| --- | --- |
| 所属文档 Asset UUID | `808284d7-cc42-4337-926a-bb29c4e04296` |
| 源 Prefab Asset UUID | `6b67227b-2d27-4cc4-99c1-c32c712d52ea` |
| 源对象 FileID | `c46/YsCPVOJYA4mWEpNYRx` |
| PrefabInstance FileID | `ebUQ1XI5JB6qQNhlsAh8vI` |
| 实例链 | 2 层：`ClubView -> tableItem` |
| Property Override | 26 条 |
| Mounted Children | 1 组 |
| Mounted Components | 1 组 |
| Removed Components | 0 条 |
| 当前样本 `unresolved` | 0 |

26 条 Property Override 的 `targetInfo.localID[]`、`propertyPath[]` 和序列化 `value` 均保留；源值、Override 值和当前运行时最终值已经分别解析为 26/26。

三值不能互相替代。实测 `_contentSize` 的源值为 `{width:128.4099578857422,height:61.5}`，Override 为 `{width:128.4099578857422,height:50}`，运行时最终值为 `{width:128.4099578857422,height:48.9}`。AI 协议必须长期同时表达来源、覆盖和最终生效状态。

## 未解析项和 Inspector 覆盖缺口

### `unresolved[]` 精确统计

| 探针 | 数量 | 分类 |
| --- | ---: | --- |
| Editor state | 2 | `document.assetUuid: PUBLIC_API_NOT_CONFIRMED`；`preview: PUBLIC_API_NOT_CONFIRMED` |
| Asset | 0 | 无 |
| 目标 Node | 0 | 无 |
| 目标自定义 Component | 0 | 无 |
| 嵌套 Prefab | 0 | 无 |

### 不属于 `unresolved[]`、但必须显式保留的缺口

- 最终层级样本中有 14 个 `cc.MissingScript` 组件条目。当前能保留节点位置、组件运行时 UUID 和原始 Dump，但无法恢复已经丢失的原脚本类、脚本 UUID 和 Inspector Schema。这是数据源本身缺失，不允许伪造结构。
- 已加载自定义组件能得到脚本 UUID，但当前样本的 `scriptPath=null`；阶段 1 应通过脚本资产索引把 UUID 稳定映射到项目路径。
- 当前真实 Override 只覆盖单段 `targetInfo.localID`。多段 localID、Target Override、Removed Component 和更深嵌套还没有真实样本。
- `document.assetUuid` 和 Preview 状态暂未找到确认过的公开读取入口；阶段 1 应继续查证，未确认前保持 `null + unresolved`。

## Undo、保存、重连和结果确认

- 写协议为 `prepare -> confirm -> status`。
- `prepare` 返回 `transactionId`、Revision、固定操作计划和有效期；不会要求调用方预知新节点 UUID。
- Revision 包含 Prefab 磁盘 SHA-256、编辑器层级 SHA-256、Dirty、文档 UUID、根节点 UUID 和同名探针状态。
- Dirty 文档、错误 Revision、过期事务和同名探针均会拒绝执行。
- 探针节点固定包含 `cc.UITransform`，创建态和保存态 Position 均验证为 `{x:17,y:23,z:0}`。
- Creator 保存造成 Prefab 序列化重排后，Undo 恢复编辑器状态，再由 `asset-db/save-asset` 恢复 prepare 私有备份，最终磁盘和编辑器状态都回到基线。
- 重复 `confirm` 幂等，不会创建第二个节点。
- Task 11 做过一次独立的人工中断验证：Probe Server 在事务 `executing` 时被真实停止，CLI 收到 `SERVER_CONNECTION_CLOSED`；Bridge 仍在 Creator 内完成 Undo 和恢复，Server 重启重连后，同一事务查询为 `rolled-back`，且没有第二个探针节点。这不是最终统一脚本的自动步骤。
- 最终统一验证再次确认层级无探针残留、磁盘哈希恢复、真实项目状态未变化、隔离项目没有新增业务资源改动。

## 阶段 0 完成标准

1. Bridge 加载、断线和重连：通过。
2. 外部 CLI 精确选择项目和编辑器实例：通过。
3. AssetDB UUID、URL、类型、Meta：通过。
4. 节点树、组件 Dump、自定义属性：通过。
5. 自定义组件脚本 UUID、类、属性和引用：通过；MissingScript 明确保留缺口。
6. 真实嵌套 Prefab 来源链：通过。
7. FileID 等价映射字段：通过。
8. Override 原始数据和三值映射：通过。
9. 隔离创建、保存、查询、Undo 和恢复：通过。
10. Server 中断不重复写入、不误报成功：通过人工中断验证；最终统一脚本覆盖正常事务。
11. 真实 `xy-client` 无工具或测试改动：通过。
12. 明确 GO/NO-GO：GO。

## 阶段 1 强制约束

- 继续坚持“Creator 是唯一 Cocos 语义写入引擎”，外部进程不得直接改 `.prefab`、`.scene` 或 `.meta`。
- 首先建设完整只读扫描、稳定身份、组件 Schema、脚本资产映射、Prefab 引用图和覆盖率报告，再扩大写能力。
- 每个 3.8.x 版本都要重跑真实验证；内部 API 变化必须作为兼容性失败显式暴露。
- 所有 Inspector 数据要么结构化返回，要么保留原始 Dump 并进入明确的缺口分类，禁止静默丢字段。

## 证据文件

本地运行报告默认被 `.gitignore` 排除。最终成功的正常事务证据前缀为 `reports/phase-0-20260713T105629967Z-60f9e700-*`，其中关键文件包括：

- `summary.json`
- `editors.json`
- `state.json`
- `assets.json`
- `hierarchy.json` / `hierarchy-after.json`
- `node.json`
- `component.json`
- `prefab.json`
- `undo-prepare.json` / `undo-confirm.json` / `undo-status.json`
- `git-status-before.json` / `git-status-after.json`

Task 11 的人工中断验证记录在 commit `afb304e` 对应的能力结论和 `docs/creator-3.8.8-capability-matrix.md` 的“Undo、保存与结果确认实测”段落中。当时没有保留独立 JSON，因此它不属于上述 17 份最终统一验证报告；阶段 1 应把 Server 中断场景纳入可重复执行并能落盘的故障注入测试。

可提交的稳定字段样本位于 `fixtures/protocol/node-dump.json`、`fixtures/protocol/nested-prefab-dump.json` 和 `docs/creator-3.8.8-capability-matrix.md`。
