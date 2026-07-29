# Bridge 生命周期日志设计

## 目标

让开发者在 Cocos Creator 控制台直接确认 Bridge 的真实运行时代码是否完成加载、连接和握手，避免把扩展清单版本误当成当前进程版本。

## 日志合同

所有日志使用固定前缀 `[CocosAI][Bridge]`，事件名称和 JSON 字段使用中文，并覆盖以下生命周期：

- `扩展开始加载`：输出扩展版本、Creator 版本、项目 ID、项目路径、进程 ID、探针地址和能力数量。
- `正在连接探针服务`：开始建立 WebSocket 连接。
- `探针连接已建立`：WebSocket 已连接。
- `已发送身份握手`：Bridge 身份握手已发送。
- `扩展初始化完成`：收到 Probe Server 对 `bridge.hello` 的成功确认；这是运行时加载成功的最终标志。
- `探针连接已断开`：输出关闭码和关闭原因。
- `已安排重新连接`：输出重试次数和等待毫秒数。
- `扩展已卸载`：扩展开始卸载并释放连接。

日志不包含 session token，不记录普通工具请求或响应载荷。字段按单行 JSON 输出，便于人工扫描和后续日志解析。

## 实现边界

`main.ts` 负责 Creator 扩展加载上下文和统一日志前缀；`BridgeClient` 负责产生传输层生命周期事件。BridgeClient 识别 `correlationId=bridge.hello` 的响应，并只在 `ok=true` 时产生 `READY`。连接失败仍沿用现有退避重试，不改变协议和业务处理。

## 验证

自动化测试覆盖连接、握手确认、断线重试和释放事件顺序；版本一致性测试保证根包、workspace、Bridge、MCP 与健康检查统一为 `0.2.4`。真实 Creator 验收以控制台出现 `扩展初始化完成` 且 `npm run codex:check` 返回 Bridge `0.2.4` 为准。
