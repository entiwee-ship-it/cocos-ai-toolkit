[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$ToolkitPath = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
  [string]$NodePath = '',
  [string]$EndpointRoot = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ToolkitPath = [IO.Path]::GetFullPath($ToolkitPath)
if (-not (Test-Path -LiteralPath $ToolkitPath -PathType Container)) {
  throw "工具仓库不存在: $ToolkitPath"
}
if (-not $NodePath) {
  $NodePath = (Get-Command node -ErrorAction Stop).Source
}
$NodePath = [IO.Path]::GetFullPath($NodePath)
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "Node 可执行文件不存在: $NodePath"
}

$entry = Join-Path $ToolkitPath 'packages/mcp-server/dist/run.js'
if (-not $SkipBuild -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  if (-not $PSCmdlet.ShouldProcess($ToolkitPath, '构建 Cocos AI MCP Server')) {
    return
  }
  npm --prefix $ToolkitPath run build
  if ($LASTEXITCODE -ne 0) {
    throw 'MCP Server 构建失败'
  }
}
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  throw "MCP Server 构建产物不存在: $entry"
}

$codexCommand = (Get-Command codex -ErrorAction Stop).Source
$configPath = Join-Path $env:USERPROFILE '.codex/config.toml'
$configDirectory = Split-Path -Parent $configPath
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $backupPath = "$configPath.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
  if (-not $PSCmdlet.ShouldProcess($configPath, "备份到 $backupPath")) {
    return
  }
  Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
}
if (-not $PSCmdlet.ShouldProcess('Codex MCP 配置', '替换 cocos_ai 配置')) {
  return
}

& $codexCommand mcp remove cocos_ai 2>$null
$installArgs = @('mcp', 'add', 'cocos_ai')
if ($EndpointRoot) {
  $installArgs += @('--env', "COCOS_AI_ENDPOINT_ROOT=$([IO.Path]::GetFullPath($EndpointRoot))")
}
$installArgs += @('--', $NodePath, $entry)
& $codexCommand @installArgs
if ($LASTEXITCODE -ne 0) {
  throw 'Codex MCP 配置写入失败'
}

Write-Output '已安装 cocos_ai（全部工具默认公开）'
Write-Output '传输: stdio MCP -> Windows Named Pipe -> Creator Bridge'
Write-Output '健康检查: scripts/check-codex-mcp.ps1'
