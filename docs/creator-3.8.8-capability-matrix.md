# Cocos Creator 3.8.8 能力来源矩阵

验证项目：`E:/xile-workspace/worktrees/xy-client-cocos-ai-probe`

验证版本：Cocos Creator `3.8.8`，Bridge `0.1.0`

| 能力 | 实际入口 | 类型来源 | 稳定性 | 当前结论 |
| --- | --- | --- | --- | --- |
| Bridge 生命周期 | Extension `load` / `unload` + 本机 WebSocket | Creator 扩展公开入口、`ws` | public-api | 已验证 Hello，能返回精确 Creator 版本、项目路径、项目 UUID 和编辑器实例 ID |
| 查询节点树 | `scene/query-node-tree` | `@cocos/creator-types` `3.8.7` | message-api | 待 Task 9 真实验证 |
| 查询节点 | `scene/query-node` | 同上 | message-api | 待 Task 9 真实验证 |
| 查询组件 | `scene/query-component` | 同上 | message-api | 待 Task 9 真实验证 |
| 查询资源 | `asset-db/query-assets` | 同上 | message-api | 待 Task 8 真实验证 |
| 查询依赖 | `asset-db/query-asset-dependencies` | protected types | internal-api | 待 Task 8 验证；不可用时必须进入 `unresolved` |
| Prefab 信息 | Scene dump + reflection | Creator 运行时对象和内部信息 | internal-api | 待 Task 10 真实验证 |
| Undo | Scene snapshot/recording | protected types | internal-api | 待 Task 11 真实验证 |

## 已确认事实

- 本机 Creator 可执行文件为 `C:/ProgramData/cocos/editors/Creator/3.8.8/CocosCreator.exe`。
- 真实 `xy-client` 编辑器实例保持打开且未安装 Bridge。
- 隔离 Worktree 实例成功登记为项目 `00d7d957-a3e8-4ad6-80f4-2fcfb235bca4`。
- Hello 返回 `creatorVersion=3.8.8`、`bridgeVersion=0.1.0`，并声明 7 项白名单能力。
- Bridge 编译类型基线使用当前 npm 可用的最新 `@cocos/creator-types@3.8.7`；Creator `3.8.8` 没有对应公开类型包，因此所有 message/internal API 都必须由真实运行结果复验，不能仅凭类型声明认定支持。
