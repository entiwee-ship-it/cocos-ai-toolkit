# Cocos AI 阶段五运行态与视觉验证 Findings

> 日期：2026-07-22；分支 `feature/phase-5-runtime-visual`；基线 `4266b31`（阶段四 GO）。
> 环境：Cocos Creator 3.8.8（严格限定）、Windows、Bridge 0.1.28、协议 0.6.0。

## 结论：GO

设计规格阶段 5「运行态与视觉验证」全部落地：Preview 编程启停、运行时层级/组件读取、方法调用、属性监听、输入模拟、Console 捕获、Game 视图截图（指定/多分辨率、裁剪、差异图、节点边界与锚点叠加）、自动场景验证。CLI 与 MCP 双入口齐备，运行态数据与编辑态严格区分，运行时不回写编辑态。

## 一、通道选型定论（Task 1 探针）

**外部浏览器驱动**（playwright-core + 系统 Chrome/Edge channel），preview-template 注入方案弃用。决定性证据：

- 编辑器**没有停止 preview 页面的公开消息**（`open-terminal` 非 toggle，每次新开），生命周期必须自控。
- preview server bind 0.0.0.0，任意浏览器打开 URL 即接入；127.0.0.1 回环可用，自 launch 一律规范化。
- CDP 截图避开 WebGL preserveDrawingBuffer 黑屏；console/真实输入开箱即用；**零项目侵入**（不写 preview-template，无需还原）。

详见 `docs/phase-5-probe-findings.md`（含 preview 消息矩阵实测表）。

## 二、能力验收矩阵

| 能力 | 入口（CLI / MCP） | 空白项目实证 | 真实项目（xy-client 隔离 Worktree）实证 |
| --- | --- | --- | --- |
| Preview 启停/会话 | `preview-launch/stop/sessions` / `cocos_preview_launch/stop/sessions` | 21 步统一脚本全绿 | 端口 7458 正确路由，720x1280 精确生效 |
| 运行时层级 | `runtime-hierarchy` / `cocos_runtime_get_hierarchy` | phase2-probe 场景 | 登录场景 40+ 节点：root[Boost,Main]、gui、OopsFramework 常驻节点、Profiler |
| 运行时组件 | `runtime-component` / `cocos_runtime_inspect_component` | UITransform 读取，cc. 前缀兼容 | `LoginViewComp` 12 字段（nodes/resPaths/ent.autoLoginFlag），循环引用防护 |
| 方法调用 | `runtime-invoke` / `cocos_runtime_invoke_method` | setContentSize 后重读 `_contentSize` 生效 | — |
| 属性监听 | `runtime-watch` / `cocos_runtime_watch_property` | 恒定超时形态、变化捕获 200→333 | — |
| 输入模拟 | `runtime-input` / `cocos_runtime_dispatch_input` | tap 坐标换算、key 派发回执 | — |
| Console 捕获 | `runtime-console` / `cocos_runtime_get_console` | 引擎启动日志、级别过滤、游标 | 96 条真实业务日志（卡顿帧/打开 UI login） |
| 截图与视觉 | `runtime-capture` / `cocos_runtime_capture` | 默认/多分辨率/裁剪/叠加（红框绿十字） | 720x1280 登录画面（角色立绘/按钮/logo），login 边界与锚点叠加 |
| 自动场景验证 | `runtime-scenario` / `cocos_runtime_run_scenario` | 七步全绿（自建会话+图像差异 ratio 0） | — |
| Git 一致性 | 统一脚本前后逐字对比 | 一致 | **一致（零工程写入）** |

真实项目证据文件：`reports/runtime-captures/preview-1784708951907/20260722092209751-0.png`（登录画面叠加图）；空白往返报告：`reports/phase-5-20260722T080012233Z-8fe3b4c4-summary.json`（passed，21 步）。

## 三、关键语义（已固化进协议与脚本）

1. **运行态数据标记**：快照恒带 `source: 'preview-runtime'`；动态创建节点 `dynamic: true`（无序列化 fileId）；运行时组件类型名不带 `cc.` 前缀（`UITransform`），读取自动兼容 `cc.` 前缀并回传实际名；运行时 ID 形态（`Node.1343`/`Comp.2718`）≠ 编辑态 UUID。
2. **分辨率**：请求值≠生效值，协议必须回传 `actualResolution`；launch/capture 均先放大视口（+200 余量容纳工具栏）再设置，请求值精确生效。
3. **Console 游标**：scenario 断言以场景启动时刻为基准（覆盖"动作同步产生日志"）；`runtime-console` 支持 seq 增量与级别过滤。
4. **输入坐标**：画布内 CSS 像素，driver 按画布包围盒换算页面坐标；回执只证明派发，游戏响应须断言验证。
5. **Preview 启动场景**：`start_scene=current_scene` 语义——preview 加载**编辑器当前打开的场景**；场景激活阶段引擎资产缺失（如 Skybox 环境贴图）会阻塞游戏启动（console 可见错误），需先打开正确场景。

## 四、已知限制

1. **Scene 视图截图不提供**：`scene/snapshot` 消息存在但无可见产物；视觉验证仅 Game 视图。
2. **preview 页面停止**：无公开消息；编辑器自行打开的页面（open-terminal/用户手动 Ctrl+P）工具不接管，工具只管理自 launch 页面。
3. **preview server bind 0.0.0.0**：同网段可访问预览页；工具自 launch 一律 127.0.0.1，但端口本身暴露网段（Creator 行为，无法收口的记录）。
4. **`preview/generate-settings`**：browser 平台不可用（内部错误）；设备清单从页面 DOM 读取。
5. **叠加边界依赖 UITransform**（2D UI）；3D 节点边界与 Scene 视图叠加未覆盖。
6. **输入坐标系**：画布 CSS 像素（非设计分辨率坐标）；设计分辨率→画布坐标的换算留给调用方（节点边界能力可辅助定位）。
7. **xy-client preview 依赖内网服务器**：登录流程不可达时 login UI 反复重试（卡顿帧警告属预期）；验收不依赖登录成功。

## 五、往返与修复记录

- 空白项目统一脚本（`scripts/run-phase-5-runtime-validation.ps1`）21 步全绿 ×2（SkipStatic 版与完整版各一）。
- 往返修复：`driver.launch` 视口余量（分辨率精确生效）、scenario Console 游标语义、差异基准图补拍顺序、PowerShell StrictMode 键访问与 `-Condition` 括号。
- 全仓验证：npm test 680/680、typecheck、build、git diff --check 干净。

## 六、产物清单

- 协议 0.6.0：`packages/protocol/src/runtime.ts`（会话/快照/Console/截图/场景报告 Schema）。
- Bridge 0.1.28：`probe.previewOpen/previewStatus/previewReload` + `probe.debugEditorMessage`（诊断）。
- Probe Server：运行态方法族（previewLaunch/Stop/Sessions/Session、runtimeConsole/Hierarchy/Component/Invoke/Watch/DispatchInput/Capture/RunScenario），内置 RuntimeDriver（playwright-core）。
- core：runtime-driver/runtime-inject（页面注入函数集+buildRuntimeScript 打包）/runtime-read/runtime-interact/runtime-capture（pngjs 图像管线）/runtime-scenario。
- CLI：preview-launch/stop/sessions、runtime-console/hierarchy/component/invoke/watch/input/capture/scenario。
- MCP：6 只读工具 + 5 门控工具（--enable-writes）。
- 文档：phase-5-probe-findings、phase-5-blank-roundtrip、能力矩阵运行态条目。
