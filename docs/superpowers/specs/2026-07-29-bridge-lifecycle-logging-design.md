# Bridge 生命周期日志设计

## 目标

让开发者在 Cocos Creator 控制台直接确认 Bridge 的真实运行时代码是否完成加载、连接和握手，避免把扩展清单版本误当成当前进程版本。

## 日志合同

所有日志使用固定前缀 `[CocosAI][Bridge]`，并覆盖以下生命周期：

- `LOAD_START`：输出 Bridge 版本、Creator 版本、项目 ID、项目路径、进程 ID、Probe URL 和能力数量。
- `CONNECTING`：开始建立 WebSocket 连接。
- `SOCKET_OPEN`：WebSocket 已连接。
- `HELLO_SENT`：Bridge 身份握手已发送。
- `READY`：收到 Probe Server 对 `bridge.hello` 的成功确认；这是运行时加载成功的最终标志。
- `DISCONNECTED`：输出关闭码和关闭原因。
- `RETRY_SCHEDULED`：输出重试序号和等待毫秒数。
- `UNLOAD`：扩展开始卸载并释放连接。

日志不包含 session token，不记录普通工具请求或响应载荷。字段按单行 JSON 输出，便于人工扫描和后续日志解析。

## 实现边界

`main.ts` 负责 Creator 扩展加载上下文和统一日志前缀；`BridgeClient` 负责产生传输层生命周期事件。BridgeClient 识别 `correlationId=bridge.hello` 的响应，并只在 `ok=true` 时产生 `READY`。连接失败仍沿用现有退避重试，不改变协议和业务处理。

## 验证

自动化测试覆盖连接、握手确认、断线重试和释放事件顺序；版本一致性测试保证根包、workspace、Bridge、MCP 与健康检查统一为 `0.2.3`。真实 Creator 验收以控制台出现 `READY` 且 `npm run codex:check` 返回 Bridge `0.2.3` 为准。
