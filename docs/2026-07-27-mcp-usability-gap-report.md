# Cocos AI MCP 可用性缺口报告与改进路线

> 日期：2026-07-27
> 依据：在 xy-client 新版大厅 / 新版亲友房开发中，用 Cocos AI MCP 做真实 prefab 编写的完整实战记录
> 结论先行：MCP 的读写基础链路已经打通（探针、快照、事务、design 声明式编辑），但离"全面编写 Cocos 项目的任何东西"还有 6 个真实缺口。其中全量扫描已修复，其余 5 项按 P0→P2 排期。

## 一、MCP 定位与目标

MCP 的目标是让 AI 能完成 Cocos 项目的**全部**编写工作，与人工在编辑器里能做的对齐：

1. 读：项目/资产/文档/组件/运行时状态查询（已具备，基本可用）。
2. 写：创建、修改、删除任何资产与文档内容（**缺口主要在这里**）。
3. 验证：写后重读校验、预览运行验证（已具备，部分可用）。

"不应该有不舒适的地方"的量化标准：任何一项人工可在编辑器完成的操作，AI 都能通过 MCP 以**不高于人工的可靠性**完成，且错误信息能直接指导下一步。

## 二、实战暴露的问题清单

### P0-1 影响分析触发全项目扫描（已修复）

- **现象**：`design_apply`（scope=source-prefab）先超时，再报 `DOCUMENT_CHANGED_DURING_SCAN`、`OUTCOME_UNKNOWN`，编辑器同时出现全项目 prefab 扫描。
- **根因**：`mcp-server/src/tools.ts` 的 `readDesignPrefabGraph` 为做嵌套影响分析，调用 `ProjectScanner` 对**全项目每个文档逐个打开并快照**。慢、与编辑器刷新互撞、写流程被拖死。
- **修复**：新增 `prefab-reference-scan` 磁盘只读扫描（直接读 `.prefab/.scene` 序列化文件提取 `cc.PrefabInfo.asset.__uuid__` 引用边），`01e4c43`；`sourceAssetPath` 快照缺失兜底 `489e56e`。真实项目 409 节点 / 1594 边毫秒级完成。

### P0-2 设计写流程强依赖"当前文档"，且错误不指引

- **现象**：对未打开的 prefab 发起 `design_apply`，先报"声明式计划包含未解析项"（实为快照 path 缺失），修复后又报"source-prefab 作用域必须显式提供 revision"；编辑器当前是空白场景时，design_inspect 读到的是场景而非 prefab，差异计算全部变成 `node.create`。
- **根因**：`readDesignContext` 只对**当前打开文档**做快照，diff/plan/write 全挂在这份快照上；scope=source-prefab 并没有自动把目标 prefab 打开为当前文档，也没有任何错误提示告诉调用方"需要先打开目标文档"。
- **影响**：AI 无法可靠地对任意 prefab 发起编辑，必须人工先把 prefab 打开到前台。
- **改进方向**：
  1. design 写流程在 scope=source-prefab 且目标资产未打开时，**自动 `probe.openAsset` 打开目标 prefab**（写完成后可选恢复原文档）；
  2. 若识别到当前文档与目标不符，返回**可执行的错误**：`TARGET_DOCUMENT_NOT_OPEN: 请先打开 db://... 或允许自动打开`；
  3. `design_preview` 输出中附带可直接传给 `design_apply` 的 `revision` 对象，消除"必须显式提供 revision 但不知道从哪拿"的断点。

### P0-3 没有"创建资产"的工具面

- **现象**：本次把内嵌弹窗子树抽成独立 prefab（30 个对象 id 重映射 + 新根 + 新组件）只能靠离线 JSON 手术；MCP 没有任何创建 prefab / 创建目录 / 移动子树到新资产的入口。bridge 能力清单里有 `probe.createPrefab/createAsset`，但 `mcp-server` 的 `registerTool` 列表未暴露。
- **影响**：新建界面、新建组件资产、拆分重组（最常见的重构动作）全部做不了，违背"全面编写"。
- **改进方向**：
  1. 暴露 `cocos_asset_create`（folder/prefab/component-script）与 `cocos_asset_delete`、`cocos_asset_move`（跨目录移动并保持 meta uuid）；
  2. design 操作集增加 `document.extract_subtree`：把当前文档某子树物化为新 prefab 资产，原位置替换为 prefab 实例（这是人工"生成 prefab"操作的直接对应）；
  3. 暴露 `cocos_asset_write_meta`（只读场景不需要，但移动/重命名后保证 uuid 稳定）。

