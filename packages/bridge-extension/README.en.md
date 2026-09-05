# Cocos AI Bridge

The standalone manager window has status and current-version tool-list tabs. All MCP tools are public by default, and `cocos_asset_manage` routes resource move, rename, and delete operations through Creator AssetDB.

Cocos AI Bridge is a project-local editor extension for Cocos Creator 3.8.x. It connects Cocos AI Toolkit to editor state, assets, nodes, components, Prefabs, document saving, and Preview workflows.

| Item | Value |
| --- | --- |
| Current version | V0.9.0 |
| Release date | 2026-09-05 |
| Author | Enti |
| Creator version requirement | `>=3.8.0 <3.9.0` |
| Validated Creator version | 3.8.8 |
| Supported platform | Windows (`win32`) |

The extension is loaded through the project's `extensions/cocos-ai-bridge` junction and stays aligned with the MCP Server and Bridge build in the fixed runtime worktree. Use **Cocos AI → Open Tool Manager** in Creator's top menu to open the standalone manager window.
