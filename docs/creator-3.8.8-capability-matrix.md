# Cocos Creator 3.8.8 能力来源矩阵

验证项目：`E:/xile-workspace/worktrees/xy-client-cocos-ai-probe`

验证版本：Cocos Creator `3.8.8`，Bridge `0.1.0`

| 能力 | 实际入口 | 类型来源 | 稳定性 | 当前结论 |
| --- | --- | --- | --- | --- |
| Bridge 生命周期 | Extension `load` / `unload` + 本机 WebSocket | Creator 扩展公开入口、`ws` | public-api | 已验证 Hello，能返回精确 Creator 版本、项目路径、项目 UUID 和编辑器实例 ID |
| 查询节点树 | `scene/query-node-tree` | `@cocos/creator-types` `3.8.7` | message-api | 已验证 20 层真实层级、Prefab 状态、运行时 Object UUID 和组件摘要 |
| 查询节点 | `scene/query-node` | 同上 | message-api | 已验证节点完整 Dump、`__prefab__`、PrefabInstance 和 Override 原始结构 |
| 查询组件 | `scene/query-component` | 同上 | message-api | 已验证默认组件及自定义组件属性、TypeID、引用和原始 Dump |
| 查询资源 | `asset-db/query-assets`、`query-asset-info`、`query-asset-meta` | 同上 | message-api | 已验证 UUID、URL、绝对路径、类型、Importer 和 Meta |
| 查询依赖 | `asset-db/query-asset-dependencies`、`query-asset-users` | protected types | internal-api | 已验证真实依赖与反向使用者返回；不可用时仍必须进入 `unresolved` |
| 资产与脚本索引 | Bridge `probe.assetIndex` | AssetDB + 协议 Schema | message-api | Phase 1 实测读取 6,485 个资产、756 个脚本，脚本 UUID 可映射到项目路径 |
| 完整组件 Schema | Bridge `probe.component` + 主进程脚本索引 | Component Dump、类反射、Inspector 属性包装 | message/internal-api | 已验证自定义组件脚本 UUID、脚本路径、继承、属性类型、Inspector 元数据、引用和未消费原始字段 |
| 完整文档快照 | Bridge `probe.documentSnapshot` | `query-node-tree`、`query-node`、`query-component` | message/internal-api | 支持 summary/full、分页、Revision cursor 和原始数据；完整快照逐文档落盘并校验 SHA-256 |
| Prefab 跨文档图 | CLI/MCP + `core/prefab-graph` | 运行时 Prefab 信息、FileID、Override | internal-api | 真实项目生成 16,116,497 字节图；保留实例来源、多段 localID、Override、循环和未解析证据 |
| 全项目只读扫描 | CLI/MCP + checkpoint + 流式报告 | Bridge 原子读取 + Core 编排 | composite | 421/421 个 Scene/Prefab 均被处理；339 个完整快照、82 个失败证据，支持同 `scanId` 断点恢复 |
| Prefab 信息 | `query-node.__prefab__` + Scene 运行时 Prefab 资源/实例反射 | Creator 运行时对象和内部信息 | internal-api | 已验证所属文档、源资源、实例根、源 FileID、实例 FileID、两层实例链、26 条 Property Override、Mounted Child/Component |
| Undo | `cce.SceneFacadeManager.undo()` | protected types + Creator 3.8.8 运行时探测 | internal-api | 已验证创建节点进入 Undo，保存后调用 Undo 可移除本事务节点 |
| Undo 分组 | 待隔离 Creator 实测（候选：`cce.SceneFacadeManager` 分组接口） | internal-api | 待实测 | 阶段二决策：分组可用则每事务一个 Undo 组；不可用则显式逆操作 + 逐条 Undo 兜底，回滚后必须重读验证还原。事务管理器默认按兜底路径（`step-undo-with-inverse`）编排 |
| 预制体创建（空预制体） | `asset-db/create-asset(url, null)` | message-api | 已验证（异步导入，需等待） | 空白项目实测创建 `cc.Prefab` 成功；返回前导入未完成时需等待，`delete-asset` 可清理 |
| 预制体创建（场景节点生成） | `cce.SceneFacadeManager.createPrefab(nodeUuid, url)` | internal-api | 已验证 | 空白项目实测从场景节点生成 `cc.Prefab` 并返回资产 UUID；`scene/create-prefab` 消息不存在（挂起） |
| 预制体序列化数据 | `cce.SceneFacadeManager.getPrefabData(nodeUuid)` | internal-api | 已验证 | 返回完整 cc.Prefab 序列化 JSON |
| 预制体删除 | `asset-db/delete-asset(url)` | message-api | 已验证 | 空白项目实测删除 prefab 资产成功 |
| 预制体实例语义 | `cce.SceneFacadeManager`：`applyPrefab` / `restorePrefab` / `linkPrefab` / `unlinkPrefab` | internal-api | 待阶段三实测 | 自省确认方法存在；`scene/duplicate-node` 消息不存在（挂起），节点复制当前走运行时 `cc.instantiate` |
| 保存与字节恢复 | `scene/save-scene` + `asset-db/save-asset` | `@cocos/creator-types` `3.8.7` | message-api | 已验证 Scene 保存会重排 Prefab；Undo 后由 AssetDB 恢复 prepare 阶段备份可回到原 SHA-256 |

