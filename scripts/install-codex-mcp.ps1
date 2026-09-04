[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ToolkitPath = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
    [string]$NodePath = '',
    [string]$EndpointRoot = '',
    [switch]$SkipBuild,
    [switch]$Readonly
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
    if (-not $PSCmdlet.ShouldProcess($ToolkitPath, '构建 Cocos AI MCP Server')) { return }
    npm --prefix $ToolkitPath run build
    if ($LASTEXITCODE -ne 0) { throw 'MCP Server 构建失败' }
}
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "MCP Server 构建产物不存在: $entry"
}

$codexCommand = (Get-Command codex -ErrorAction Stop).Source
$configPath = Join-Path $env:USERPROFILE '.codex/config.toml'
$configDirectory = Split-Path -Parent $configPath
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
$backupPath = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $backupPath = "$configPath.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    if (-not $PSCmdlet.ShouldProcess($configPath, "备份到 $backupPath")) { return }
    Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
}
if (-not $PSCmdlet.ShouldProcess('Codex MCP 配置', '替换 cocos_ai 配置')) { return }

& $codexCommand mcp remove cocos_ai 2>$null
$serverArgs = @($entry)
if (-not $Readonly) { $serverArgs += '--enable-writes' }
$installArgs = @('mcp', 'add', 'cocos_ai')
if ($EndpointRoot) {
    $installArgs += @('--env', "COCOS_AI_ENDPOINT_ROOT=$([IO.Path]::GetFullPath($EndpointRoot))")
}
$installArgs += @('--', $NodePath)
$installArgs += $serverArgs
& $codexCommand @installArgs
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP 配置写入失败' }

Write-Output $(if ($Readonly) { '已安装 cocos_ai（只读模式）' } else { '已安装 cocos_ai（默认写入）' })
Write-Output '传输: Creator Named Pipe（无端口、无独立后台服务）'
Write-Output "入口: $NodePath $entry"
if ($backupPath) { Write-Output "配置备份: $backupPath" }
Write-Output '请刷新 Creator 扩展并重启 Codex 或新建任务，然后运行 scripts/check-codex-mcp.ps1。'
