# Cocos AI 阶段四声明式构建验收结论

> 结论：**GO**（严格限定 Cocos Creator 3.8.8）
> 日期：2026-07-22
> 分支：`feature/phase-4-declarative-building`
> 计划：`codex-work/docs/superpowers/plans/2026-07-20-cocos-ai-creator-toolkit-phase-4-declarative-building.md`

## 验收证据运行

| 运行 | 范围 | 结果 |
| --- | --- | --- |
| `phase-4-20260721T105253730Z-aa73da02` | 空白项目统一声明式验证 | passed，16 步 0 失败 |
| `design-693284ca-1437-4330-bde6-ed72877a1544` | 隔离 `xy-client-phase-4-validation` 真实内容声明式验收（healthDialog.prefab） | design-apply committed（fontSize + clickEvents 引用，验证全过）→ 回滚 verifiedClean → git 逐字干净 |

自动化基线：`npm test` 544/544、`npm run typecheck`、`npm run build`、`git diff --check` 全部通过。

## 完成标准逐项复核

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 目标文档支持临时逻辑 ID（`$` 前缀、全文唯一、自引用拒绝）、组件属性与引用、prefabInstance 声明；协议版本 0.5.0 | 满足 | `protocol/design.ts`（唯一/自引用/悬空引用三重 superRefine）；11 个协议用例全绿 |
| 2 | 差异引擎：fileId 优先匹配、name+path 兜底；缺失产创建、差异产修改；目标未声明的现有内容一律不动；默认不自动删除/拆组件（显式 prune 才产出） | 满足 | `core/design-diff.ts` 8 个用例（零差异/缺失创建/属性修改/缺失组件/prune 两态/实例化/引用接线） |
| 3 | 计划排序：父先于子、实例化先于覆盖与引用、脚本挂载最后；逻辑 ID 引用执行期回填真实 UUID；源预制体相关操作自动附带影响分析与 Override 标注 | 满足 | `core/design-plan.ts` 排序与依赖用例；验收运行中引用 `clickEvents[0].target` 回填真实 UUID 证据 |
| 4 | design_inspect/plan/preview 全部只读，预览包含逐项操作、Override 标注、影响面与风险 | 满足 | 三只读命令 + 用例；验收证据 design-inspect/design-plan/design-preview JSON |
| 5 | design_apply 按计划拆事务链执行，任一步失败即停并回滚已完成事务，执行后逐项重读验证通过才允许收口 | 满足 | `core/design-apply.ts` 编排用例（含失败即停回滚路径）；验收运行逐项 verification.passed |
| 6 | design_verify 独立重读对照目标逐项判定；design_export 导出文档过协议校验且可被 design-plan 再消费（round-trip） | 满足 | verify/export 用例与 round-trip 断言；验收运行 design verification passed=true |
| 7 | MCP 只读工具默认开放，写相关工具仅 --enable-writes 注册；全部声明式调用有审计 | 满足 | MCP tools 用例（门控断言 + 审计落盘） |
| 8 | 空白项目声明式往返验证通过，Git 前后逐字一致 | 满足 | `phase-4-20260721T105253730Z-aa73da02` passed，双仓库 Git 逐字一致 |
| 9 | 真实项目受控声明式验收通过，Git 仅出现预期变化，未触碰用户无关改动 | 满足（有过程发现） | 隔离 `xy-client-phase-4-validation` 验收 committed + 回滚 verifiedClean + git checkout 还原干净；用户真实 `qyProject/xy-client` 全程未触碰（33 个 club 改动原样） |
| 10 | 自动化测试、类型检查、构建、`git diff --check` 全部通过；阶段 4 findings 明确 GO/NO-GO | 满足 | 544/544 全绿；本文档结论 GO |

## 超出计划的增量

- `xy-client-phase-4-validation` 隔离验证 Worktree：真实内容的声明式验收不必再动用户工作项目。
- 两处真实问题修复（直接受益于该验收暴露）：验证项 expected/actual 显式 optional（075dc69）；CLI 默认请求超时 10s→60s（dfd719a）。

## 已知限制

1. **重读瞬时不可用会失败事务**：组件属性/引用在 Creator 冷会话或文档刚打开时 Dump 可能未物化（读取 undefined），导致重读验证失败并回滚（本次验收首次失败即此形态叠加协议缺省掩盖）。协议已修复"掩盖"（expected/actual optional），但"冷会话读取瞬时不可用"本身的鲁棒性（有界轮询重读）待后续加固。
2. **预制体编辑模式内容封闭**（阶段三已知限制，声明式同样受约束）：目标差异落在预制体编辑容器内嵌套实例内容时，写入静默不生效，重读验证会失败回滚——当前表现为安全失败，声明式计划应把该类目标列入 unresolved（后续 Task 可补）。
3. **跨文档 scope 声明式写入未实测**：`source-prefab`/`apply-to-source` 的声明式路径协议已开（DESIGN_REVISION_REQUIRED 门禁），实测样本待补。
4. **多余内容收敛需显式 prune**：默认最小侵入不删不拆；清理型工作流需显式 `prune: true`。

## 阶段五候选输入

- 运行态与视觉验证（preview_launch/runtime_*、截图与多分辨率）——第一版最终验收场景（设计规格第 19 章）剩余条目多依赖阶段五能力。
- 冷会话重读鲁棒性（有界轮询重读 Dump）。
- 声明式 unresolved 对预制体编辑模式封闭项的显式标注。
