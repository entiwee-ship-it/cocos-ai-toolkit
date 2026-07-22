# 阶段五空白项目往返验证留档

> 日期：2026-07-22；环境：Cocos Creator 3.8.8、空白项目 `worktrees/cocos-ai-blank/Cocos-ai`、Bridge 0.1.28、协议 0.6.0。
> 运行入口：`pwsh -NoProfile -File scripts/run-phase-5-runtime-validation.ps1 -ProjectPath E:/xile-workspace/worktrees/cocos-ai-blank/Cocos-ai`

## 结论

**passed**。统一脚本完整版（含 npm test/typecheck/build 静态检查）21 步全绿；Git 前后状态逐字一致；Preview 会话与浏览器实例全部关闭。

- 完整版报告：`reports/phase-5-20260722T080012233Z-8fe3b4c4-summary.json`（passed，21 步）
- 中途迭代产生的失败报告保留在同目录（runtime-hierarchy 断言、StrictMode 键访问、scenario 游标与分辨率四类修复前的现场）。

## 覆盖点（21 步）

1. 静态检查：npm test（680 项）、typecheck、build。
2. Bridge 连接：Creator 3.8.8 门禁、`probe.previewOpen/previewStatus` 能力检查。
3. Preview 生命周期：launch 就绪（URL 回环规范化、pageSource=self-launched）、sessions 登记、stop 关闭、停止后读取拒绝（PREVIEW_SESSION_CLOSED）。
4. 运行时读取：hierarchy（source=preview-runtime、dynamic 标注、nodeCount）、component（cc. 前缀兼容匹配）。
5. 交互：invoke setContentSize 后重读 `_contentSize` 确认真实生效；watch 恒定超时形态与改值后初值更新。
6. 输入：tap 坐标换算回执、key 派发。
7. Console：全量读取、error 级别过滤、seq 游标。
8. 截图：默认落盘（PNG 签名与尺寸校验）、多分辨率 720x1280/1280x720 请求值精确生效、差异基准图、节点边界与锚点叠加。
9. 自动场景验证：scenario 自建独立会话（launch 1280x720）→ wait-node → assert-property → dispatch-input → assert-console（匹配启动日志）→ capture → assert-image-diff（ratio 0）七步全绿；scenario 会话独立关闭。
10. Git 一致性：工具仓库与 Creator 项目验证前后 `git status --porcelain=v2 --branch` 逐字一致。

## 往返中修复的问题（随本次留档固化）

1. `driver.launch` 分辨率视口不一致：launch 请求分辨率曾受默认视口约束被压缩（1280x720 生效 1280x673），已改为与 capture 一致先放大视口（+200 余量）再设置，请求值精确生效。
2. scenario Console 游标语义：以场景启动时刻为基准（覆盖"动作同步产生日志"），复用旧会话时启动日志不可见属预期——脚本改为 scenario 自建会话。
3. 差异基准图必须在多分辨率切换之后补拍（尺寸一致性），脚本已固化该顺序。

## 已知边界

- 空白项目场景无可交互控件，输入模拟验证到"派发回执 + cc.input 链路"层；游戏响应断言靠 scenario 在真实项目验收覆盖。
- 叠加截图的节点边界依赖 UITransform（2D UI）；3D 节点边界未覆盖。
