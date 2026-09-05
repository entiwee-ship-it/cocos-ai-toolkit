# Cocos AI Toolkit 使用手册

本文描述当前 `0.9.x` 直写架构。

所有 MCP 工具默认公开注册，不再使用 `--enable-writes` 或 `-Readonly`；升级后重新运行 Codex 安装脚本以移除旧配置参数。

## 1. 核心边界

- Prefab、Scene、Meta 的序列化内容禁止直接手写，必须通过 Creator Bridge。
- 只有 Prefab 整文件删除必须走 `cocos_prefab_delete`。普通资源文件可直接通过文件系统删除，并同时删除同名 `.meta`；这是整文件删除，不是编辑 Meta JSON。
- 每次直写按顺序执行操作，随后保存并逐项重读验证；失败即停，已执行项不会自动恢复。
- `DIRECT_WRITE_OUTCOME_UNKNOWN` 表示写入可能已经生效。先用 `cocos_editor_state`、`cocos_hierarchy`、`cocos_node_read` 或 `cocos_asset_inspect` 重读，确认前禁止重试。
- 节点寻址严格要求 UUID 或 path 二选一。运行期 UUID 会随文档重开变化，跨会话使用 path 或重新读取 hierarchy。

Creator Bridge 使用 Windows Named Pipe 接受单次短连接，不需要启动端口服务。可从 Creator 顶部菜单 **Cocos AI → 打开工具管理** 打开独立窗口，查看版本、发布日期、项目身份、直连状态、当前文档和 Preview 状态。

## 2. 标准编辑流程

1. `cocos_editor_list`：选择在线 Creator；同项目多实例时记录 `editorInstanceId`。
2. `cocos_editor_state`：确认当前文档 UUID、dirty、Scene/AssetDB ready。
3. `cocos_asset_search`：按名称或路径寻找 Prefab、Scene、脚本 UUID；搜索在 Bridge 内分页并复用短缓存，不再把全量索引传给 MCP。
4. `cocos_asset_inspect`：按 UUID 直接读取资产类型、URL、依赖和反向使用者，不需要先调用或传输完整资产索引。
5. `cocos_asset_manage`：通过 Creator AssetDB 移动、重命名或删除资源。移动传 `targetFolderUrl`，重命名传 `newName`；删除必须传回读得到的 `confirmAssetUrl`，存在反向引用时还需 `confirmReferenced=true`。文件夹删除不开放，子资源和只读资源会被拒绝。
6. `cocos_prefab_open` 或 `cocos_scene_open`：仅在当前文档 clean 时打开目标文档；收到 `DOCUMENT_SAVE_REQUIRED` 时先调用 `cocos_document_save`，确认 dirty 已清除后再重试。
7. `cocos_hierarchy`：优先传 `summary`、`fields` 或 `query` 读取紧凑节点树；`cocos_node_read` 优先使用 `summary/fields/propertyPaths` 查看单节点；多节点使用 `cocos_nodes_read`。这些投影会在 Bridge 内直接省略结构 raw；完整无投影调用返回完整结构，并可用 `maxOutputBytes` 调整 Bridge 发送前预算。
8. 调用写工具；成功响应中的 `outcome.verification.items` 是保存后重读证据。
9. 手工编辑后需要显式落盘时调用 `cocos_document_save`；工具会重读并确认 dirty 已清除。

`cocos_prefab_create` 复用直写通道执行 `prefab.create_from_node`，自动保存并重开验证重建后的 Prefab 实例；若重开后 dirty，会自动补一次保存并再次确认 clean，仍 dirty 才返回 `DOCUMENT_DIRTY_AFTER_PREFAB_CREATE`。`cocos_document_save` 保存后仍 dirty 会返回 `DOCUMENT_DIRTY_AFTER_SAVE`，都不能当成成功。
10. 需要视觉或交互验证时运行 Preview 工具，最后用 `cocos_preview_stop` 清理会话。

