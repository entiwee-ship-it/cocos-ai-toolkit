---
name: cocos-ai-toolkit
description: Use when a Cocos Creator 3.8.x task must create, inspect, edit, delete, search, or verify Prefabs, scenes, UI hierarchy, components, or asset references; also use for 创建、查看、编辑、删除、查找或验证预制体/场景 and `.prefab`, `.scene`, or `.meta` JSON work. For deletion, only `.prefab` requires Creator/MCP; non-Prefab files and their matching `.meta` may be deleted directly. Do not use for pure `.ts` changes that do not touch Creator serialized assets.
---

# Cocos AI Toolkit（直写档）

Use the Cocos MCP for Creator resources. Match namespaced tools by the `cocos_*` suffix.

## Non-negotiable boundary

禁止手写或直接编辑 `.prefab`、`.scene`、`.meta` JSON。不得使用 shell、脚本、Edit、Write 或 apply_patch 创建、修改、复制或格式化这些 Creator 序列化文件。

删除边界：只有 `.prefab` 必须通过 Creator/MCP 删除。非 Prefab 资源文件可以直接通过文件系统删除，无需 Creator/MCP；同时删除同名 `.meta` 文件（如存在）。这是整文件删除，不是手改 `.meta` JSON。删除前确认目标和引用，删除后检查 git 状态；Creator 正在运行时让 AssetDB 自动刷新，但 Creator 不可用不阻塞这类删除。

If MCP, Creator, Probe, Bridge, target identity, or write capability is unavailable for Prefab operations or serialized-content writes, 停下并报告阻塞. Never fall back to editing serialized JSON. This block does not apply to non-Prefab file deletion.

## 编辑主流程（按序组合）

1. `cocos_editor_list` 发现在线项目（按 projectPath 选择；同项目多实例时传 editorInstanceId）。Probe 离线时仍会返回空 editors 和 backend 状态；Bridge 启动 Probe 后同一任务自动恢复。
2. `cocos_editor_state` 确认当前文档 UUID、dirty 和 Scene/AssetDB ready。
3. `cocos_asset_search` 按名称/路径找 Prefab、Scene 或脚本 UUID（Bridge 内分页并复用短缓存）；`cocos_asset_inspect` 按 UUID 直接看类型、URL、依赖和 users，不要先取全量索引。
4. `cocos_prefab_open` / `cocos_scene_open` 仅在当前文档 clean 时打开目标文档。若返回 `DOCUMENT_SAVE_REQUIRED`，先调用 `cocos_document_save`，确认 dirty 已清除后再重试；工具不得先切换文档或触发原生保存框。
5. `cocos_hierarchy` 优先传 summary/fields/query 做紧凑寻址；`cocos_node_read` 优先用 summary/fields/propertyPaths 看节点；多节点用 `cocos_nodes_read`。这些投影会在 Bridge 内省略结构 raw；只有明确需要完整诊断时才使用无投影读取，必要时用 `maxOutputBytes` 调整 Bridge 发送前预算。
6. 写入：每步自动保存并逐项重读回显，响应里的 `verification.items` 就是生效证据。
7. 手工修改后显式落盘用 `cocos_document_save`；成功响应必须证明 dirty 已清除。
8. 需要视觉确认时：`cocos_preview_launch` 启动预览 → `cocos_runtime_capture` 截图 → `cocos_preview_stop` 收尾。

## Sprite 默认配置

创建 Sprite 节点、挂载 `cc.Sprite` 或设置 `spriteFrame` 时，除非用户明确要求固定/自定义尺寸或裁剪，否则必须：

1. 先设置 `spriteFrame`，再把 `sizeMode` 设为 `Sprite.SizeMode.RAW`（写入值 `2`），使用图片原始尺寸。
2. 把 `trim` 设为 `false`，确保 Inspector 中的 `Trim` 不勾选。
3. 不得自行修改 `UITransform.contentSize`，也不得改用 `CUSTOM` 或 `TRIMMED`；写后重读 `cc.Sprite.sizeMode` 和 `cc.Sprite.trim`，确认值分别为 `2` 和 `false`。

## 写入工具

| Intent | Tool |
| --- | --- |
| 打开扩展管理器 | `cocos_extension_manager_open`（直接打开目标 Creator 的内置扩展管理器；不修改项目或扩展启用状态） |
| 创建节点 | `cocos_node_create`（parentUuid 或 parentPath，二选一） |
| 重命名节点 | `cocos_node_rename`（nodeUuid 或 path 二选一） |
| 修改节点局部变换 | `cocos_node_set_transform`（nodeUuid 或 path 二选一；position/rotation/scale 至少一项） |
| 选择节点 | `cocos_node_select`（nodeUuid 或 path 二选一；清空旧选择后单选目标，不保存文档） |
| 删除节点及子树 | `cocos_node_delete` |
| 迁移节点 | `cocos_node_reparent`（源节点和新父节点分别支持 UUID/路径二选一，可选 siblingIndex） |
| 挂载组件 | `cocos_component_add`（自定义脚本组件必须给 scriptUuid，用 asset_search 查） |
| 改组件属性值 | `cocos_component_set_property`（propertyPath 支持 `items[2]` 嵌套；expectedOldValue 不一致会拒绝写入） |
| 实例化 Prefab | `cocos_prefab_instantiate`（prefabUuid + parentUuid/parentPath 二选一；保存重开后返回 nodeUuid、instanceFileId 和 stablePath） |
| 移除 Prefab 关联 | `cocos_prefab_unpack`（nodeUuid/path 二选一；current 仅当前关联，complete 递归移除嵌套关联；必须传 expectedPrefabAssetUuid） |
| 节点生成 Prefab | `cocos_prefab_create`（assetUrl 必须 `db://assets/` 且 `.prefab` 后缀；自动保存、重开，dirty 时补保存，再验证重建实例、资产身份和 clean 状态） |
| 重命名 Prefab | `cocos_prefab_rename`（uuid + 不含路径和 `.prefab` 后缀的 newName；Creator AssetDB 保持 UUID 并拒绝覆盖） |
| 保存当前文档 | `cocos_document_save`（Prefab/Scene 通用；写工具已自动保存，此入口用于手工改动落盘并验证 dirty 已清除） |
| 删除 Prefab | `cocos_prefab_delete`（不可回滚；传精确 `confirmAssetUrl`，有引用时再传 `confirmReferenced:true`） |
| 导入外部文件 | `cocos_asset_import`（图片/音频等，复制进 assets 并导入） |
| 重导入+触发编译 | `cocos_asset_refresh`（脚本改动后调用） |
| 一次直发多项写操作 | `cocos_batch_write`（仅接受 `node.*` 与 `component.*`；`asset.*` / `prefab.*` 会以 `BATCH_WRITE_OPERATION_NOT_ALLOWED` 拒绝；只减少往返，不是事务、无回滚，失败时已执行项可能已生效） |

