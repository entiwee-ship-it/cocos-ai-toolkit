# Cocos AI Toolkit 使用手册

> **0.3.0 归档说明**：本文其余章节描述的是 0.2.x 事务/声明式（prefab/full profile）调用方式，已随直写架构移除，保留供查阅。当前版本（0.3.0+）请按下节"直写档最小用法"操作；工具总表见仓库 README 和 `skills/cocos-ai-toolkit/SKILL.md`。

## 0. 直写档最小用法（0.3.0+）

1. `cocos_editor_list` → 记录 `projectId`（多实例同时记 `editorInstanceId`）。
2. `cocos_asset_search`（pattern 传名称/路径）→ 拿到 Prefab 或脚本 UUID。
3. `cocos_prefab_open`（uuid）→ 打开并等就绪。
4. `cocos_hierarchy` → 拿节点 uuid/path 和组件清单；`cocos_node_read`（可加 componentType）→ 看组件属性现值。
5. 写入（每次调用自动保存 + 逐项重读回显）：
   - 改属性：`cocos_component_set_property`（path 或 nodeUuid 寻址节点，componentType 兼容 cc. 前缀，propertyPath 支持 `items[2]`）
   - 建节点：`cocos_node_create`（parentUuid/parentPath + name）
   - 挂组件：`cocos_component_add`（内置组件给 componentType；自定义脚本组件另给 scriptUuid）
   - 删节点：`cocos_node_delete`
   - 节点转 Prefab：`cocos_prefab_create`（assetUrl 必须 `db://assets/*.prefab`）
   - 删 Prefab：`cocos_prefab_delete`（uuid；不可回滚、不查引用）
   - 导入文件：`cocos_asset_import`（sourceFilePath + assetUrl）
   - 重导入/编译：`cocos_asset_refresh`（assetUrl）
6. 视觉验证：`cocos_preview_launch` → `cocos_runtime_capture` → `cocos_preview_stop`。

错误处理：`NODE_NOT_FOUND` 重取 hierarchy；`COMPONENT_NOT_FOUND` 附可用清单；`DIRECT_WRITE_VERIFY_FAILED` 表示 Creator 静默未生效（典型为预制体编辑模式下嵌套实例内部），换路径再写；`ASSET_ALREADY_EXISTS` 换 URL。直写无回滚，误操作用 git 还原。

---

本文面向 Cocos Creator 3.8.8 项目，给出 Prefab 新建、子树抽取、嵌套实例 Override、引用数组、Enum/嵌套对象，以及写后 Preview 验证的标准调用顺序。

## 1. 开始前

1. 启动 Creator，并确认项目中的 Cocos AI Bridge 已启用。
2. 启动 Probe Server 和 MCP Server；写操作必须带 `--enable-writes`。
3. 调用 `cocos_editor_list`，记录目标 `projectId`；同一项目有多个 Creator 时同时传 `editorInstanceId`。
4. 先 `mode: "preview"`，检查差异、风险、引用影响和返回的 revision，再用完全相同的目标调用 `mode: "apply"`。
5. 所有 Prefab、Scene 和 Meta 写入都必须经过 Creator/AssetDB；不要直接修改 `.prefab`、`.scene` 或 `.meta` 文件。

默认 `prefab` profile 提供 4 个只读工具和 7 个写工具。需要底层 design、transaction 或 runtime 工具时使用 `--profile full`。

## 2. 新建界面 Prefab

### 2.1 创建目录

先预览，再执行：

```json
{
  "tool": "cocos_asset_create",
  "arguments": {
    "projectId": "<projectId>",
    "assetUrl": "db://assets/game/ui/example",
    "assetKind": "folder",
    "mode": "preview"
  }
}
```

确认后把 `mode` 改为 `apply`。若目录已存在，保留原目录并跳过这一步。

### 2.2 创建 Prefab

`tree` 必须只有一个根节点，且根节点 `id` 必须等于 `rootId`。逻辑 ID 以 `$` 开头，可在同一目标内用于节点或组件引用。

