# Cocos AI 阶段三预制体完整写入验收结论

> 结论：**GO**（严格限定 Cocos Creator 3.8.8）
> 日期：2026-07-20
> 分支：`feature/phase-3-prefab-writes`
> 计划：`codex-work/docs/superpowers/plans/2026-07-18-cocos-ai-creator-toolkit-phase-3-prefab-writes.md`

## 验收证据运行

| 运行 | 范围 | 结果 |
| --- | --- | --- |
| `phase-3-20260720T020105333Z-e1ba600f` | 空白项目统一预制体验证（首轮全绿） | passed，34 步 |
| `phase-3-20260720T020824418Z-a31f51ac` | 空白项目统一预制体验证（复跑回归） | passed，34 步 |
| Task 14 受控写入 | 真实 `xy-client` `healthDialog.prefab`（Bridge 0.1.25） | 实例化 committed、整实例还原 committed、实例化回滚 verifiedClean，Git 前后逐字一致 |

自动化基线：`npm test` 430/430、`npm run typecheck`、`npm run build`、`git diff --check` 全部通过；验证脚本合同测试 10/10（含 pwsh AST 解析）。

## 完成标准逐项复核

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 全部 Prefab 写操作属于事务，携带 transactionId、幂等键和 Revision 前置（含 prefabGraph 维度）；scope 显式三值，无事务写入在 Bridge 层被拒绝 | 满足 | 协议 0.4.0（scope 三值 + prefab.* 九类操作 + prefabGraph 维度）；Bridge `validateWriteTransactionRequest` 白名单与门禁；验证脚本每组事务均有 prepare/confirm 证据 |
| 2 | `source-prefab` / `apply-to-source` 执行前强制影响分析：报告修改哪个资源、产生哪一层 Override、影响多少 Scene/Prefab/实例；缺分析在协议层和 Bridge 层双重拒绝 | 满足 | 协议 superRefine 门禁 + Bridge `PREFAB_IMPACT_ANALYSIS_REQUIRED` 双保险；`core/prefab-impact` 影响分析器（直接容器 + 传递祖先 + 循环风险）；应用到源事务内联影响分析证据 |
| 3 | 嵌套 Prefab 实例化在隔离项目实测通过：实例链、FileID 映射、Override 结构与 Phase 1 只读模型一致 | 满足 | 空白项目三层嵌套夹具（Page→Card→healthDialog）全部由工具自身写能力构建；实例化验证 `__prefab__.uuid` 与实例 FileID 证据；`createPrefab` 从含实例节点生成时保留嵌套实例（探测已固化矩阵） |
| 4 | Override 创建/还原逐项可追踪（差异树覆盖属性修改、节点新增、组件新增）；还原后重读与源值一致；多层嵌套来源链完整 | 满足（有语义边界） | 覆盖证据含 targetLocalIds/sourceValue/overrideValue/effectiveValue；**实测语义**：restorePrefab 只还原实例内部（非根挂载点）覆盖，根自身覆盖按设计保留——验证器与脚本断言均按 targetFileId 判定；见已知限制 1 |
| 5 | 应用到源后重新解析 Prefab 引用图，验证关系未损坏；循环引用、错误 FileID 映射、错误 Override Target、跨层归属污染被阻止并返回稳定错误码 | 满足（判定务实） | 应用后实例关联复查（同资产、实例 FileID 在位）+ 源文件已写入新值（真实判据：应用后覆盖记录不清空）；PREFAB_CYCLE（当前文档自嵌套）、PREFAB_ASSET_TYPE_MISMATCH、PREFAB_REPLACE_NOOP、PREFAB_INSTANCE_REQUIRED、PREFAB_LINK_NOT_ESTABLISHED 等稳定错误码；`prefabGraph` Revision 前置 REVISION_CONFLICT |
| 6 | 替换、解除关联、重新关联实测通过，实例状态转换正确 | 满足 | unlink 后 `__prefab__` 为空、子树保留；回滚经 link 逆操作恢复关联；replace_source 互逆（关联旧源）；解除关联回滚验证通过（验证脚本步骤 57-61） |
| 7 | Undo 分组实测结论固化：可用则每事务一个 Undo 组（保留显式逆操作兜底），不可用则维持 step-undo-with-inverse 且能力矩阵附实测证据 | 满足（走兜底路径） | 实测：编辑器 Undo 分组只对**属性级**修改有效，结构变更（新建/删除节点）dump-diff 不覆盖；事务管理器维持 `step-undo-with-inverse`（显式逆操作 + 重读验证），结论已固化能力矩阵；facade.unlinkPrefab 自带录制且 undo 可恢复关联（属性级证据） |
| 8 | 引用写入回滚幂等性加固完成，复现用例与回归全绿 | 满足 | 根因修复：set_reference 逆操作改经 buildReferenceInverse 归一化（不再走 set_property + 原始 Dump）；clear_reference 同源修复；单测覆盖三种形态 |
| 9 | 脚本编译事件链路结论固化：找到入口则挂载守卫事件驱动落地，找不到则限制写入能力矩阵与 findings，不留悬而未决的 stub | 满足（有修正） | **修正阶段二结论**：`asset-db/refresh-asset` 实测触发重新导入 + 异步编译 + 类重注册（类标记双向证据）；广播监听场景进程不可用；waitForScriptCompilation 落地为 refresh + 类注册有界轮询（10s 上限，超时返回诊断）；编译错误文本不可达的限制已写入矩阵与注释 |
| 10 | 三层以上嵌套写入往返验证通过，空白项目 Git 前后逐字一致 | 满足 | 两轮全绿运行（e1ba600f、a31f51ac）；工具仓库与空白项目 Git 逐字一致 |
| 11 | 真实项目受控 Prefab 写入验收通过，Git 仅出现预期变化，未触碰用户无关改动（还原以 git 恢复为兜底） | 满足（有发现） | Task 14：healthDialog.prefab 实例化（BG.prefab 挂入）committed + 整实例还原 committed + 回滚 verifiedClean；healthDialog.prefab git checkout 还原后全仓 Git 与基线逐字一致（26 个用户 club 改动未触碰）；预制体编辑模式内容封闭语义发现见已知限制 1 |
| 12 | 自动化测试、类型检查、构建、`git diff --check` 全部通过；阶段 3 findings 明确 GO/NO-GO | 满足 | 430/430 全绿；本文档结论 GO |

