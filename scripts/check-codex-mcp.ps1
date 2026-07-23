[CmdletBinding()]
param(
    [string]$ToolkitPath = '',
    [string]$ProbeUrl = 'ws://127.0.0.1:32188',
    [string]$ReportRoot = ''
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
node (Join-Path $PSScriptRoot 'check-codex-mcp.mjs')
if ($LASTEXITCODE -ne 0) { throw 'MCP stdio 健康检查失败' }
