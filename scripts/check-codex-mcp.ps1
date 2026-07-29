[CmdletBinding()]
param(
    [string]$ToolkitPath = '',
    [string]$ProbeUrl = 'ws://127.0.0.1:32188',
    [string]$ReportRoot = '',
    [ValidateSet('prefab', 'full')]
    [string]$Profile = 'prefab',
    [switch]$Readonly
)

$ErrorActionPreference = 'Stop'
if (-not $ToolkitPath) { $ToolkitPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$ToolkitPath = [IO.Path]::GetFullPath($ToolkitPath)
$entry = Join-Path $ToolkitPath 'packages/mcp-server/dist/run.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "MCP Server 构建产物不存在: $entry"
}
$codex = (Get-Command codex -ErrorAction Stop).Source
$config = & $codex mcp get cocos_ai 2>&1
if ($LASTEXITCODE -ne 0) { throw "Codex 未配置 cocos_ai: $config" }
$configText = $config | Out-String
if (-not $Readonly -and $configText -notmatch '--enable-writes') {
    throw 'Codex cocos_ai 未启用写工具；如需只读检查请显式传 -Readonly'
}
if ($Readonly -and $configText -match '--enable-writes') {
    throw 'Codex cocos_ai 当前启用了写工具，不能按只读模式检查'
}
if ($configText -notmatch [regex]::Escape("--profile=$Profile")) {
    throw "Codex cocos_ai 工具档不是预期值: $Profile"
}
$uri = [Uri]$ProbeUrl
$client = [Net.Sockets.TcpClient]::new()
try {
    $client.Connect($uri.Host, $uri.Port)
} catch {
    throw "Probe Server 不可达: $ProbeUrl"
} finally {
    $client.Dispose()
}
if (-not $ReportRoot) { $ReportRoot = Join-Path $ToolkitPath 'reports' }
$env:COCOS_AI_MCP_ENTRY = $entry
$env:COCOS_AI_PROBE_SERVER_URL = $ProbeUrl
$env:COCOS_AI_MCP_REPORT_ROOT = [IO.Path]::GetFullPath($ReportRoot)
$env:COCOS_AI_MCP_ENABLE_WRITES = if ($Readonly) { 'false' } else { 'true' }
$env:COCOS_AI_MCP_PROFILE = $Profile
$sourceCommit = (& git -C $ToolkitPath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $sourceCommit) {
    throw "无法读取 Toolkit 源码提交: $ToolkitPath"
}
$env:COCOS_AI_SOURCE_COMMIT = $sourceCommit
node (Join-Path $PSScriptRoot 'check-codex-mcp.mjs')
if ($LASTEXITCODE -ne 0) { throw 'MCP stdio 健康检查失败' }