Creator 未打开或 Bridge 未启用时，MCP 仍会正常注册 42 个公开工具；`cocos_editor_list` 返回空 `editors` 和 `backend` IPC 状态。Creator Bridge 发布 Named Pipe 端点后，同一 MCP 任务会立即发现，不需要重新加载工具表。其它工具在 Creator 不可达时通过 `structuredContent.error.code=CREATOR_IPC_UNAVAILABLE` 返回可重试错误。

`cocos_nodes_read` 默认并发 4，仍保持输入顺序、单项错误隔离、32 项上限和输出预算。所有工具失败都同时提供人读文本与 `structuredContent.error`；程序应读取 `code/details/stage/nextAction/retryable`。

## 3. 编辑态工具

工具分组（全部默认公开）：

只读工具：

- `cocos_editor_list`、`cocos_editor_state`、`cocos_extension_manager_open`
- `cocos_asset_search`、`cocos_asset_inspect`
- `cocos_prefab_open`、`cocos_scene_open`
- `cocos_hierarchy`、`cocos_node_read`、`cocos_nodes_read`

编辑器写入工具：

- 节点：`cocos_node_create`、`cocos_node_rename`、`cocos_node_set_transform`、`cocos_node_select`、`cocos_node_reparent`、`cocos_node_delete`
- 组件：`cocos_component_add`、`cocos_component_set_property`
- Prefab：`cocos_prefab_instantiate`、`cocos_prefab_unpack`、`cocos_prefab_create`、`cocos_prefab_rename`、`cocos_prefab_delete`
- 文档与资源：`cocos_document_save`、`cocos_asset_import`、`cocos_asset_refresh`
- 多操作：`cocos_batch_write`，只接受 `node.*` 和 `component.*`；它只减少往返，不提供原子提交或回滚。

组件事件默认写入 Inspector，而不是在脚本生命周期中注册监听：`Button.clickEvents`、`Toggle.checkEvents` 等事件数组使用 `Component.EventHandler`，字段为 `target/component/handler/customEventData`。先读取并保留已有数组项，再用 `cocos_component_set_property` 写完整数组并传 `expectedOldValue`；`component` 必须是精确 `@ccclass` 注册名。只有动态创建或回收的节点、运行时才能确定的目标、没有可序列化事件口的底层手势或全局事件才使用 `node.on(...)`。

Prefab 实例化使用 `prefabUuid + parentUuid/parentPath`，成功后直接读取返回的 `nodeUuid`、`instanceFileId` 和 `stablePath`；不要从创建瞬间缓存 UUID。解包使用 `cocos_prefab_unpack`：`current` 仅解除所选实例，`complete` 同时解除子树内嵌套实例；两种模式都必须传当前源资产 UUID 作为乐观锁。Prefab 重命名使用 `uuid + newName`，只修改原目录内文件名。Creator AssetDB 会拒绝覆盖已有目标，并验证移动后 UUID 不变。

`cocos_node_read` 的 `prefabInstance` 提供实例根、源 UUID、instanceFileId、state 和 sourceUrl。需要布局证据时传 `includeBounds`；可追加后代可视并集和 `relativeToPath`。`cocos_nodes_read` 最多读取 32 项，按 nodeUuids 后接 paths 的顺序逐项返回，单项错误和输出截断都会显式标记。

`writeCapabilities` 是当前文档的写入适用性快照。Prefab 编辑模式下，嵌套实例根只开放 Creator 已确认有效的整实例与放置类操作，实例内容节点会关闭节点和组件写入，并通过 `nextAction` 指向 `cocos_prefab_open`。调用方应显式决定是否打开源 Prefab，Toolkit 不会自动切换文档；文档身份未知时仍由写后重读验证兜底。

## 4. Preview 与运行态验证

常用顺序：

1. `cocos_preview_launch`
2. `cocos_runtime_get_hierarchy` / `cocos_runtime_inspect_component`
3. `cocos_runtime_dispatch_input` / `cocos_runtime_invoke_method`
4. `cocos_runtime_capture` / `cocos_runtime_get_console`
5. `cocos_preview_stop`

