# Cocos AI Toolkit

这是一套面向 AI 的 Cocos Creator 自动化工具。Cocos Creator 编辑器是 Scene、Prefab、节点、组件和资源关系的唯一写入引擎；外部服务不直接修改 `.prefab`、`.scene` 或 `.meta` 文件。

当前仓库处于阶段 0 技术探针：验证 Creator 3.8.8 的编辑器消息、组件反射、嵌套 Prefab、Override、Undo 和保存能力。当前真实游戏项目只用于边界复查；任何写入探针只能在隔离 Git Worktree 中执行。

## 安全边界

- Bridge 仅连接 `127.0.0.1`。
- 不允许执行任意 JavaScript。
- 不允许将 Bridge 安装到存在用户未提交改动的真实项目工作区。
- 阶段 0 报告必须明确列出无法解析的数据，不得静默丢失。