## 已确认事实

- 本机 Creator 可执行文件为 `C:/ProgramData/cocos/editors/Creator/3.8.8/CocosCreator.exe`。
- 真实 `xy-client` 编辑器实例保持打开且未安装 Bridge。
- 隔离 Worktree 实例成功登记为项目 `00d7d957-a3e8-4ad6-80f4-2fcfb235bca4`。
- Hello 返回 `creatorVersion=3.8.8`、`bridgeVersion=0.1.0`，当前声明 10 项白名单能力。
- Bridge 编译类型基线使用当前 npm 可用的最新 `@cocos/creator-types@3.8.7`；Creator `3.8.8` 没有对应公开类型包，因此所有 message/internal API 都必须由真实运行结果复验，不能仅凭类型声明认定支持。
- Creator 冷启动时 Bridge Hello 可能早于目标资源可被 `open-asset` 使用；一次实测中 `query-ready=true` 后立即打开仍返回“无法找到资源”，随后 `query-asset-info(uuid)` 已能返回且重试成功。自动化验证应以目标 UUID 的 `query-asset-info` 成功作为条件等待，不应只依赖固定延时或 `query-ready`。

## Phase 1 统一只读验证

- 成功运行前缀：`phase-1-20260715T134703086Z-7372ecce`；统一脚本最终 `status=passed`，13 个阶段全部通过。
- 静态门禁：`npm test` 28 个测试文件、238/238 通过；`npm run typecheck` 和 `npm run build` 退出码均为 0。
- 主扫描与 Server 中断恢复扫描均处理 421/421 个 Scene/Prefab，结果均为 `completed-with-gaps`：339 个完整文档快照、82 个失败。失败分布为 `DOCUMENT_IDENTITY_MISMATCH` 47 个、`SCAN_CURSOR_STALE` 23 个、`DOCUMENT_SCAN_FAILED` 12 个。
- 82/82 个失败均同时具有对应资产 UUID 的 error `unresolved` 和 error diagnostic，缺失证据数为 0；checkpoint 还保留 34,840 条 unresolved、84 条 error diagnostic 和 2,090 条 warning diagnostic，不能把 `completed-with-gaps` 表述为完整覆盖。
- 主扫描报告和恢复报告分别约 5.44 GB，均以 JSON 对象边界、checkpoint 文档引用和逐快照 SHA-256 校验，不在 PowerShell 中整份反序列化。
- Server 中断验证在 1/421 时停止第一代 Server，得到稳定 `ECONNREFUSED`；第二代 Server 真实 Ready 后一次重连成功，并使用相同 `scanId` 从 1 恢复到 421。两代 Server stderr 均为 0。
- 工具 Worktree 与隔离 Creator 项目的 Git 状态在运行前后逐字一致；真实 `xy-client` Creator 进程在整个验证期间保持打开，未被关闭或接管。
- 一次失败运行暴露验证脚本会为读取 `status` 而把约 5.44 GB 恢复报告整体 `ReadAllText` 的内存问题；修复后直接使用 CLI 小结果中的 `status`，第三轮真实运行已越过原 OOM 点并成功收口。

