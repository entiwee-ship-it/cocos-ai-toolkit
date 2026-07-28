---
name: cocos-ai-toolkit
description: Use when a task creates, generates, composes, arranges, inspects, edits, or validates Cocos Creator 3.8.x scenes, Prefabs, UI hierarchy, nodes, components, Inspector properties, asset references, or Preview behavior; also use for 创建、新建、生成、搭建、编排、调整、查看或验证场景/预制体 and any `.prefab`, `.scene`, or `.meta` work. Do not use for pure `.ts` edits that do not touch Creator serialized assets.
---

# Cocos AI Toolkit 使用技能

通过 Cocos MCP（工具名以 `cocos_*` 结尾）操作 Cocos Creator 编辑器和 Preview 运行时。

## 不可降级边界

**创建、修改或删除 `.prefab`、`.scene`、`.meta` 时，必须使用 Cocos MCP。** 工具在不同 Agent 中可能显示为 `cocos_editor_list`、`mcp__cocos_ai__cocos_editor_list` 或其它带命名空间的名称；按 `cocos_*` 后缀匹配。

不得使用 Edit、Write、apply_patch、shell、脚本或其它通用文件工具直接生成、替换、格式化或编辑 Cocos 序列化 JSON，也不得回退为手写 JSON。即使改动很小、时间紧、MCP 调用较多，或者 `.prefab` 看起来像普通 JSON，也没有例外。

在任何 Creator 资源操作前先调用 `cocos_editor_list`。出现以下任一情况时立即停止并向用户报告阻塞，不得改文件作为替代方案：

- 没有列出目标 Creator 实例；
- 所需 `cocos_*` 工具未注册或写工具未开放；
- 无法确认当前文档、目标节点、组件、资产或 revision；
- 事务进入 `outcome-unknown` 或 `manual-recovery-required`。

纯 `.ts` 源码修改且不触碰 Creator 序列化资源时，不使用本技能。

## 任务路由

| 用户意图 | 必经 MCP 路径 |
| --- | --- |
| 查找、打开、查看、检查或分析资产 | `cocos_editor_list` → `cocos_editor_state` → `cocos_asset_search` → `cocos_asset_open`（需要在 Creator 中打开时）→ `cocos_asset_inspect` / `cocos_document_snapshot` / `cocos_component_schema` |
| 修改或编排既有 Prefab / Scene | `cocos_editor_list` → `cocos_editor_state` → `cocos_design_inspect` → `cocos_design_plan` → `cocos_design_preview` → `cocos_design_apply` → `cocos_design_verify` |
| 从已有节点创建新的 Prefab 资产 | `cocos_editor_list` → `cocos_editor_state` → `cocos_document_snapshot` → `cocos_write_prepare`（`prefab.create_from_node`）→ `cocos_write_confirm` → 重读验证 |
| 验证 Preview 运行时 | `cocos_preview_launch` → runtime 读取/动作/取证工具 → `cocos_preview_stop` |

## 开工检查

1. 调用 `cocos_editor_list`，按 `projectPath` 选择目标实例并记录 `projectId`；同项目多实例时同时记录 `editorInstanceId`。
2. 调用 `cocos_editor_state`，确认 Creator、AssetDB、当前文档和选区状态。需要切换文档时，先用 `cocos_asset_search` 取得真实 UUID，再调用 `cocos_asset_open`；写入前必须重新读取状态，确认当前打开的资产就是目标 Prefab 或 Scene。
3. 用 `cocos_document_snapshot`、`cocos_component_schema` 或 `cocos_design_inspect` 取得真实 UUID、fileId、属性和引用；不得从磁盘 JSON 猜值。
4. Preview 工具必须先用 `cocos_preview_launch` 获取 `sessionId`；已有会话用 `cocos_preview_sessions` 查找。

## 修改或编排既有 Prefab / Scene

优先用声明式流程。先 inspect，再把 inspect/export 得到的真实 fileId、path 和资产 UUID 写进目标；同一份 target 依次传给 plan、preview、apply、verify。

