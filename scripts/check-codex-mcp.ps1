[CmdletBinding()]
param(
    [string]$ToolkitPath = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
    [string]$EndpointRoot = '',
    [switch]$Readonly
)

$ErrorActionPreference = 'Stop'
$ToolkitPath = [IO.Path]::GetFullPath($ToolkitPath)
$entry = Join-Path $ToolkitPath 'packages/mcp-server/dist/run.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "MCP Server 构建产物不存在: $entry"
}

$codex = (Get-Command codex -ErrorAction Stop).Source
$config = & $codex mcp get cocos_ai 2>&1
if ($LASTEXITCODE -ne 0) { throw "Codex 未配置 cocos_ai: $config" }
$configText = $config | Out-String
$normalizedEntry = $entry.Replace('\', '/')
$normalizedConfig = $configText.Replace('\', '/')
if ($normalizedConfig.IndexOf($normalizedEntry, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Codex cocos_ai 未指向固定运行时: $entry"
}
if (-not $Readonly -and $configText -notmatch '--enable-writes') {
    throw 'Codex cocos_ai 未启用写工具；如需只读检查请显式传 -Readonly'
}
if ($Readonly -and $configText -match '--enable-writes') {
    throw 'Codex cocos_ai 当前启用了写工具，不能按只读模式检查'
}
if ($configText -match 'COCOS_AI_PROBE|32188|ws://') {
    throw 'Codex cocos_ai 仍包含已经移除的 Probe/WebSocket 配置，请重新运行 install-codex-mcp.ps1'
}

$env:COCOS_AI_MCP_ENTRY = $entry
$env:COCOS_AI_MCP_ENABLE_WRITES = if ($Readonly) { 'false' } else { 'true' }
if ($EndpointRoot) { $env:COCOS_AI_ENDPOINT_ROOT = [IO.Path]::GetFullPath($EndpointRoot) }
$sourceCommit = (& git -C $ToolkitPath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $sourceCommit) {
    throw "无法读取运行时提交: $ToolkitPath"
}
$env:COCOS_AI_SOURCE_COMMIT = $sourceCommit
& node (Join-Path $PSScriptRoot 'check-codex-mcp.mjs')
if ($LASTEXITCODE -ne 0) { throw 'MCP 直连健康检查失败' }
