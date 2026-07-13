# 阶段 0 当前发现

## 已验证

- Creator 3.8.8 Bridge Hello、断线重连、唯一实例选择。
- AssetDB 资源 UUID、URL、绝对路径、Importer、Meta、依赖字段。
- Scene Ready、AssetDB Ready、Dirty、Selection。
- 节点树、节点完整 Dump、组件完整 Dump、属性类型和引用分类。
- `ClubView.prefab` 的源 Prefab UUID 与当前实例状态。
- 隔离写探针创建和删除临时节点后，层级中不残留探针节点。
- 真实 `xy-client` 工作区未新增工具改动。

## 阻断项

1. 当前真实样本未出现 `isNested=true`，尚未取得 FileID、嵌套来源链和 Override 明细证据。
2. `expectedNodeUuid` 只能在 Creator 执行 `create-node` 后获知，与“调用前必须提供”矛盾；正式写协议需拆成 prepare/confirm 两阶段。
3. 即使临时节点已删除，Creator 保存仍可能重排 Prefab 序列化并更新项目设置，不能把 Undo 等同于 Git 字节级恢复。阶段 1 必须增加 Revision、磁盘差异确认和显式恢复策略。
4. 当前项目存在 `cc.MissingScript`，自定义脚本 UUID 需要在脚本可正常加载的样本上继续验证。

## 当前结论

阶段 0 尚未达到 GO。只读探针纵切已成立；正式 AI 写入工具面必须先解决两阶段写确认、嵌套 Prefab 样本和字节级恢复三个问题。
