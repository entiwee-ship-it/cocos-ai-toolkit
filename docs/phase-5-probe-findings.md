# 阶段五 Preview 运行态技术探针结论

> 日期：2026-07-22；环境：Cocos Creator 3.8.8（Windows）、空白项目 `worktrees/cocos-ai-blank/Cocos-ai`、Bridge 0.1.27（新增 `probe.debugEditorMessage` 探针方法）。
> 每条结论附实际执行的命令/调用与返回证据；未经实测的推断一律标注。

## 一、总体结论（GO）

阶段五运行态与视觉验证**技术可行**，主通道选型定为「**外部浏览器驱动**」：Bridge 负责 preview server 启停与状态查询，工具进程（core 的 runtime-driver）经 Playwright（CDP）launch 系统浏览器打开 preview URL，运行态读取经页面注入脚本（`System.import('cc')`），截图/输入/Console 走 CDP 标准能力。

原计划首选的「preview-template 注入 game probe 直连 Probe Server」降为**可选补充**，本阶段不实现；对应地，计划 Task 3（Probe Server game 会话通道）取消，Task 4 的 game-probe 包改为「页面注入脚本模块」。

## 二、选型对比证据

| 维度 | 外部浏览器驱动（选定） | preview-template 注入（备选） |
| --- | --- | --- |
| 项目侵入 | **零**（不写项目文件） | 需写 preview-template 并在验收后还原 |
| 页面生命周期 | **完全自控**（launch/close 自己实例） | 任何方式打开的页面都接入（含用户手动开的） |
| 截图 | CDP 合成器截图，**避开 WebGL preserveDrawingBuffer 黑屏** | canvas.toDataURL 受 preserveDrawingBuffer=false 影响，需帧内同步抓，可靠性待证 |
| Console | CDP console/pageerror 事件开箱即用（已实测捕获） | 页面内 hook 捕获更全但需自行实现 |
| 输入 | CDP 真实输入管道 + DOM 合成事件（后者已实测进入 cc.input） | 仅 DOM 合成事件 |
| 部署依赖 | playwright-core + 系统 Chrome/Edge（免下载浏览器） | 无额外依赖 |

决定性证据：编辑器**没有公开消息停止 preview 页面**（`open-terminal` 非 toggle，每次调用新开页面，实测 connect-num 1→2→3）；因此工具必须只管理自己 launch 的页面，生命周期自控是硬要求。

## 三、Preview 生命周期消息矩阵（Bridge `Editor.Message` 实测）

| 消息 | 结果 | 证据 |
| --- | --- | --- |
| `preview/query-preview-url` | 可用，返回 `http://192.168.1.23:7457` | preview-messages-readonly.mjs，4ms |
| `preview/query-connect-num` | 可用，返回接入页面数（实测 0→1→2→3） | 同上 |
| `preview/get-preview-ip` | 可用，返回 `192.168.1.23` | 同上 |
| `preview/generate-settings` | **browser 平台不可用**，报 `Cannot read properties of undefined (reading 'type')`（open 前后均如此） | 两次调用同错 |
| `preview/open` | 可用（1ms 返回空）。仅启动/准备 preview server，**不打开页面**（connect-num 保持 0） | preview-launch-sequence.mjs |
| `preview/open-terminal` | 可用，**每次调用新开一个页面**（系统浏览器），非 toggle | connect-num 1→2→3 |
| `preview/reload-terminal` | 可用（返回空），刷新已接入页面 | preview-scene-messages.mjs |
| `preview/preview-scene-in-browser` | 可用（返回空） | 同上 |
| `preview/restart-simulator` | 可用（243ms），browser 平台下语义未深究 | 同上 |
| `preview/change-platform`、`get/set-preview-ip`、`create-template` | 存在（package.json 注册），本阶段未逐项实测 | 静态清单 |

页面停止：**无公开消息**。socket.io 的 `browser:close` 事件（server→页）存在（preview-app/src/index.ts 源码），但无 Editor.Message 入口触发。

## 四、Preview Server 与页面（实测 + 源码）

