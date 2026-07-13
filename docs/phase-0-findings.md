# 阶段 0 当前发现

## 已验证

- Creator 3.8.8 Bridge Hello、断线重连、唯一实例选择。
- AssetDB 资源 UUID、URL、绝对路径、Importer、Meta、依赖字段。
- Scene Ready、AssetDB Ready、Dirty、Selection。
- 节点树、节点完整 Dump、组件完整 Dump、属性类型和引用分类。
- `ClubView.prefab` 内 `tableItem` 是真实嵌套 Prefab，来源链为外层 `ClubView` 和内层 `tableItem`。
- Creator 3.8.8 实际返回源 Prefab UUID、源对象 FileID、PrefabInstance FileID、26 条 Property Override、Mounted Children 和 Mounted Components。
- 26 条 Override 的源值、序列化 Override 值和当前运行时最终值均已分别解析，当前样本 `unresolved=0`。
- 至少一个 `_contentSize` 的最终值 `height=48.9` 与 Override `height=50` 不同，协议必须长期保留三值模型。
- 隔离写探针创建和删除临时节点后，层级中不残留探针节点。
- 写协议已拆分为 `prepare -> confirm -> status`；prepare 不预知节点 UUID，confirm 使用 `transactionId + expectedRevision`，重复 confirm 不重复执行。
- Revision 已覆盖 Prefab 磁盘 SHA-256、编辑器层级 SHA-256、Dirty、文档 UUID、根节点 UUID 和同名探针状态；已有 Dirty 和 Revision 冲突均拒绝写入。
- Creator 3.8.8 实际通过 `cce.SceneFacadeManager.undo()` 回滚。固定探针节点包含 `cc.UITransform`，Position 在创建态和保存态均确认是 `{x:17,y:23,z:0}`。
- Creator 首次保存会把 `ClubView.prefab` SHA-256 从 `206dd9...f6c5` 重排为 `950e02...b28a`；Undo 后通过 Creator `asset-db/save-asset` 恢复 prepare 私有备份，最终磁盘 SHA-256 和编辑器层级 SHA-256 都回到基线。
- Probe Server 在事务 `executing` 状态被真实停止后，Bridge 仍完成 Undo、保存和字节恢复；Server 重启重连后，同一事务查询为 `rolled-back`，没有第二个探针节点。
- 真实 `xy-client` 工作区未新增工具改动。
- Creator 冷启动存在 AssetDB 可查询时序：Bridge Hello 和 `query-ready=true` 不足以证明指定 UUID 已可打开，目标资源 `query-asset-info` 成功后重试可稳定打开。后续统一验证脚本必须使用按 UUID 的条件等待。

## 剩余风险

1. 当前项目存在 `cc.MissingScript`；可正常加载的自定义组件已经读取，MissingScript 仍只能保留原始 Dump 和明确缺口。
2. 当前 FileID 解析器已覆盖真实样本的单段 `targetInfo.localID`。多段 localID、Target Override、Removed Component 和更深嵌套仍需在阶段 1 建立更多真实样本，不能由当前样本外推为全覆盖。
3. `cce.SceneFacadeManager` 属于 Creator 内部 API，后续 3.8.x 小版本必须继续运行真实 Undo 探针，不能只依赖 `@cocos/creator-types@3.8.7`。
4. 阶段 0 还需要 Task 12 的统一验证脚本、最终证据汇总和明确 GO/NO-GO 报告。

## 当前结论

Task 11 的两阶段写确认、结果确认、Undo、字节级恢复和 Server 中断恢复均已通过。阶段 0 技术阻断已解除，但整体 GO 仍需 Task 12 完成统一验证脚本与最终证据报告后给出。
