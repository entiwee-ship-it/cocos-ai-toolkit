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
| Prefab 信息 | `query-node.__prefab__` + Scene 运行时 Prefab 资源/实例反射 | Creator 运行时对象和内部信息 | internal-api | 已验证所属文档、源资源、实例根、源 FileID、实例 FileID、两层实例链、26 条 Property Override、Mounted Child/Component |
| Undo | `cce.SceneFacadeManager.undo()` | protected types + Creator 3.8.8 运行时探测 | internal-api | 已验证创建节点进入 Undo，保存后调用 Undo 可移除本事务节点 |
| 保存与字节恢复 | `scene/save-scene` + `asset-db/save-asset` | `@cocos/creator-types` `3.8.7` | message-api | 已验证 Scene 保存会重排 Prefab；Undo 后由 AssetDB 恢复 prepare 阶段备份可回到原 SHA-256 |

## 已确认事实

- 本机 Creator 可执行文件为 `C:/ProgramData/cocos/editors/Creator/3.8.8/CocosCreator.exe`。
- 真实 `xy-client` 编辑器实例保持打开且未安装 Bridge。
- 隔离 Worktree 实例成功登记为项目 `00d7d957-a3e8-4ad6-80f4-2fcfb235bca4`。
- Hello 返回 `creatorVersion=3.8.8`、`bridgeVersion=0.1.0`，当前声明 10 项白名单能力。
- Bridge 编译类型基线使用当前 npm 可用的最新 `@cocos/creator-types@3.8.7`；Creator `3.8.8` 没有对应公开类型包，因此所有 message/internal API 都必须由真实运行结果复验，不能仅凭类型声明认定支持。
- Creator 冷启动时 Bridge Hello 可能早于目标资源可被 `open-asset` 使用；一次实测中 `query-ready=true` 后立即打开仍返回“无法找到资源”，随后 `query-asset-info(uuid)` 已能返回且重试成功。自动化验证应以目标 UUID 的 `query-asset-info` 成功作为条件等待，不应只依赖固定延时或 `query-ready`。

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
