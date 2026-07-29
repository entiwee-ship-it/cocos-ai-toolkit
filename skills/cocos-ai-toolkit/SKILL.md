---
name: cocos-ai-toolkit
description: Use when a Cocos Creator 3.8.x task must create, inspect, edit, delete, search, or verify Prefabs, scenes, UI hierarchy, components, or asset references; also use for 创建、查看、编辑、删除、查找或验证预制体/场景 and any `.prefab`, `.scene`, or `.meta` work. Do not use for pure `.ts` changes that do not touch Creator serialized assets.
---

# Cocos AI Toolkit

Use the Cocos MCP for Creator resources. Match namespaced tools by the `cocos_*` suffix.

## Non-negotiable boundary

禁止手写或直接编辑 `.prefab`、`.scene`、`.meta` JSON。不得使用 shell、脚本、Edit、Write 或 apply_patch 创建、修改、删除、复制、格式化这些 Creator 序列化资源。

If MCP, Creator, Probe, Bridge, target identity, or write capability is unavailable, 停下并报告阻塞. Never fall back to file edits. Stop all writes on `outcome-unknown` or `manual-recovery-required`.

## Default tools

| Intent | Tool |
| --- | --- |
| Discover online projects | `cocos_editor_list` |
| Find Prefabs by name/path | `cocos_prefab_search` |
| Open and inspect structure/references | `cocos_prefab_inspect` |
| Create a Prefab through Creator | `cocos_prefab_create` |
| Preview/apply an edit | `cocos_prefab_edit` |
| Preview/confirm deletion | `cocos_prefab_delete` |
| Independently verify a target tree | `cocos_prefab_verify` |
| Create a folder, script, or Prefab from a node | `cocos_asset_create` |
| Move an asset while preserving its UUID | `cocos_asset_move` |
| Write Meta without changing its UUID | `cocos_asset_write_meta` |
| Preview/confirm any asset deletion | `cocos_asset_delete` |

Always start with `cocos_editor_list`; select by `projectPath`. Pass `editorInstanceId` when one project has multiple instances. If UUID is unknown, search first. Inspect before editing or deleting.

## Create, edit, delete

For every create/edit/delete, 先以 `mode: "preview"` 调用. Read the returned operations, risks, unresolved items, and references. Only when they match the request, 再以 `mode: "apply"` 调用 with the same target.

- Create: pass one declarative Prefab root in `tree`; `rootId` must equal that root's logical ID and `assetUrl` must be under `db://assets/` with a `.prefab` suffix. The tool builds through Creator's from-node API.
- Edit: inspect first, preserve returned `fileId` identities, change the declarative `tree`, preview, apply, then verify the same tree.
- Delete: preview first. For apply, copy the returned real asset URL into `confirmAssetUrl`. If users exist, set `confirmReferenced: true` only after accepting that impact. Deletion is irreversible.
- Asset create/move/meta/delete: always preview first. Prefabs must come from real Creator nodes; never create an empty Prefab JSON. Moves and Meta writes must preserve the original UUID.

Logical IDs beginning with `$` exist only inside one declarative target. They are not Creator UUIDs.

## Verification

Use `cocos_prefab_verify` after create/edit when the final target matters. Trust structured Creator state and references; screenshots and filesystem diffs are supporting evidence only. On revision conflict, inspect again and rebuild the target instead of forcing the old request.

## Full profile

`--profile=full` is 仅用于排障、事务恢复或运行态取证. It exposes the legacy low-level toolbox; consult the repository README when that profile is explicitly needed. Daily Prefab work stays on the default profile.