```json
{
  "projectId": "<cocos_editor_list 返回的 projectId>",
  "target": {
    "document": {
      "scope": "current-document",
      "assetUuid": "<当前文档 assetUuid>"
    },
    "tree": [
      {
        "id": "$root",
        "fileId": "<inspect 返回的根节点 fileId>",
        "path": "Canvas",
        "name": "Canvas",
        "match": "fileId",
        "children": [
          {
            "id": "$title",
            "fileId": "<Title 节点 fileId>",
            "path": "Canvas/Title",
            "name": "Title",
            "match": "fileId",
            "components": [
              {
                "type": "cc.Label",
                "properties": { "fontSize": 28 }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

`$` 逻辑 ID 只用于本次声明式目标和引用接线，不能当作 Creator UUID。`cocos_design_preview` 只预览，不得跳过后直接 apply；apply 后必须用 `cocos_design_verify` 独立重读。

## 创建新的 Prefab 资产

只能从 Creator 当前文档中已经存在的节点生成 Prefab。若节点尚不存在，先通过声明式流程在当前文档创建并验证，再用 `cocos_document_snapshot` 取得最新节点 UUID。不要创建空 `.prefab` 文件或复制其它 Prefab JSON。

调用 `cocos_write_prepare` 的最小参数形态：

```json
{
  "projectId": "<projectId>",
  "transactionId": "create-prefab-<unique-id>",
  "idempotencyKey": "create-prefab-<same-unique-id>",
  "revision": {
    "document": null,
    "hierarchy": null,
    "assetDatabase": null,
    "scriptCompilation": null
  },
  "operations": [
    {
      "type": "prefab.create_from_node",
      "nodeUuid": "<snapshot 中目标节点 UUID>",
      "assetUrl": "db://assets/prefab/NewPanel.prefab"
    }
  ],
  "save": true,
  "undoGroup": "create-prefab"
}
```

如果当前 MCP 返回了各 revision 维度的真实值，用真实值替换对应 `null`；不得从磁盘内容自行计算或伪造。`cocos_write_prepare` 返回 validated 后才调用 `cocos_write_confirm`。确认后重新搜索资产并重读文档；`create_from_node` 可能重建节点并改变运行时 UUID，禁止继续复用旧 UUID。

确认返回非 committed、连接中断或验证失败时，先用 `cocos_transaction_status` 查状态并保留事务 ID。只有工具明确返回可回滚状态时才调用 `cocos_transaction_rollback`；`outcome-unknown` / `manual-recovery-required` 必须停手。

## Preview 运行时验证

- 读取层级：优先 `cocos_runtime_get_hierarchy` 的 `path` + `includeInactive:false`，不要默认拉全树。
- 检查组件与日志：用 `cocos_runtime_inspect_component` 和带 seq 游标的 `cocos_runtime_get_console`。
- 派发输入：`cocos_runtime_dispatch_input` 的回执不代表游戏响应，必须后续断言。
- 验证动画：优先 `cocos_runtime_sample_window`，在单次调用内触发并逐帧采样；静态截图不能证明过程。
- 回归编排：可用 `cocos_runtime_run_scenario` 组合等待、输入、断言、截图和图像差异。

## 写入与取证纪律

1. 先读再写；写前确认文档身份，写后重新读取结构化数据。
2. `cocos_design_apply` 后独立 verify；`cocos_write_confirm` 后 snapshot / asset inspect 核对关键节点、组件、引用和资产。
3. 结构化属性、层级和控制台是真值；截图只作辅助证据。
4. 修复后重新取得完整证据，不能复用修复前的快照或截图。
5. revision 冲突时重新读取并重新 plan/prepare，禁止强行 confirm。

## 常见错误判断

| 错误想法 | 正确处理 |
| --- | --- |
| “只是改一个字段，直接改 JSON 更快” | 仍走 MCP；Creator 序列化资源不是普通业务 JSON。 |
| “MCP 当前不可用，先手写再说” | 停止并报告阻塞，不得降级。 |
| “文件 diff 看起来正常，所以验证通过” | 必须让 Creator/MCP 重读并验证。 |
| “点击工具返回成功，所以交互生效” | 后续检查属性、层级、日志或画面断言。 |

## 环境维护

技能只描述使用纪律，不代替运行环境。MCP Server、Probe Server、Bridge Extension 和 Creator 必须分别就绪。仓库或 MCP 构建更新后，按部署脚本重建运行时并重启 Agent 会话；Bridge 更新后刷新或重启 Creator 扩展。
