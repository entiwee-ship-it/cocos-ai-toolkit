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
| Undo | `cce.SceneFacadeManager.undo()` | protected types + Creator 3.8.8 运行时探测 | internal-api | 阶段三复测修正：undo 对**属性级**修改（含 `_prefab` 关联变化）有效；对新建/删除子节点的结构变更，dump-diff 恢复不覆盖（undo 后节点仍在），Phase 0 的"创建节点进入 Undo"结论以显式删除兜底为准 |
| Undo 分组 | `SceneFacadeManager._facadeFSM.currentState._undoMgr`（SceneUndoManager：`beginRecording(uuids,{auto})` / `endRecording(id)` / `cancelRecording(id)` / `record(uuid)`） | internal-api | 已实测（阶段三） | 手动 begin/endRecording + undo/redo 对属性修改确实生效（实测改名整组回退）；结构变更（create-node 快照、消息 `record:true`）不产生有效撤销条目。阶段三决策：事务回滚**维持 `step-undo-with-inverse`**（显式逆操作 + 重读验证），编辑器 Undo 分组仅作属性级辅助，不作切换 |
| 预制体创建（空预制体） | `asset-db/create-asset(url, null)` | message-api | 已验证（异步导入，需等待） | 空白项目实测创建 `cc.Prefab` 成功；返回前导入未完成时需等待，`delete-asset` 可清理 |
| 空预制体模板创建 | `asset-db/create-asset(url, content)`，content 为内置模板 | message-api | 已验证 | `create-asset(url, null)` 只会得到 directory 类型空目录；必须传内置 Node Prefab 模板内容（`default_file_content/prefab/default.prefab`），创建后 `open-asset` 可直接进入写入 |
| 预制体创建（场景节点生成） | `cce.SceneFacadeManager.createPrefab(nodeUuid, url)` | internal-api | 已验证 | 空白项目实测从场景节点生成 `cc.Prefab` 并返回资产 UUID；`scene/create-prefab` 消息不存在（挂起） |
| 预制体序列化数据 | `cce.SceneFacadeManager.getPrefabData(nodeUuid)` | internal-api | 已验证 | 返回完整 cc.Prefab 序列化 JSON |
| 预制体删除 | `asset-db/delete-asset(url)` | message-api | 已验证 | 空白项目实测删除 prefab 资产成功 |
| 预制体实例语义 | `cce.SceneFacadeManager`：`applyPrefab` / `restorePrefab` / `linkPrefab` / `unlinkPrefab`（均委托 `_facadeFSM.currentState` → PrefabManager/nodeOperation） | internal-api | 已实测（阶段三，空白项目） | 全部可用，详见文末"阶段三预制体语义实测"；`scene/duplicate-node` 消息不存在（挂起），节点复制当前走运行时 `cc.instantiate` |
| 资产创建冲突弹窗 | `asset-db/create-asset` 对已存在路径 | message-api | 已验证风险 | 对既有路径调用会弹出"文件已存在，是否覆盖"模态框并无限阻塞调用方；写入前必须先 `query-asset-info` 预检或保证路径唯一 |
| 脚本重新编译触发 | `asset-db/refresh-asset` → 重新导入 + **异步 TypeScript 编译 + 类重注册**（阶段三复测修正）；`programming/execute-script`（调用被拒） | message-api | 已验证（阶段三） | 3.8.8 实测：refresh-asset 后脚本类标记变化（构造器 len 269→348→还原 269 双向确认），阶段二"仅重新导入不触发编译"结论作废（此前观测早于异步编译完成）。编译完成不可经广播事件感知（场景进程监听 8 个候选频道全空），**等待链路用类注册标记有界轮询**；自然文件监听在后台无焦点 30 秒未触发，显式 refresh-asset 是可靠触发 |
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

## 阶段三预制体语义实测（空白项目，Bridge 0.1.24）

探测入口：Bridge 临时探针 `probe.debugPrefabFacade`（enumerate/call/instantiate/link/scene-message），驱动脚本 `codex-work/tools/debug-prefab-facade.mts`、`debug-write-tx.mts`；证据 JSON 留档 `codex-work/work/tmp/facade-*.json`、`probe-*.json`。

### 门面结构

- `cce.SceneFacadeManager` 是代理层（262 个方法），真正实现全部委托 `this._facadeFSM.currentState`（普通场景模式为 `GeneralSceneFacade`，258 个方法）；预制体语义再由 `GeneralSceneFacade` 委托 `cce.Prefab`（PrefabManager）→ 模块内 `nodeOperation`。
- Undo 实现为 `SceneUndoManager`（`currentState._undoMgr`）：命令栈 `_commandArray` + 手动/自动录制（`beginRecording(uuids,{auto})` → 命令 id；自动命令帧末自动关闭）；Dirty = 命令指针与最后保存命令不一致（`isDirty()`）。
- `cce.Prefab`（PrefabManager，48 个方法）含实例化与关联原语；守卫方法 `filterPartOfPrefabAssetWhen*` 会阻止对实例内部节点的直接删改。

### 实例化（预制体资产 → 场景实例）

| 路径 | 结论 |
| --- | --- |
| `scene/create-node` 消息 `{parent, assetUuid, name, type:'cc.Prefab'}` | **推荐**。产出完整实例（state=2、applicable/revertable/unwrappable=true、独立 instance fileId）；**不带 `type` 会被 `removePrefabInfoFromNode` 剥成普通节点** |
| `cce.Node.createNodeFromAsset(parentUuid, assetUuid, {name, type:'cc.Prefab'})` | 编辑器拖拽同款路径（发 before-add/add/change 事件、自动选中、checkCanvasRequired 可能自动创建 Canvas）；参数形态为（父，资产 UUID，选项）；**错误被内部 try/catch 吞掉只打控制台** |
| `cce.Prefab.createNodeFromPrefabAsset(asset)` + 运行时挂父 | 可用但绕过编辑器事件；需先 `assetManager.loadAny` 取得资产对象 |
| 三条路径共同点 | **都不进编辑器 Undo、不置 Dirty**；实例化写入的序列化结果正确（PrefabInfo + PrefabInstance + 覆盖记录 + 嵌套追踪） |

