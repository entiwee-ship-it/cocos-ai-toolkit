# Cocos AI 阶段二事务式基础写入验收结论

> 结论：**GO**（严格限定 Cocos Creator 3.8.8）
> 日期：2026-07-18
> 分支：`feature/phase-2-transactional-writes`
> 计划：`codex-work/docs/superpowers/plans/2026-07-17-cocos-ai-creator-toolkit-phase-2-transactional-writes.md`

## 验收证据运行

| 运行 | 范围 | 结果 |
| --- | --- | --- |
| `phase-2-20260717T101509851Z-14c48072` | 空白项目统一写入验证（0.1.5） | passed，17/17 步 |
| `phase-2-20260718T024344805Z-edf789e6` | 空白项目统一写入验证（0.1.20 回归） | passed，17/17 步 |
| `phase-2-20260718T025019981Z-20b1da7e` | 空白项目统一写入验证（场景样本修正后） | passed，17/17 步 |
| Task 11 受控写入 | 真实 `xy-client` `healthDialog.prefab`（0.1.22） | 写入 committed ×2、回滚 verifiedClean ×2，文件以 git 还原至 HEAD |

自动化基线：`npm test` 380/380、`npm run typecheck`、`npm run build`、`git diff --check` 全部通过。

## 完成标准逐项复核

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 写操作必须属于事务（transactionId + 幂等键 + Revision 前置），无事务写入在 Bridge 层被拒绝 | 满足 | `transaction-manager.ts` 强制校验；CLI/MCP 协议 Schema（`write.ts`）；非法请求稳定错误码 |
| 2 | Revision 前置或 expectedOldValue 不一致时拒绝执行，返回冲突范围、旧值和当前值 | 满足 | `REVISION_CONFLICT`（details.conflicts 四维逐项）、`PROPERTY_VALUE_CONFLICT`（expected/actual），均有单测 |
| 3 | 相同幂等键重试返回原事务状态不重复执行；超时标记 outcome-unknown 禁止盲目重试 | 满足 | `duplicateOf` 幂等双索引 + 负载哈希比对；超时/未知异常 → outcome-unknown，晚到结果只记状态历史；单测覆盖 |
| 4 | 节点 8 类、组件 7 类原子操作在隔离项目实测通过；非法操作稳定错误码不写半成品 | 满足 | 空白项目 15 类全部实测（committed + rolled-back verifiedClean）；REPARENT_CYCLE、PROPERTY_READONLY、ARRAY_INDEX_OUT_OF_BOUNDS 等错误码实测触发 |
| 5 | 自定义脚本挂载经编译/注册守卫，不产生 MissingScript；编译失败返回完整诊断并回滚 | 部分满足（有限制） | 资产索引/类注册/Schema 三重核对实测（Phase2Probe 挂载成功）；**编译事件等待未找到外部消息入口**（refresh-asset 仅重新导入，programming/execute-script 被拒），见已知限制 1 |
| 6 | 每事务一个 Undo 组（或等价逆操作兜底），回滚后重读验证干净 | 满足（走兜底路径） | Undo 分组 3.8.8 未实测，默认 `step-undo-with-inverse`（显式逆操作 + 重读验证），全部回滚实测 verifiedClean；见已知限制 2 |
| 7 | 保存→关闭重开→重读验证结构、属性、引用与计划一致 | 满足 | committed 必须携带 passed=true 的验证报告（协议不变式）；等价刷新重读；resultNodeUuid/resultComponentUuid 回填 |
| 8 | 重连后未完成事务按指纹分类，不从中断点盲目续写；恢复摘要完整 | 满足 | recover() 指纹分类 committed/not-executed/rollbackable/manual-recovery-required（单测）；Server 中断恢复证据 `*-write-interrupt-recovery.json`（validated 补执行与 outcome-unknown 禁续写两条路径均实测） |
| 9 | MCP 默认只读，写工具仅显式 --enable-writes 注册；全部写入有审计记录 | 满足 | MCP 默认 8 个只读工具，--enable-writes 才注册 5 个写工具（环境变量不可开写）；write-journal JSONL 审计（source/request/verification/stateHistory） |
| 10 | 隔离 Worktree 往返验证通过，Git 前后逐字一致 | 满足 | 三轮全绿，工具仓库与空白项目 Git 逐字一致 |
| 11 | 真实项目少量受控写入验收通过，Git 仅出现预期变化，未触碰用户无关改动 | 满足（有教训） | Task 11：healthDialog.prefab 写入/回滚成功；Creator 重序列化导致字节差异，按用户要求 git checkout 还原至 HEAD，用户 club 工作未触碰；见已知限制 3 |
| 12 | 自动化测试、类型检查、构建、git diff --check 全部通过；findings 明确 GO/NO-GO | 满足 | 380/380 全绿；本文档结论 GO |

## 超出计划的增量能力

- `probe.createAsset`（内置模板建空预制体）、`probe.createPrefab`（节点转预制体）、`probe.deleteAsset`、`probe.refreshAsset` 四个正式能力（均带路径预检，防覆盖弹窗）。
- 操作可见性：写操作后自动选中目标节点，Creator 控制台输出 `名称(uuid)` 中文日志；事务级日志（登记/开始执行/已提交/失败回滚/结果未知/手动回滚）。
- 端到端证明：真实项目 `healthDialog.prefab` 完整复刻到空白项目（结构/组件/标量属性/5 张贴图引用全部一致）。
- 旧阶段零 `undoSave*` 入口已摘除（Bridge/CLI/README，-1388 行）。

## 已知限制

1. **脚本编译外部触发不可用**：`asset-db/refresh-asset` 只重新导入不触发 TypeScript 编译与类重注册，`programming/execute-script` 调用被拒。脚本源码创建/编译属阶段三范围，当前挂载守卫只对已编译脚本生效。
2. **Undo 分组未实测**：回滚统一走显式逆操作 + 重读验证还原（`step-undo-with-inverse`）；编辑器 Undo 分组能力待隔离实测后决定是否切换。
3. **真实项目字节级还原差异**：Creator 打开/保存真实项目文件会按当前序列化器重写字节（与仓库历史序列化不同）；真实项目验收的还原必须以 git 恢复为兜底，不能只信事务回滚的字节一致性。
4. **引用写入回滚强度**：一次实测中引用写入回滚出现逆操作后验证未干净（磁盘内容未受影响）；引用类回滚的幂等性待阶段三加固。
5. **scope 仅限 current-document**：`source-prefab`、`apply-to-source` 在协议层直接拒绝，属阶段三。
6. **运行时写入不进编辑器 Undo**：reparent/duplicate/remove-component/数组 resize 走运行时对象，依赖显式逆操作回滚。

## 阶段三候选输入

- Prefab 语义操作（实例化、Override 创建/应用/还原、解除关联）：`cce.SceneFacadeManager` 的 `applyPrefab`/`restorePrefab`/`linkPrefab`/`unlinkPrefab` 已自省确认存在。
- Undo 分组能力实测（`cce.SceneFacadeManager` 分组接口）。
- 脚本编译事件驱动的等待链路（需要找到 Creator 编译完成事件入口）。
