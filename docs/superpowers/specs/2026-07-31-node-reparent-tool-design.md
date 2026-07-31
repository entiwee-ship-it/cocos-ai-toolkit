# Cocos 节点迁移工具设计规格

> 日期：2026-07-31
> 状态：用户已确认

## 目标

为 0.3.0 直写工具面增加 `cocos_node_reparent`，让 AI 能在 Creator 3.8.8 中把现有节点安全迁移到另一个父节点，并可选指定兄弟顺序。该工具用于 Prefab/Scene 结构整理，不直接编辑序列化 JSON。

## API

输入沿用现有直写工具的项目与实例选择：

- `projectId`：必填。
- `editorInstanceId`：可选。
- 源节点：`nodeUuid` 或 `path` 二选一。
- 目标父节点：`newParentUuid` 或 `newParentPath` 二选一。
- `siblingIndex`：可选非负整数；省略时由 Creator 放到目标父节点末尾。

源节点与目标父节点的两组选项各自必须恰好提供一个。工具拒绝根节点、把节点迁入自身/后代、负数或非整数 siblingIndex；结构合法性的最终判定由 Creator 执行器负责。

## 执行与验证

MCP 工具只转发已有的 `probe.directWrite` 原子操作：

```json
{
  "type": "node.reparent",
  "nodeUuid": "<source>",
  "newParentUuid": "<parent>",
  "siblingIndex": 0
}
```

路径输入先通过当前文档层级解析为运行期 UUID。写入后沿用直写框架自动保存与逐项回读，至少验证：

- 源节点仍存在且 UUID 不变。
- `parentUuid` 等于目标父节点 UUID。
- 提供 siblingIndex 时，实际兄弟顺序与请求一致。

Creator 静默不生效时必须返回 `DIRECT_WRITE_VERIFY_FAILED`，不得把失败当成功。

## 范围边界

- 不新增任意 JavaScript 执行入口。
- 不修改 Bridge 的 `node.reparent` 协议或执行语义。
- 不同时加入节点 Transform 工具；本次亲友房坐标可通过迁移前后现有节点组件/Widget 与后续 Creator 属性写入处理。
- 不兼容或恢复已移除的 0.2.x 事务与声明式工具。

## 验收

- MCP 注册表在写模式增加该工具，只读模式不注册。
- 参数 schema 和工具说明完整。
- 单元测试覆盖 UUID/路径寻址、可选 siblingIndex、互斥参数和底层 `probe.directWrite` 负载。
- `npm test`、`npm run typecheck`、`npm run build` 全部通过。
- README、技能与工具数健康检查从 27 更新到 28。