节点寻址严格要求 `nodeUuid` 或 `path` 二选一（如 `Root/Panel/Button`）；组件类型兼容 `cc.` 前缀（`Label` = `cc.Label`）。
`cocos_node_read` 的 `prefabInstance` 直接给出实例根、源 UUID、instanceFileId、state 和 sourceUrl；`includeBounds` 可返回 local/world rect 与 anchor，按需追加后代并集和 `relativeToPath` 坐标。`cocos_nodes_read` 最多 32 项、默认并发 4，保持输入顺序且单项失败不会丢失其它结果。

`cocos_node_read` / `cocos_nodes_read` 的 `writeCapabilities` 会标明当前文档可直接执行的节点和组件写入。遇到关闭能力或 `NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT` 时，读取 `ownerPrefabUuid`、`ownerSourceUrl` 和 `nextAction`，确认后显式调用 `cocos_prefab_open` 打开源 Prefab；禁止自动切换文档。文档身份未知时继续依赖写后重读验证。

## 写入纪律

- 直写没有事务和回滚：失败即停，已生效修改保留。误操作只能用 git 还原，动手前确认目标工作区状态。
- 旧事务、Revision 前置、Undo 编排、inverse 和 transaction status 已彻底移除；禁止设计或调用兼容入口。
- Creator 对部分写入会静默不生效（典型：预制体编辑模式下嵌套实例内部）。工具写完会逐项重读，重读不符报 `DIRECT_WRITE_VERIFY_FAILED`——看到这个错不要当成已写入，换路径（如打开内层 Prefab 直接改）再写。
- `NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT`——当前 Prefab 只承载嵌套实例，目标内容必须路由到源 Prefab；按错误中的 `route` 重新打开和读取，禁止原地重试。
- `DIRECT_WRITE_OUTCOME_UNKNOWN` 表示操作已执行但保存/验证结局未知；先重读当前文档状态，确认前禁止重试。
- `DOCUMENT_SAVE_REQUIRED` 表示当前文档 dirty，打开工具尚未切换目标文档；先保存，确认 clean 后再重试。
- `cocos_prefab_create` 重开后若仍 dirty 会自动补保存；补保存后仍 dirty 才返回 `DOCUMENT_DIRTY_AFTER_PREFAB_CREATE`。`DOCUMENT_DIRTY_AFTER_SAVE` 同样不能当成成功；先重读并处理当前文档，确认前不要重复创建同一路径 Prefab。
- 运行期节点/组件 UUID 每次重开文档都会变，禁止缓存；每个编辑会话内现取 hierarchy。
- 连续多处修改时按"先读后写、逐项确认"推进；`cocos_batch_write` 仅接受 `node.*` 与 `component.*` 操作，是单次请求直发多项操作，不是批量暂存、事务或回滚。
- 错误码都带下一步指引：`NODE_NOT_FOUND` 重取 hierarchy、`COMPONENT_NOT_FOUND` 会附可用组件清单、`ASSET_NOT_PREFAB` / `ASSET_NOT_SCENE` 用 asset_inspect 核对类型、`ASSET_ALREADY_EXISTS` 换 URL；Prefab 删除先处理 `PREFAB_DELETE_CONFIRMATION_REQUIRED`，有引用再处理 `PREFAB_REFERENCES_CONFIRMATION_REQUIRED`。
- 工具失败优先读取 `structuredContent.error` 的 `code/details/stage/nextAction/retryable`；文本块只用于人读兼容，不要按冒号拆错误码。

## 运行态工具

只读组：`cocos_preview_sessions`、`cocos_runtime_get_hierarchy`、`cocos_runtime_inspect_component`、`cocos_runtime_get_console`、`cocos_runtime_watch_property`、`cocos_runtime_capture`（Game 视图截图，支持多分辨率、裁剪、节点边界叠加）。

截图默认每会话保留 100 张、全局保留 50 会话/14 天。报告盘点只运行 `npm run reports:doctor`；归档和清理必须显式确认。

动作组（--enable-writes）：`cocos_preview_launch/stop`、`cocos_runtime_invoke_method`、`cocos_runtime_sample_window`、`cocos_runtime_dispatch_input`（坐标是画布 CSS 像素）、`cocos_runtime_instantiate_prefab`、`cocos_runtime_run_scenario`。Scenario 精确步骤为 `launch`、`wait-node`、`assert-property`、`dispatch-input`、`instantiate-prefab`、`assert-console`、`capture`、`assert-image-diff`、`stop`；用 `stop(always:true)` 确保前序失败后仍关闭 Preview。

视觉结果仅作辅助证据；结构化状态以 Creator 编辑态重读为准。
