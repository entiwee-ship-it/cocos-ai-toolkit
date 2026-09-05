# Cocos AI Bridge

Cocos AI Bridge 是面向 Cocos Creator 3.8.x 的项目内编辑器扩展，为 Cocos AI Toolkit 提供编辑器状态、资源、节点、组件、Prefab、保存和 Preview 桥接能力。

| 项目 | 数据 |
| --- | --- |
| 当前版本 | V0.8.0 |
| 发布日期 | 2026-09-05 |
| 作者 | Enti |
| Creator 版本要求 | `>=3.8.0 <3.9.0` |
| 已验证 Creator 版本 | 3.8.8 |
| 支持平台 | Windows (`win32`) |

扩展通过项目 `extensions/cocos-ai-bridge` Junction 加载，与固定运行 Worktree 中的 MCP Server 和 Bridge 构建保持一致。可从 Creator 顶部的 **Cocos AI → 打开工具管理** 直接打开独立管理窗口；窗口包含运行状态和当前版本工具列表两个切换页，资源移动、重命名和删除统一通过 `cocos_asset_manage` 走 Creator AssetDB。
