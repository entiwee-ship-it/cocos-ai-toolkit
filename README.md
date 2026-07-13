# Cocos AI Toolkit

这是一套面向 AI 的 Cocos Creator 自动化工具。Cocos Creator 编辑器是 Scene、Prefab、节点、组件和资源关系的唯一写入引擎；外部服务不直接修改 `.prefab`、`.scene` 或 `.meta` 文件。

当前仓库处于阶段 0 技术探针：验证 Creator 3.8.8 的编辑器消息、组件反射、嵌套 Prefab、Override、Undo 和保存能力。当前真实游戏项目只用于边界复查；任何写入探针只能在隔离 Git Worktree 中执行。

## 安全边界

- Bridge 仅连接 `127.0.0.1`。
- 不允许执行任意 JavaScript。
- 不允许将 Bridge 安装到存在用户未提交改动的真实项目工作区。
- 阶段 0 报告必须明确列出无法解析的数据，不得静默丢失。
- 写探针只接受名称以 `CocosAiProbe_` 开头的固定节点，并拒绝已有 Dirty 的文档。
- 写入使用 `prepare -> confirm -> status`；`confirm` 必须匹配 prepare 返回的 Revision，重复 confirm 不会重复执行。
- Scene、Undo、保存和恢复全部由 Creator 执行；外部只读磁盘计算指纹，不直接覆盖 `.prefab`。

## 阶段 0 写探针

```powershell
node packages/cli/dist/index.js probe-undo-save-prepare --project-id <project-id> --editor-instance-id <editor-id> --project-path <isolated-project> --document-uuid <prefab-uuid> --probe-name CocosAiProbe_<id>
node packages/cli/dist/index.js probe-undo-save-confirm --project-id <project-id> --editor-instance-id <editor-id> --transaction-id <transaction-id> --expected-revision <revision>
node packages/cli/dist/index.js probe-undo-save-status --project-id <project-id> --editor-instance-id <editor-id> --transaction-id <transaction-id>
```
