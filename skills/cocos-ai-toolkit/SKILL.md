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

1. `cocos_editor_list` 发现在线项目（按 projectPath 选择；同项目多实例时传 editorInstanceId）。
2. `cocos_asset_search` 按名称/路径找 Prefab 或脚本 UUID。
3. `cocos_prefab_open` 打开目标 Prefab，等待文档身份就绪。
4. `cocos_hierarchy` 读节点树寻址（节点 uuid、路径、组件清单）。
5. `cocos_node_read` 看节点详情；加 `componentType` 参数时返回该组件完整属性（改属性前先看现值）。
6. 写入：每步自动保存并逐项重读回显，响应里的 `verification.items` 就是生效证据。
7. 需要视觉确认时：`cocos_preview_launch` 启动预览 → `cocos_runtime_capture` 截图 → `cocos_preview_stop` 收尾。

## 写入工具

| Intent | Tool |
| --- | --- |
| 创建节点 | `cocos_node_create`（parentUuid 或 parentPath，二选一） |
| 重命名节点 | `cocos_node_rename`（nodeUuid 或 path 二选一） |
| 修改节点局部变换 | `cocos_node_set_transform`（nodeUuid 或 path 二选一；position/rotation/scale 至少一项） |
| 删除节点及子树 | `cocos_node_delete` |
| 迁移节点 | `cocos_node_reparent`（源节点和新父节点分别支持 UUID/路径二选一，可选 siblingIndex） |
| 挂载组件 | `cocos_component_add`（自定义脚本组件必须给 scriptUuid，用 asset_search 查） |
| 改组件属性值 | `cocos_component_set_property`（propertyPath 支持 `items[2]` 嵌套；expectedOldValue 不一致会拒绝写入） |
| 节点生成 Prefab | `cocos_prefab_create`（assetUrl 必须 `db://assets/` 且 `.prefab` 后缀） |
| 重命名 Prefab | `cocos_prefab_rename`（uuid + 不含路径和 `.prefab` 后缀的 newName；Creator AssetDB 保持 UUID 并拒绝覆盖） |
| 保存当前文档 | `cocos_prefab_save`（写工具已自动保存，此入口用于手工改动落盘） |
| 删除 Prefab | `cocos_prefab_delete`（不可回滚；传精确 `confirmAssetUrl`，有引用时再传 `confirmReferenced:true`） |
| 导入外部文件 | `cocos_asset_import`（图片/音频等，复制进 assets 并导入） |
| 重导入+触发编译 | `cocos_asset_refresh`（脚本改动后调用） |
| 一次直发多项写操作 | `cocos_batch_write`（仅接受 `node.*` 与 `component.*`；`asset.*` / `prefab.*` 会以 `BATCH_WRITE_OPERATION_NOT_ALLOWED` 拒绝；只减少往返，不是事务、无回滚，失败时已执行项可能已生效） |

节点寻址同时接受 `nodeUuid` 或 `path`（如 `Root/Panel/Button`）；组件类型兼容 `cc.` 前缀（`Label` = `cc.Label`）。

## 写入纪律

- 直写没有事务和回滚：失败即停，已生效修改保留。误操作只能用 git 还原，动手前确认目标工作区状态。
- Creator 对部分写入会静默不生效（典型：预制体编辑模式下嵌套实例内部）。工具写完会逐项重读，重读不符报 `DIRECT_WRITE_VERIFY_FAILED`——看到这个错不要当成已写入，换路径（如打开内层 Prefab 直接改）再写。
- `DIRECT_WRITE_OUTCOME_UNKNOWN` 表示操作已执行但保存/验证结局未知；先重读当前文档状态，确认前禁止重试。
- 运行期节点/组件 UUID 每次重开文档都会变，禁止缓存；每个编辑会话内现取 hierarchy。
- 连续多处修改时按"先读后写、逐项确认"推进；`cocos_batch_write` 仅接受 `node.*` 与 `component.*` 操作，是单次请求直发多项操作，不是批量暂存、事务或回滚。
- 错误码都带下一步指引：`NODE_NOT_FOUND` 重取 hierarchy、`COMPONENT_NOT_FOUND` 会附可用组件清单、`ASSET_ALREADY_EXISTS` 换 URL、`PREFAB_OPEN_NOT_READY` 核对 UUID 重试；Prefab 删除先处理 `PREFAB_DELETE_CONFIRMATION_REQUIRED`，有引用再处理 `PREFAB_REFERENCES_CONFIRMATION_REQUIRED`。

## 运行态工具

只读组：`cocos_preview_sessions`、`cocos_runtime_get_hierarchy`、`cocos_runtime_inspect_component`、`cocos_runtime_get_console`、`cocos_runtime_watch_property`、`cocos_runtime_capture`（Game 视图截图，支持多分辨率、裁剪、节点边界叠加）。

动作组（--enable-writes）：`cocos_preview_launch/stop`、`cocos_runtime_invoke_method`、`cocos_runtime_sample_window`、`cocos_runtime_dispatch_input`（坐标是画布 CSS 像素）、`cocos_runtime_instantiate_prefab`、`cocos_runtime_run_scenario`。Scenario 精确步骤为 `launch`、`wait-node`、`assert-property`、`dispatch-input`、`instantiate-prefab`、`assert-console`、`capture`、`assert-image-diff`、`stop`；用 `stop(always:true)` 确保前序失败后仍关闭 Preview。

视觉结果仅作辅助证据；结构化状态以 Creator 编辑态重读为准。