```json
{
  "tool": "cocos_prefab_create",
  "arguments": {
    "projectId": "<projectId>",
    "assetUrl": "db://assets/game/ui/example/ExampleView.prefab",
    "rootId": "$root",
    "mode": "preview",
    "tree": [
      {
        "id": "$root",
        "name": "ExampleView",
        "components": [
          {
            "type": "cc.UITransform",
            "properties": {
              "contentSize": { "width": 1280, "height": 720 },
              "anchorPoint": { "x": 0.5, "y": 0.5 }
            }
          }
        ],
        "children": [
          {
            "id": "$title",
            "name": "Title",
            "components": [
              {
                "type": "cc.Label",
                "properties": {
                  "string": "示例界面",
                  "fontSize": 42,
                  "horizontalAlign": 1
                }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

检查 preview 后使用相同 `tree` 和 `rootId`，把 `mode` 改为 `apply`。最后调用 `cocos_prefab_verify` 传回同一棵目标树。

项目自己的 UIID、路由或业务注册表不是 Creator 序列化资产；由 AI 按项目源码约定修改对应 TypeScript/配置，再让 Creator 完成导入和编译。不要为了注册 UIID 直接手改 Prefab JSON。

## 3. 把现有子树抽成独立 Prefab

1. 用 `cocos_prefab_inspect` 读取源 Prefab，保留返回树中的 `fileId`、`path` 和逻辑结构。
2. 用 `cocos_prefab_edit` 提交完整目标树，并在 `operations` 中增加 `document.extract_subtree`。
3. 先 preview；确认新资产 URL、原位置替换和引用影响后再 apply。

```json
{
  "tool": "cocos_prefab_edit",
  "arguments": {
    "projectId": "<projectId>",
    "uuid": "<hostPrefabUuid>",
    "mode": "preview",
    "tree": [
      {
        "id": "$root",
        "fileId": "<rootFileId>",
        "name": "HostView",
        "children": [
          {
            "id": "$dialog",
            "fileId": "<dialogFileId>",
            "path": "HostView/Dialog",
            "name": "Dialog"
          }
        ]
      }
    ],
    "operations": [
      {
        "type": "document.extract_subtree",
        "nodeId": "$dialog",
        "assetUrl": "db://assets/game/ui/example/Dialog.prefab"
      }
    ]
  }
}
```

`nodeId` 必须出现在 `tree` 中。执行时 Creator 从该节点生成新 Prefab，并把原位置转换成 Prefab 实例；工具随后重读验证新资产、Meta UUID 和实例身份。

## 4. 编辑嵌套 Prefab 实例

`cocos_prefab_inspect` / `cocos_design_inspect` 会为实例内部节点返回 `prefabOverrideAddress`，包括实例根 UUID/路径和内部节点路径。把这些节点按原 `fileId`/`path` 放进目标树，修改属性或引用即可；计划会生成 `prefab.instance_override`，不会修改源 Prefab。

```json
{
  "tool": "cocos_prefab_edit",
  "arguments": {
    "projectId": "<projectId>",
    "uuid": "<hostPrefabUuid>",
    "mode": "preview",
    "tree": [
      {
        "id": "$root",
        "fileId": "<rootFileId>",
        "children": [
          {
            "id": "$avatarFrame",
            "fileId": "<instanceRootFileId>",
            "path": "HostView/AvatarFrame",
            "prefabInstance": { "assetUuid": "<avatarFramePrefabUuid>" },
            "children": [
              {
                "id": "$nameLabel",
                "fileId": "<internalLabelFileId>",
                "path": "HostView/AvatarFrame/NameLabel",
                "components": [
                  {
                    "type": "cc.Label",
                    "properties": { "fontSize": 30 }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

apply 后重读 `propertyOverrides`，目标记录应包含实例内部组件的 `localID[]` 和 `propertyPath`。要精确还原单个覆盖，用：

```json
{
  "type": "prefab.revert_override",
  "instanceRootId": "$avatarFrame",
  "targetId": "$nameLabel",
  "componentType": "cc.Label",
  "propertyPath": "fontSize"
}
```

## 5. 写入引用数组

组件 `references` 接受单引用或保持顺序的引用数组。数组整体作为一次声明写入，验证阶段逐项比较类型、UUID 和顺序。

```json
{
  "id": "$animation",
  "fileId": "<nodeFileId>",
  "components": [
    {
      "type": "ExampleFrameAnimation",
      "scriptUuid": "<componentScriptUuid>",
      "references": {
        "textureFrames": [
          {
            "kind": "asset",
            "assetUuid": "<frame0Uuid>",
            "subAssetUuid": null,
            "assetType": "cc.SpriteFrame",
            "path": "db://assets/textures/frame0/spriteFrame",
            "available": true
          },
          {
            "kind": "asset",
            "assetUuid": "<frame1Uuid>",
            "subAssetUuid": null,
            "assetType": "cc.SpriteFrame",
            "path": "db://assets/textures/frame1/spriteFrame",
            "available": true
          }
        ]
      }
    }
  ]
}
```

引用资产先用 `cocos_asset_search` / `cocos_asset_inspect` 查真实 UUID 和子资产 UUID，不要猜测 UUID。

## 6. Enum 与嵌套 ccclass 对象数组

Enum 按 Creator 序列化的数值写入。先用 `cocos_component_schema` 或 inspect 读取实际枚举值；不要发送显示文本。

```json
{
  "id": "$panel",
  "fileId": "<panelFileId>",
  "components": [
    {
      "type": "ExamplePanel",
      "scriptUuid": "<componentScriptUuid>",
      "properties": {
        "layoutMode": 2,
        "items": [
          { "name": "first", "mode": 1, "weight": 10 },
          { "name": "second", "mode": 2, "weight": 20 }
        ]
      },
      "references": {
        "items[0].icon": {
          "kind": "asset",
          "assetUuid": "<iconUuid>",
          "subAssetUuid": null,
          "assetType": "cc.SpriteFrame",
          "path": "db://assets/icons/first/spriteFrame",
          "available": true
        }
      }
    }
  ]
}
```

运行时值解析会递归处理数组和嵌套对象中的 Node、Component、Asset 引用；apply 后仍要使用 `cocos_prefab_verify` 或 `cocos_design_verify` 做独立重读。

## 7. 写完立即跑 Preview 验收

`--profile full --enable-writes` 下，`cocos_design_apply` 可带 `verifyPreview`。它在编辑态事务已经 committed 后复用 `cocos_runtime_run_scenario`，不会实现第二套运行时驱动。

```json
{
  "tool": "cocos_design_apply",
  "arguments": {
    "projectId": "<projectId>",
    "target": "<与 preview 完全相同的声明式目标>",
    "revision": {
      "document": "sha256:<preview 返回值>",
      "hierarchy": "sha256:<preview 返回值>",
      "assetDatabase": null,
      "scriptCompilation": null,
      "prefabGraph": "sha256:<preview 返回值>"
    },
    "verifyPreview": {
      "steps": [
        { "kind": "launch", "resolution": { "width": 1280, "height": 720 } },
        { "kind": "wait-node", "path": "Canvas/ExampleView", "timeoutMs": 15000 },
        {
          "kind": "assert-property",
          "path": "Canvas/ExampleView/Title",
          "property": "cc.Label.string",
          "expected": "示例界面"
        },
        { "kind": "capture", "overlay": { "nodeBounds": true } }
      ]
    }
  }
}
```

已有 Preview 会话时可传 `verifyPreview.sessionId` 并省略 `launch`。返回值分成两层：

- `result.status: "committed"`：编辑态写入已经提交。
- `previewVerification.report.passed`：运行态断言是否通过。

即使 Preview 连接中断，工具也保留 committed 结果，并返回 `PREVIEW_VERIFICATION_FAILED` 与重跑建议；不要因为运行态验证失败而重复执行已经提交的写入。

## 8. 错误码与下一步动作

| 错误码 | 触发条件 | 下一步动作 |
| --- | --- | --- |
| `EDITOR_INSTANCE_NOT_FOUND` | 没有匹配的 Creator | 启动 Creator/Bridge，调用 `cocos_editor_list` 后使用真实 `projectId`。 |
| `MULTIPLE_EDITOR_INSTANCES` | 同一选择器命中多个 Creator | 补传 `editorInstanceId`。 |
| `UNSUPPORTED_CREATOR_VERSION` | Creator 不是已验证的 3.8.8 | 切换到 3.8.8，或先完成新版本兼容验收。 |
| `TARGET_DOCUMENT_NOT_OPEN` | `current-document` 与目标 UUID 不一致 | 打开错误中的目标 `db://` 资产，或改用带目标 UUID 的 `source-prefab` 让工具自动打开。 |
| `TARGET_DOCUMENT_OPEN_IDENTITY_MISMATCH` | 自动打开后 AssetDB 身份仍不一致 | 停止写入，刷新 AssetDB，确认 UUID/路径后重新 inspect。 |
| `DESIGN_ROOT_NOT_FOUND` | 指定根 UUID/逻辑节点不在快照中 | 重新 inspect/export，使用返回的真实节点身份。 |
| `DESIGN_PLAN_UNRESOLVED` | 计划仍有缺失节点、组件、脚本或引用 | 检查 preview 的 `unresolved`，逐项补齐后再 apply。 |
| `DESIGN_REVISION_REQUIRED` / `DESIGN_REVISION_INCOMPLETE` | 非当前文档写入缺少完整 revision | 重跑 `cocos_design_preview`，原样传入 `preview.revision`。 |
| `REVISION_CONFLICT` / `REVISION_DOCUMENT_IDENTITY_MISMATCH` | preview 后文档、层级或资产已变化 | 丢弃旧 revision，重新 inspect/preview；不要强行重试旧写入。 |
| `ASSET_ALREADY_EXISTS` | 创建或移动目标 URL 已存在 | 选择新 URL，或 inspect 已有资产后改为 edit。 |
| `PREFAB_ROOT_ID_INVALID` | 新建 Prefab 不是单根，或 `rootId` 不等于根 ID | 只保留一个根节点，并让两个 ID 完全一致。 |
| `ASSET_CREATE_SOURCE_NODE_REQUIRED` | 试图用空 JSON 创建 Prefab | 使用 `cocos_prefab_create`，或传 Creator 当前文档中的真实 `sourceNodeUuid`。 |
| `ASSET_META_UUID_MUTATION_FORBIDDEN` | Meta 写入试图改变 UUID | 删除请求中的新 UUID；移动/重命名必须保持原 UUID。 |
| `ASSET_DELETE_CONFIRMATION_REQUIRED` / `PREFAB_DELETE_CONFIRMATION_REQUIRED` | 删除未精确确认 URL | 先 preview，把返回的精确 `assetUrl` 传入 apply。 |
| `*_REFERENCES_CONFIRMATION_REQUIRED` | 资产仍被引用且未确认 | 检查 preview 的 users；只有确认影响可接受时传 `confirmReferenced: true`。 |
| `WRITE_EXECUTION_TIMEOUT` / `WRITE_OUTCOME_UNCERTAIN` | 超时或连接中断，写入结局未知 | 立即查询 `cocos_transaction_status`；确认结局前禁止重试写入。 |
| `manual-recovery-required` | 回滚失败或写入结局无法证明 | 停止后续写入，保留事务证据，按 `failedStep.nextAction` 人工恢复。 |
| `PREVIEW_VERIFICATION_FAILED` | 编辑态已提交，但 Preview scenario 通道失败 | 恢复 Preview 后单独重跑 `cocos_runtime_run_scenario`，不要重复 apply。 |

所有事务失败都应优先读取：

- `failure.stage`：`plan`、`prepare`、`apply`、`save`、`verify` 或 `rollback`；
- `failure.inputSummary`：作用域、操作数、操作类型和保存策略；
- `failure.originalError`：Creator/Bridge 原始错误；
- `failure.nextAction`：当前失败点的可执行恢复建议。

## 9. 收口检查

每次改动至少满足：

1. preview 与 apply 使用相同目标和最新 revision；
2. apply 返回 committed 且编辑态 verification 通过；
3. 独立 verify 再次通过；
4. 需要视觉/交互证明时 scenario 通过并保留 capture；
5. `cocos_editor_list` 显示的 Bridge/MCP 版本与本次安装版本一致。