- `preview/open` 后页面 HTTP 可达：`http://192.168.1.23:7457/` 与 `http://127.0.0.1:7457/` 均返回 200（**server bind 0.0.0.0**；自 launch 一律改写为 127.0.0.1 避免代理/网卡干扰）。
- 页面加载后通过 socket.io 接入 preview server（connect-num +1）；页面监听 `browser:reload/close/disconnect`，上报 `preview error`、`changeOption`（preview-app/src/index.ts、ui.ts 源码）。
- 场景经 HTTP `scene/<uuid>.json` 加载；`preview.current.platform=browser`。
- 页面工具栏设备清单 DOM 可读（`#view-select .options li[data-device]`）：Default(设计分辨率 1280×720)、FullScreen、WebpageFullScreen + 20 款机型预设（iPhone/iPad/华为/小米等，各带宽高）；当前设备实测为 `Apple iPhone 14 Pro (393×852)`。

## 五、运行态能力逐项验证（Playwright 打开 preview 页实测）

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 引擎读取 | `System.import('cc')` 可用；`cc.director.getScene()` 读到场景 `phase2-probe`、顶层 `FixtureRoot`、游戏运行中 | browser_evaluate 返回 |
| 分辨率编程切换 | `cc.screen.windowSize = new cc.Size(w,h)` + `window.dispatchEvent(new Event('resize'))` 生效：960×640 精确生效；720×1280 因页面容器约束实际生效 720×826 | 同上（afterPortrait/afterLandscape） |
| **协议要求** | 分辨率请求值≠实际生效值，协议必须回传**实际生效分辨率** | 同上 |
| 输入模拟 | DOM 合成 `mousedown/mouseup` 进入引擎 Input 系统并派发到 `cc.input` 监听器（错误栈证明链路：HTMLCanvasElement→Input._simulateEventTouch→_dispatchEventTouch→监听器） | console 错误栈 |
| Console 捕获 | Playwright console/pageerror 事件正常捕获页面日志与错误 | browser_console_messages |
| 截图 | Playwright 对 `#GameCanvas` 元素截图成功（CDP 合成器级别，无 WebGL 黑屏问题） | phase5-probe-canvas.png |
| 设备/分辨率清单 | 页面 DOM 读取设备预设列表（见上） | browser_evaluate 返回 |

## 六、Scene 视图截图（编辑态）

- `scene/snapshot` / `scene/snapshot-abort` 消息在 `@cocos/creator-types` 3.8.7 类型中存在；实测调用返回成功（3ms 空返回），但**无可见产物**（空白项目 git status 干净，temp 目录无新文件）。
- 结论：消息存在、行为未证实。阶段五视觉验证以 **Game 视图（preview 页）** 为主；Scene 视图截图候选路径（Scene 面板 webContents capturePage）留作后续补充，本阶段 findings 记为限制。

## 七、对实施计划的调整（Task 1 定论）

1. **Task 3 取消**：页面不直连 Probe Server，不需要 game 会话类型。
2. **Task 4 调整**：`game-probe` 包改为「页面注入脚本模块」（runtime 读取/交互脚本，经 runtime-driver 注入页面执行）；Bridge 新增正式 `preview` 封装（open / query-preview-url / query-connect-num / reload-terminal / 状态聚合），`probe.debugEditorMessage` 保留为诊断方法。
3. **新增 runtime-driver**（core）：Playwright 浏览器实例管理（launch 系统 Chrome/Edge，channel 回退链）、页面会话、evaluate 注入、console/截图/输入桥接。
4. **协议补充**：`PreviewSession` 增加 `actualResolution`（实际生效分辨率）与 `pageSource: 'self-launched'`；视觉验证仅声明 Game 视图，Scene 视图列入已知限制。
5. **已知限制（写入能力矩阵）**：
   - preview 页面无公开停止消息；编辑器自行打开的页面无法编程关闭（本次探针在用户机器留了 2 个预览窗口，需人工关闭）。
   - preview server bind 0.0.0.0，同网段可访问预览页；工具自 launch 一律用 127.0.0.1。
   - `preview/generate-settings` 在 browser 平台不可用；设备清单从页面 DOM 读取。
   - Scene 视图截图（`scene/snapshot`）无可见产物，本阶段不提供 Scene 视图视觉验证。

## 八、复现入口

- 探针脚本：`scripts/probes/phase-5/preview-messages-readonly.mjs`、`preview-launch-sequence.mjs`、`preview-scene-messages.mjs`（随仓库留档）。
- Bridge 探针方法：`probe.debugEditorMessage`（namespace/method/args/mode/timeoutMs，8s 默认超时兜底，挂起消息返回 `EDITOR_MESSAGE_TIMEOUT`）。