### P1-1 写操作错误反馈不可行动

- **现象**：`Request timed out`、`OUTCOME_UNKNOWN`，无法判断是哪一步挂了（plan？写入？保存？校验？）。
- **改进方向**：
  1. 写事务每个阶段（plan / prepare / apply / save / verify）都在事务状态里记录**结构化失败点**（阶段 + 输入摘要 + 原始错误），`OUTCOME_UNKNOWN` 必须可追问到具体阶段；
  2. MCP 层把 Creator 侧错误原文（而非概括码）透传给调用方；
  3. 写操作默认超时提高到覆盖大型 prefab 保存（或按文档大小自适应），超时错误里写明当前进行到哪个阶段。

### P1-2 组件引用写入覆盖面不完整

- **现象**：本次 43 项 `textureFrames: SpriteFrame[]` 数组属性绑定仍走 JSON 手术；`component.set_reference` 是否支持数组引用、嵌套对象数组（如 VMData 数组）、Enum 属性（下拉）未有验证与文档。
- **改进方向**：
  1. `component.set_reference` 明确支持**数组整体写入**（`references: Record<path, AssetRef[]>`），并补 `cocos_design_verify` 对数组逐项校验；
  2. 补 `component.set_property` 对 Enum / 嵌套 ccclass 对象数组的覆盖测试；
  3. 建立"属性写入能力矩阵"测试集：每种常见组件（Sprite/Label/RichText/EditBox/ScrollView/Button/Widget/自定义 ccclass）每种常见属性类型各一个 roundtrip 用例。

### P1-3 预制体实例（嵌套 prefab）编辑语义缺失

- **现象**：大厅 prefab 里有嵌套 prefab 实例（头像框），当前 design 只能编辑宿主层，实例内部只能绕道 source-prefab 或接受不可达。
- **改进方向**：
  1. design 操作集补 `prefab.instance_override`（propertyOverrides / targetOverrides 的声明式写入）与 `prefab.revert_override`（已有写操作但 design 层未暴露）；
  2. `design_inspect` 输出实例内部可寻址的 nodePath（实例根 + 内部路径），让 set_property/set_reference 能直接打实例内部节点（走 override 而非改源）。

### P2-1 文档与错误码体系化

- 每个工具的错误码（`DESIGN_ROOT_NOT_FOUND`、`TARGET_DOCUMENT_NOT_OPEN`、`REVISION_*`、`OUTCOME_UNKNOWN` 等）在工具描述里写清触发条件与下一步动作；补一份 `docs/usage-playbook.md`：新建界面、拆分重组、嵌套实例编辑、数组绑定、枚举属性五个标准场景的端到端示例。

### P2-2 预览验证联动

- `runtime.run_scenario` 已具备步骤编排，但和 design 写流程没串起来；补 `design_apply` 的 `verifyPreview` 可选参数：写入后自动跑一组 scenario（wait-node / assert-property / capture），把"写完即验证"变成默认动作。

## 三、改进排期建议

| 优先级 | 事项 | 预期收益 |
| --- | --- | --- |
| P0-2 | design 写流程自动打开目标文档 + revision 随 preview 返回 + 可行动错误 | design_apply 对任意 prefab 真正可用 |
| P0-3 | 资产创建/删除/移动 + document.extract_subtree | 覆盖"新建/拆分/重组"高频重构 |
| P1-1 | 写事务阶段化错误与可追问 | 故障可自助定位 |
| P1-2 | 数组引用写入 + 属性写入能力矩阵 | 消灭 JSON 手术的最后据点 |
| P1-3 | 嵌套 prefab 实例 override 语义 | 覆盖真实项目普遍存在的嵌套结构 |
| P2 | 错误码文档 + playbook + verifyPreview 联动 | 降低使用门槛、闭环验证 |

## 四、验收标准

用 xy-client 真实场景做验收，全部通过才算"没有不舒适的地方"：

1. 不打开 prefab 的情况下，AI 独立完成：新建一个界面 prefab（含分层结构、组件、贴图、绑定）并注册 UIID；
2. AI 把现有界面的一个子树抽成独立 prefab（extract_subtree），原位置自动变实例；
3. AI 对任意指定 prefab（非当前文档）完成一次属性/引用修改并保存，diff 预览与实际落盘一致；
4. 数组引用属性（SpriteFrame[]）通过 design 写入并 verify 通过；
5. 嵌套 prefab 实例内部节点的属性修改以 override 形式写入；
6. 每次写失败时，错误信息包含阶段、原因和下一步动作，不需要翻源码。