## 超出计划的增量能力

- `probe.debugPrefabFacade` 临时探测通道（enumerate/call/instantiate/link/scene-message/watch-arm/watch-collect，target 支持 cce 点路径与 Editor.Message），阶段四收口时摘除或转正式能力。
- 夹具自举方法学：三层嵌套预制体可完全由工具自身写能力构建（createAsset → openAsset → 事务链），验证脚本已固化。
- 阶段二结论修正两处：refresh-asset 可触发类重注册（原"仅重新导入"作废）；`create-node` 消息必须带 `type:'cc.Prefab'` 才保留实例信息。

## 已知限制

1. **预制体编辑模式内容封闭**：在预制体编辑容器中，对嵌套实例的内容子节点属性写、实例根组件属性写、实例内建节点，全部静默不生效（无报错但重读不变）；仅实例根命名/放置类覆盖存在且按根挂载点语义在还原时保留。场景模式下实例内部子节点可写并产生覆盖。restorePrefab 只还原实例内部（非根挂载点）覆盖，根自身覆盖（_name/_lpos/_lrot/_euler，target 为根 fileId）按设计保留——还原验证按 targetFileId 判定而非全零。
2. **应用到源后覆盖记录不清空**：applyPrefab 把覆盖写入源资产后，实例侧 propertyOverrides 记录保留（值已与源一致）；真实判据是源文件已写入新值，applyPrefab 返回值不可信（成功也返回 false）。
3. **createPrefab 重建节点并改名**：从场景节点生成预制体后原会话 UUID 失效、实例根名改为资产名；调用方不得持有旧 UUID，重定位按父节点 + 源资产 UUID 匹配，且节点树刷新晚于 createPrefab 返回（须有界轮询）。
4. **Undo 分组仅属性级**：编辑器 Undo 分组对结构变更（新建/删除节点）无效；事务回滚统一走显式逆操作 + 重读验证。
5. **编译错误文本不可达**：refresh-asset 可触发类重注册，但编译失败的具体诊断文本无法经消息/广播通道取得；超时路径返回中文超时诊断，编译失败细节需看 Creator 控制台。
6. **真实项目字节级还原差异**：同阶段二——Creator 保存会按当前序列化器重写字节；真实项目验收的还原必须以 git 恢复为兜底（本次已照此执行）。

## 阶段四候选输入

- 声明式构建（design_inspect/plan/preview/apply/verify/export）以阶段三预制体语义为地基。
- 预制体编辑模式内容封闭边界的写支持评估（如需对嵌套实例内容写入，须先解开 Creator 守卫或走打开内层预制体编辑的路径）。
- 嵌套 Override 归属的写时逐层核对（当前仅只读模型完整）。
