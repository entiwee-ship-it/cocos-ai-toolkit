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
- 真实 `xy-client` 工作区未新增工具改动。
- Creator 冷启动存在 AssetDB 可查询时序：Bridge Hello 和 `query-ready=true` 不足以证明指定 UUID 已可打开，目标资源 `query-asset-info` 成功后重试可稳定打开。后续统一验证脚本必须使用按 UUID 的条件等待。

## 阻断项

1. `expectedNodeUuid` 只能在 Creator 执行 `create-node` 后获知，与“调用前必须提供”矛盾；正式写协议需拆成 prepare/confirm 两阶段。
2. 即使临时节点已删除，Creator 保存仍可能重排 Prefab 序列化并更新项目设置，不能把 Undo 等同于 Git 字节级恢复。正式写入必须增加 Revision、磁盘差异确认和显式恢复策略。
3. 当前项目存在 `cc.MissingScript`；可正常加载的自定义组件已经读取，MissingScript 仍只能保留原始 Dump 和明确缺口。
4. 当前 FileID 解析器已覆盖真实样本的单段 `targetInfo.localID`。多段 localID、Target Override、Removed Component 和更深嵌套仍需在阶段 1 建立更多真实样本，不能由当前样本外推为全覆盖。

## 当前结论

嵌套 Prefab 只读链路的原阻断已经解除，Task 10 可以完成。阶段 0 整体仍未达到 GO：正式 AI 写入工具面还必须完成两阶段写确认、结果确认和字节级恢复验证。