当前结论严格限定 Creator 3.8.8。Task 10 已证明隔离真实项目上的只读执行链、超大报告、Server 中断恢复和 Git 无污染；82 个文档缺口仍需在后续任务中分析，不能据此宣称已经达到“编辑器可见数据 100% 覆盖”。

## Undo、保存与结果确认实测

- 写协议已拆为 `prepare -> confirm -> status`。`prepare` 不要求预知新节点 UUID，返回 `transactionId`、Revision、固定操作计划和 5 分钟有效期；`confirm` 必须同时匹配 `transactionId` 与 `expectedRevision`。
- Revision 组合目标 Prefab 磁盘 SHA-256、编辑器层级 SHA-256、Dirty、文档 UUID、Prefab 根节点 UUID 和同名探针状态。目标文档已有 Dirty 时直接拒绝，prepare 后任一输入变化时返回 `REVISION_CONFLICT`。
- Creator 3.8.8 的 `query-node` 身份与组件字段是 Dump 包装：节点 UUID 为 `uuid.value`、名称为 `name.value`，组件在 `__comps__.value.type`。新建 2D 节点已自带 `cc.UITransform`。
- `create-node.position` 在本次 Prefab 实测中未生效；通过 `scene/set-property` 且 `record=false` 后，创建态和保存态均确认 Position 为 `{x:17,y:23,z:0}`。
- `ClubView.prefab` 保存前基线 SHA-256 为 `206dd9bdb598ffafdc806fb399e9a6aab727782fe41080a76ba84b6c0387f6c5`。保存后 Creator 重排为 `950e026bd394e4f099b7b3ee827347732158a12d764ff2649f94208e51a3b28a`；Undo 恢复编辑器层级后，`asset-db/save-asset` 使用 Bridge 主进程私有基线内容恢复到原 SHA-256。
- 正常事务最终返回 `status=rolled-back`、`rollbackMethod=undo`、`undoSource=cce.SceneFacadeManager`、`recoveryMethod=asset-db-save-asset`、`diskHashRestored=true`、`editorStateRestored=true`。
- 重复 `confirm` 返回同一事务、同一 `createdNodeUuid`，不会再次执行。真实停止 Probe Server 时事务已进入 `executing`；Bridge 在断线期间完成 Undo 和字节恢复，Server 重启并自动重连后，同一 `transactionId` 可查询到 `rolled-back`。

## Prefab 与 Override 实测字段

| 规范字段 | Creator 3.8.8 实际来源 | 当前结论 |
| --- | --- | --- |
| `ownerDocumentAssetUuid` | `query-node-tree` 从外层到目标节点的 Prefab 链首项 | `808284d7-cc42-4337-926a-bb29c4e04296` |
| `sourcePrefabAssetUuid` | `query-node.__prefab__.uuid` | `6b67227b-2d27-4cc4-99c1-c32c712d52ea` |
| `sourceObjectFileId` | `query-node.__prefab__.fileId` | `c46/YsCPVOJYA4mWEpNYRx` |
| `instanceFileId` | `query-node.__prefab__.instance.value.fileId.value` | `ebUQ1XI5JB6qQNhlsAh8vI` |
| `propertyOverrides` | `query-node.__prefab__.instance.value.propertyOverrides.value` | 26 条，原始 `targetInfo.localID[]`、`propertyPath[]`、`value` 全部保留 |
| `sourceValue` | `targetNode._prefab.asset.data`，按 FileID 和属性路径读取 | 26/26 已解析 |
| `overrideValue` | Property Override 原始 `value` | 26/26 已解析 |
| `effectiveValue` | 当前打开文档运行时实例，按 FileID 和属性路径读取 | 26/26 已解析 |

源值、Override 值和最终生效值不能互相替代。实测 `_contentSize` 的源值为 `{width:128.4099578857422,height:61.5}`，Override 为 `{width:128.4099578857422,height:50}`，运行时最终值为 `{width:128.4099578857422,height:48.9}`；这证明组件运行时更新可能使最终值不同于序列化 Override。
