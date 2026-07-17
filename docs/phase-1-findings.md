# 阶段 1 最终发现

## 结论：建议 GO（待 Task 12 逐项复核确认）

阶段 1 的完整只读能力已在当前真实 `xy-client`（含未提交内容）上完成全量验收：375 个 Scene/Prefab 全部处理，373 个完整解码，2 个扫描期失败经事后单独重读均证实为瞬时状态、可正常读取。节点、组件、属性、Override 解码率均为 100%，多段 localID 解析率 99.94%，扫描前后真实项目 Git 状态逐字一致。

Task 10 隔离轮遗留的 82 个文档读取缺口，经 `249df8d`（报告体积）和 `e83ea18`（快照钉住、Prefab 图归属）修复后降为 2 个瞬时失败，缺口问题已实质消除。

需要诚实记录：本轮统一验证 summary 标记为 `failed`，唯一失败项是工具仓库 Git 前后对比——中断恢复环节故意杀掉的种子扫描遗留了一个原子写临时文件（`*.tmp`），12/12 个验证步骤本身全部通过，真实项目 Git 对比通过。该装置缺陷已修复（见"工具仓库 tmp 事件"），未因此重跑全量验证。

## 真实项目统一验证运行

- 运行前缀：`phase-1-20260717T020912815Z-a7983452`
- scanId：`619c2e99-c5e8-4df8-8322-1b3123c8687f`
- 目标项目：`E:/xile-workspace/qyProject/xy-client`，分支 `xyclub`，HEAD `594009c`，领先远端 1 个提交
- 项目未提交内容（扫描包含在内）：`settings/v2/packages/engine.json`、`settings/v2/packages/information.json`
- 编辑器实例：`00d7d957-a3e8-4ad6-80f4-2fcfb235bca4:45884`，Creator `3.8.8`，Bridge `0.1.0`（构建自工具仓库 `e83ea18`），协议 `0.2.0`
- Bridge 加载方式：项目 `extensions/cocos-ai-bridge` Junction 指向工具仓库，`extensions/` 已被项目 `.gitignore` 第 27 行忽略，不进入 Git 状态
- 总耗时：约 83 分钟（2026-07-17 02:09:12Z → 03:32:27Z）
- 证据位置：工具仓库 `reports/phase-1-20260717T020912815Z-a7983452-*.json`（均被 Git 忽略）

## 分步耗时

| 步骤 | 结果 | 耗时 |
| --- | --- | --- |
| npm test（262 个测试） | 通过 | 3.2s |
| npm run typecheck / build | 通过 | 各约 11s |
| Bridge 连接与 Creator 3.8.8 选择 | 通过 | 0.1s |
| Editor state | 通过 | 0.1s |
| Asset 索引 | 通过 | 45.6s |
| 样本文档完整快照 / 自定义组件 Schema | 通过 | 约 0.3s |
| Prefab 图 | 通过 | 926.2s（15.4 分钟） |
| 项目全量只读扫描（375 文档） | 通过 | 1535.3s（25.6 分钟） |
| Server 中断与同 checkpoint 恢复 | 通过 | 约 26 分钟 |
| 项目扫描报告 Schema | 通过 | 约 14.4 分钟 |
| Git 状态前后逐字对比 | **工具仓库失败（tmp 残留）/ 真实项目通过** | — |

## 覆盖率与解析率

主扫描状态 `completed-with-gaps`（gap 即下述 2 个瞬时失败）。报告不再单文件落盘，采用 ≤1MB manifest + 逐文档 gzip sidecar（最大单文档快照解压 281MB / gzip 17MB，该文档 1386 个节点）。

| 维度 | 总数 | 解码/解析 | 比率 |
| --- | --- | --- | --- |
| 资产 | 6,711 | 6,711 | 100% |
| 脚本 | 906 | 906 | 100% |
| 文档 | 375 | 373 | 99.5% |
| 节点 | 60,608 | 60,608 | 100% |
| 组件 | 157,613 | 157,613 | 100% |
| 属性 | 4,792,728 | 4,792,728 | 100% |
| 引用 | 638,468 | 318,201 | 49.8% |
| Prefab 实例 | 3,234 | 3,194 | 98.8% |
| Override | 33,868 | 33,868 | 100% |

引用解析率 49.8% 需要说明：unresolved 顶层记录共 66,144 条，分布为 `SOURCE_VALUE_REQUIRES_PREFAB_SOURCE_LOOKUP` 32,865、`EFFECTIVE_VALUE_REQUIRES_TARGET_RESOLUTION` 32,865（两者是 Override 值需要跨文档源查询/目标解析的分类标记，成对出现）、`CREATOR_OVERRIDE_VALUE_UNDEFINED` 372、`PREFAB_INSTANCE_FILE_ID_MISSING` 40，以及 2 个文档失败各 1 条。引用计数粒度与 unresolved 记录粒度不同，逐 kind 引用下钻可通过 MCP/CLI 对报告分页读取。

## Prefab 引用图

- 图节点 375 个（Scene/Prefab 资产），边 3,195 条（全部 `prefab-instance`）
- 最大嵌套深度：3
- 诊断 60 条：`PREFAB_INSTANCE_FILE_ID_MISSING` 40（warning，缺少实例 FileID，不建伪边）、`PREFAB_TARGET_LOCAL_ID_UNRESOLVED` 19、`PREFAB_TARGET_LOCAL_ID_RESOLUTION_SUMMARY` 1（info）
- 无循环引用阻断诊断