`cocos_runtime_run_scenario` 支持 `launch`、`wait-node`、`assert-property`、`dispatch-input`、`instantiate-prefab`、`assert-console`、`capture`、`assert-image-diff`、`stop`。用 `stop(always:true)` 保证前序失败后仍关闭 Preview。

截图写入运行 Worktree 的 `reports/runtime-captures`，每个会话保留最近 100 张，全局最多保留 50 个会话且最长保留 14 天。关闭会话后工具会同时关闭页面、浏览器并移除会话记录。报告盘点使用只读 `npm run reports:doctor`；归档和清理默认 dry-run，只有显式 `--confirm` 才会修改 `reports/archive`。

## 5. 常见错误

| 错误码 | 处理 |
| --- | --- |
| `EDITOR_INSTANCE_NOT_FOUND` | 启动 Creator/Bridge，重新调用 `cocos_editor_list`。 |
| `MULTIPLE_EDITOR_INSTANCES` | 补传 `editorInstanceId`。 |
| `DOCUMENT_SAVE_REQUIRED` | 当前文档 dirty，工具未切换目标文档；先调用 `cocos_document_save`，确认 clean 后重试。 |
| `DOCUMENT_DIRTY_AFTER_PREFAB_CREATE` | Prefab 直写已执行，但文档 clean 校验失败；先保存并重读，确认前不要重复创建同一路径。 |
| `DOCUMENT_DIRTY_AFTER_SAVE` | Creator 接受了保存请求但 dirty 未清除；检查当前文档与原生保存提示后再保存。 |
| `NODE_ADDRESS_EXCLUSIVE` | UUID/path 只保留一个。 |
| `NODE_NOT_FOUND` | 重新读取 hierarchy，不要复用过期 UUID。 |
| `NODE_NOT_EDITABLE_IN_CURRENT_DOCUMENT` | 读取 `writeCapabilities` 和错误中的 `route`，确认后用 `cocos_prefab_open` 打开源 Prefab；不要原地重试。 |
| `PREFAB_IDENTITY_MISMATCH` | 当前节点的源 Prefab 已变化；重新读取实例元数据后再决定是否解包。 |
| `COMPONENT_NOT_FOUND` | 使用错误中返回的组件候选重新选择。 |
| `ASSET_NOT_PREFAB` / `ASSET_NOT_SCENE` | 用 `cocos_asset_inspect` 核对 UUID 和资产类型。 |
| `ASSET_ALREADY_EXISTS` | 选择新的目标名称或 URL。 |
| `PREFAB_DELETE_CONFIRMATION_REQUIRED` | 传入工具返回的精确 `confirmAssetUrl`。 |
| `PREFAB_REFERENCES_CONFIRMATION_REQUIRED` | 检查 users 后，只有确认影响可接受时传 `confirmReferenced:true`。 |
| `DIRECT_WRITE_VERIFY_FAILED` | Creator 写入未通过重读；换到真正拥有该节点的 Prefab/Scene 后重试。 |
| `DIRECT_WRITE_OUTCOME_UNKNOWN` | 先重读当前状态，确认前禁止重试。 |
| `PREVIEW_SESSION_NOT_FOUND` / `PREVIEW_SESSION_LOST` | 重新 launch Preview，不复用旧 sessionId。 |

## 6. 运行时同步与健康检查

Codex MCP 和 Creator Bridge 必须共同指向固定运行 Worktree：

```text
E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0
```

更新和验证：

```powershell
& E:/xile-workspace/GitHub/cocos-ai-toolkit/scripts/update-runtime.ps1
& E:/xile-workspace/GitHub/cocos-ai-toolkit/scripts/check-codex-mcp.ps1
npm run smoke:creator:write-routing
```

健康检查会验证 MCP 工具精确集合、Creator 在线状态、Bridge 版本、Bridge 内容构建指纹、精确 capability 集合以及项目 Bridge Junction 的运行时目标。Bridge 构建不匹配时刷新或重启 Creator 扩展，再重新检查。
