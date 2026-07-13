# xy-client 阶段 0 Prefab 样本

| 样本 | Asset UUID | 用途 | 当前结论 |
| --- | --- | --- | --- |
| `db://assets/qyq/club/ClubView.prefab` | `808284d7-cc42-4337-926a-bb29c4e04296` | 大型业务 UI、自定义组件、MissingScript、资源依赖 | 已由 Creator 3.8.8 打开；根实例和子节点均返回源 Prefab UUID |

当前样本的 Scene 层级返回 `prefab.state=1`、`assetUuid=808284d7-cc42-4337-926a-bb29c4e04296`，但未出现 `isNested=true`。因此 FileID、嵌套来源链和 Override 明细仍为阶段 0 的未完成验证项，不能依据磁盘文件或文件大小推断。
