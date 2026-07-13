# xy-client 阶段 0 Prefab 样本

所有样本均由 Cocos Creator 3.8.8 打开并通过 Bridge 只读查询确认。样本来自隔离 Worktree `E:/xile-workspace/worktrees/xy-client-cocos-ai-probe`，没有向真实 `xy-client` 安装 Bridge。

| 样本 | Asset UUID | 选择理由 | Creator 3.8.8 证据 | 风险 |
| --- | --- | --- | --- | --- |
| `db://assets/qyq/club/dataItems/tableItem.prefab` | `6b67227b-2d27-4cc4-99c1-c32c712d52ea` | 单层 Prefab 源样本 | 独立打开后共 14 个节点，`isNested=true` 节点为 0 | 只能证明该资源自身没有更深嵌套，不能代表其作为实例时没有 Override |
| `db://assets/qyq/club/ClubView.prefab` 根文档 | `808284d7-cc42-4337-926a-bb29c4e04296` | 大型业务 UI、自定义组件、Node/Component/Asset 引用和 MissingScript 样本 | 节点、组件和自定义组件 Dump 已由 `query-node-tree`、`query-node`、`query-component` 返回 | 存在 MissingScript，相关脚本只能保留原始 Dump 和 unresolved 信息 |
| `ClubView.prefab` 内 `tableItem` 实例 | 源资源 `6b67227b-2d27-4cc4-99c1-c32c712d52ea` | 两层来源链、FileID、Property Override、Mounted Child/Component 样本 | `state=2`、`isNested=true`，实例链为 `ClubView -> tableItem`，读取到 26 条 Property Override | Creator 运行时 Object UUID 每次重开都会变化，稳定映射必须使用 Asset UUID、FileID 和节点路径，不能缓存运行时 UUID |

## 嵌套样本稳定身份

- 所属文档 Asset UUID：`808284d7-cc42-4337-926a-bb29c4e04296`
- 源 Prefab Asset UUID：`6b67227b-2d27-4cc4-99c1-c32c712d52ea`
- 源根节点 FileID：`c46/YsCPVOJYA4mWEpNYRx`
- PrefabInstance FileID：`ebUQ1XI5JB6qQNhlsAh8vI`
- 节点路径：`should_hide_in_hierarchy/ClubView/Body/Content_body/tableContent/TB_content/tableItem`
- Property Override：26 条
- Mounted Children：1 组
- Mounted Components：1 组
- Removed Components：0 条

运行时 Object UUID 不写成稳定规则。真实结构证据保存在 `fixtures/protocol/nested-prefab-dump.json`，其中同时保留规范化结果和 Creator 原始 `rawPrefabInfo`。