### 应用到源 / 还原 / 解除与重新关联

| 操作 | 结论 |
| --- | --- |
| `applyPrefab(instanceRootUuid)` | 把实例覆盖应用到源资产并**直接写盘**（git 可见 diff）；实测子节点位置覆盖成功写入源文件；**返回值不可信（成功也返回 false）**，必须靠重读/git 验证；根节点名属特例不应用；应用后实例侧覆盖记录不清空 |
| `restorePrefab(instanceRootUuid)` | 整实例粒度还原（propertyOverrides 全部回源），成功返回 true；根名覆盖特例保留 |
| `unlinkPrefab(instanceRootUuid)` | 解除关联、`__prefab__` 清空、子树保留；门面自带 begin/endRecording，**undo 可恢复关联**（证明关联变化属属性级可撤销） |
| `linkPrefab(nodeUuid, assetUuid)` / `PrefabManager.linkNodeWithPrefabAsset` | 字符串 uuid 与运行时对象两种参数形态均调通，重新关联后 `_prefab.asset` 与 `instance` 恢复 |

### 嵌套与 Override

- 实例属性修改（含子节点 `_lpos`、根节点 `_name`）自动落为 `propertyOverrides` 差异记录，场景文件序列化为 `CCPropertyOverrideInfo`（targetInfo.localID + propertyPath + value）。
- `createPrefab` 从**含实例的节点**生成预制体时**保留嵌套实例**（新预制体内出现指向源资产的 PrefabInfo + PrefabInstance 记录 + 根 PrefabInfo 的 `nestedPrefabInstanceRoots` 追踪），不拍平。

### Undo 分组（Task 2 实测结论）

- 手动 `beginRecording([节点],{auto:false})` → 属性修改 → `endRecording(id)` → `undo()`：整组回退**生效**（实测改名回退）。
- 新建节点：`scene/create-node` 传 `snapshot:true` 或手动录制父节点，均只产生非 custom 的 dump-diff 命令，undo **不能**移除新建子节点（子节点列表不被 dump 恢复覆盖）。
- 消息 `record:true`（set-property）在本进程内调用不产生撤销条目。
- **阶段三决策：事务回滚维持 `step-undo-with-inverse`（显式逆操作 + 重读验证）**，编辑器 Undo 分组只作属性级辅助，不切换。

### 会话与状态注意

- 节点 UUID 是**会话级**的：重开文档后全部变化，序列化身份以 fileId 为准。
- 运行时直接挂父（`node.parent=`）不置 Dirty；`save-scene` 对无 Dirty 文档不写盘。
- `facade.createNode(e)`（JS 层）与 NodeManager 直调一样不录制 Undo；录制由调用方负责。
- 探测遗留验证：所有探针节点已清理，空白项目 git 逐字干净。

### Task 13 全链路实测补录（往返验证后固化）

- **`createPrefab` 重建节点并改名**：从场景节点生成预制体后，原会话 UUID 失效，实例根名改为预制体资产名；重定位必须按父节点 + 源资产 UUID 匹配。节点树刷新晚于 createPrefab 返回，重定位需有界轮询。
- **`restorePrefab` 整实例还原语义**：只还原实例内部（非根挂载点）覆盖；实例根自身的 `_name`/`_lpos`/`_lrot`/`_euler` 覆盖（target 为根 fileId）按设计保留。写入侧按 targetFileId 判定验证。
- **`applyPrefab` 应用后覆盖记录不清空**：实例侧 propertyOverrides 保留（值已与源一致）；"应用到源"的真实判据是源文件已写入新值，返回值不可信。
- **query-node-tree 与 query-node 是两种形态**：树查询返回精简形态（裸字符串字段、`prefab.assetUuid/state`），单节点查询返回 Dump 包装形态（`__prefab__.uuid/instance`）；所有树解析必须按精简形态。
- **prefabGraph 指纹**：实例标记 = `根UUID|源资产UUID|prefab状态` 排序拼接 SHA-256；Bridge 与外部调用方算法必须逐位对齐（已交叉验证一致）。
- **PowerShell 陷阱**：`[string]` 参数未传值强制为空串（非 null）；Mandatory 参数遇空集合绑定失败，需 `[AllowEmptyCollection()]`。

### 脚本编译链路（Task 3 实测结论）

- `Editor.Message` 场景进程侧接口：`request / send / broadcast / addBroadcastListener / removeBroadcastListener`（另有 `__register__` 等内部键）。
- 广播监听在场景进程注册 8 个候选频道（asset-db:asset-*、programming:* 等）均**收不到事件**：文件改动、显式 refresh、重编译完成全程事件缓冲为空。事件驱动等待链路不可用。
- **`asset-db/refresh-asset` 实测触发完整链路**：重新导入 → 异步 TS 编译 → 类重注册。证据：Phase2Probe 增删属性后 refresh，构造器标记双向变化（len 269→348→269）。
- 编译完成感知方式：`js.getClassByName(className)` 构造器源码标记（长度+哈希）**有界轮询**，不用固定延时；挂载守卫可按"refresh → 轮询类标记/Schema 出现预期字段 → 允许挂载"落地（设计规格第 15 章）。
- 自然文件监听在后台无焦点状态下 30 秒未触发；用户点击 Creator（焦点恢复）是手动触发路径，自动化一律用显式 refresh-asset。