## 多段 localID

Override 目标共 32,870 个：单段 31,855、多段 1,015；解析 32,851（99.94%），失败 19 个且按修复后的归属逻辑报告准确失败段，未出现退化为首段/末段猜测。

## MissingScript 与失效引用

- MissingScript：主扫描全部 unresolved 中无 `SCRIPT_CLASS_NOT_REGISTERED` 记录，未发现 MissingScript（0）
- 失效引用：顶层 unresolved 中无 missing 类引用记录；`PREFAB_INSTANCE_FILE_ID_MISSING` 40 条与 `CREATOR_OVERRIDE_VALUE_UNDEFINED` 372 条为最接近"失效"的标记，均已保留原始数据可复查

## 失败资源清单与事后复核

| 资产 | 扫描期错误 | 事后复核 |
| --- | --- | --- |
| `db://assets/main.scene`（ba0b085f） | `DOCUMENT_CHANGED_DURING_SCAN`：扫描期间文档发生变化 | 单独 openAsset + documentSnapshot 成功，确认为扫描窗口内的瞬时变化 |
| `db://assets/qyq/club/ClubView.prefab`（808284d7） | `DOCUMENT_IDENTITY_MISMATCH`：首次读取时 `cce.SceneFacadeManager` 返回 `CURRENT_DOCUMENT_UUID_EMPTY` | 单独重读成功（identitySource=`cce.SceneFacadeManager`、mode=`prefab`、failures 为空），确认为 Prefab 编辑门面身份绑定延迟的瞬时状态 |

两个文档实质可读，375/375 在内容层面均可读取；建议后续在扫描器中对这两类瞬时错误增加有限次重试（本次未实现，不影响验收结论）。

## 内部 API 风险

- 文档身份与 Undo 依赖内部 `cce.SceneFacadeManager`：ClubView 的 `CURRENT_DOCUMENT_UUID_EMPTY` 瞬态是该依赖的真实风险样本，其它 3.8.x 版本必须重新验证
- Editor state 中 `document.assetUuid`、`preview` 仍标记 `PUBLIC_API_NOT_CONFIRMED`，保留了 unresolved 而非猜测
- Bridge 能力表已包含 `probe.undoSavePrepare/Confirm/Status` 写相关入口：本轮及 Phase 1 全程未调用任何写方法、保存消息或 Undo，仅登记存在，供 Phase 2 评审
- `query-node.__prefab__` 等内部结构沿用 Phase 0 记录的既有风险

## Git 状态前后对比

### 真实项目 xy-client：通过

before/after 逐字一致，均仅含 `settings/v2/packages/engine.json` 与 `settings/v2/packages/information.json` 两个已修改文件。其中 `information.json` 是 Creator 重启时刷新 splash 表单 sid 所致，发生在扫描基线记录之前；`engine.json` 为既有改动。扫描本身未产生任何项目文件变化、未 stage 任何内容。

### 工具仓库 tmp 事件：已定位、已清理、已修复

- 现象：统一验证 summary 因工具仓库 Git 前后对比失败标记 `failed`，差异仅为 `reports/…-interrupt-seed.assets.json.gz.<pid>.<guid>.tmp` 一个未跟踪临时文件
- 根因：中断恢复环节故意终止种子扫描 CLI 时，其报告原子写（临时文件 + 改名）遗留了 tmp；`*.tmp` 不在 `.gitignore` 的 `reports/*.json.gz` 等模式覆盖内
- 与扫描正确性无关：12/12 验证步骤通过，真实项目对比通过，tmp 内容不是有效证据
- 处置：tmp 已删除；`Invoke-ServerInterruptRecovery` 的 `finally` 新增按 `$reportPrefix-interrupt-seed.*.tmp` 模式清理（TDD 合同 11/11 通过），`.gitignore` 增加 `reports/*.tmp` 兜底；PowerShell AST 0 错误，全量 262 测试通过
- 未重跑全量统一验证：修复属于装置收尾，下一轮真实/隔离运行自然覆盖

## 与 Task 10 隔离轮对比

| 维度 | Task 10 隔离轮（421 文档） | 本轮真实 xy-client（375 文档） |
| --- | --- | --- |
| 文档失败 | 82（47 IDENTITY_MISMATCH + 23 CURSOR_STALE + 12 SCAN_FAILED） | 2（均证实瞬时） |
| unresolved | 34,840 | 66,144（新增 Override 分类统计口径，两轮不可直接对比） |
| 报告体积 | 约 5.44GB × 2 单文件 | manifest ≤1MB + gzip sidecar |
| 总耗时 | 约 74 分钟 | 约 83 分钟（真实 Creator 查询延迟更高） |

两轮目标资产集不同（隔离 worktree 为固定检出，真实工作区含最新提交与未提交内容），对比仅用于趋势判断，不作为逐项回归依据。

## 已知限制

- 兼容结论仍严格限定 Creator 3.8.8
- 单文档原始快照最大 281MB：Phase 2 按需读取应按场景分档 `includeRaw`，避免无差别全量原始数据
- 真实 Creator 的查询延迟明显高于隔离实例（同内容扫描慢约 2 倍），长时间扫描应避开编辑器高负载时段
- 验证脚本以静态合同断言为主，tmp 清理路径的真实覆盖依赖下一轮统一运行
