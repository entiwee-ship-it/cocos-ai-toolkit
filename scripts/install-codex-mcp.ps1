[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ToolkitPath = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
    [string]$ProbeUrl = 'ws://127.0.0.1:32188',
    [string]$ReportRoot = '',
    [string]$NodePath = '',
    [switch]$SkipBuild,
    [switch]$Readonly
)

$ErrorActionPreference = 'Stop'
if (-not $ToolkitPath) { $ToolkitPath = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0' }
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
    if (-not $PSCmdlet.ShouldProcess($ToolkitPath, '构建 MCP Server')) { return }
    npm --prefix $ToolkitPath run build
    if ($LASTEXITCODE -ne 0) { throw 'MCP Server 构建失败' }
}
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "MCP Server 构建产物不存在: $entry"
}

if (-not $ReportRoot) { $ReportRoot = Join-Path $ToolkitPath 'reports' }
$ReportRoot = [IO.Path]::GetFullPath($ReportRoot)
New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null

$codexCommand = (Get-Command codex -ErrorAction Stop).Source
$configPath = Join-Path $env:USERPROFILE '.codex/config.toml'
$configDirectory = Split-Path -Parent $configPath
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
$backupPath = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = "$configPath.$stamp.bak"
    if (-not $PSCmdlet.ShouldProcess($configPath, "备份到 $backupPath")) { return }
    Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
}

if (-not $PSCmdlet.ShouldProcess('Codex MCP 配置', '移除旧 cocos_ai 并添加 MCP 配置')) { return }
& $codexCommand mcp remove cocos_ai 2>$null
# remove 在条目不存在时会返回非零；这是幂等安装的正常情况。
$serverArgs = @($entry)
if (-not $Readonly) { $serverArgs += '--enable-writes' }
& $codexCommand mcp add cocos_ai `
    --env "COCOS_AI_PROBE_SERVER_URL=$ProbeUrl" `
    --env "COCOS_AI_MCP_REPORT_ROOT=$ReportRoot" `
    -- $NodePath @serverArgs
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP 配置写入失败' }

Write-Output $(if ($Readonly) { '已安装 cocos_ai（只读模式）' } else { '已安装 cocos_ai（默认写入）' })
Write-Output "Probe: $ProbeUrl"
Write-Output "报告根: $ReportRoot"
Write-Output "入口: $NodePath $entry"
if (-not $Readonly) { Write-Output '写工具: 已开启（--enable-writes）' }
if ($Readonly) { Write-Output '写工具: 已关闭（只读模式）' }
if ($backupPath) { Write-Output "配置备份: $backupPath" }
Write-Output '请重启 Codex 或新建会话后运行 scripts/check-codex-mcp.ps1。'
