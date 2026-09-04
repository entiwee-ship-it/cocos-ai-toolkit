<#
.SYNOPSIS
把固定 Cocos AI 运行 Worktree 更新到指定提交并重建。

.DESCRIPTION
MCP 由 AI 客户端通过 stdio 管理，Creator Bridge 使用进程内 Named Pipe；
本脚本只负责同步、依赖和构建，不启动任何后台服务。
#>
[CmdletBinding()]
param(
    [string]$RuntimeWorktree = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
    [string]$TargetRef = 'origin/master',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$NativeArgs,
        [switch]$AllowFail
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @NativeArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if (-not $AllowFail -and $exitCode -ne 0) {
        throw "$FilePath $($NativeArgs -join ' ') 失败（退出码 $exitCode）：`n$($output | Out-String)"
    }
    return [pscustomobject]@{
        Output = @($output | ForEach-Object { "$_" })
        ExitCode = $exitCode
    }
}

$worktree = [IO.Path]::GetFullPath($RuntimeWorktree)
if (-not (Test-Path -LiteralPath $worktree -PathType Container)) {
    throw "运行时 Worktree 不存在: $worktree"
}

function Invoke-Git {
    param([string[]]$GitArgs, [switch]$AllowFail)
    return Invoke-Native -FilePath 'git' -NativeArgs (@('-C', $worktree) + $GitArgs) -AllowFail:$AllowFail
}

if ("$((Invoke-Git @('rev-parse', '--is-inside-work-tree')).Output)".Trim() -ne 'true') {
    throw "目标不是 Git Worktree: $worktree"
}
if ((Invoke-Git @('diff', '--quiet', 'HEAD', '--') -AllowFail).ExitCode -ne 0 `
    -or (Invoke-Git @('diff', '--cached', '--quiet') -AllowFail).ExitCode -ne 0) {
    throw "运行时 Worktree 存在未提交的 tracked 改动，拒绝覆盖: $worktree"
}

$old = "$((Invoke-Git @('rev-parse', 'HEAD')).Output)".Trim()
Invoke-Git @('fetch', '--prune') | Out-Null
$target = "$((Invoke-Git @('rev-parse', "$TargetRef^{commit}")).Output)".Trim()
$changedFiles = if ($old -eq $target) {
    @()
} else {
    @((Invoke-Git @('diff', '--name-only', $old, $target)).Output)
}
$manifestChanged = @($changedFiles | Where-Object {
    $_ -match '(^|/)package(-lock)?\.json$'
}).Count -gt 0
$nodeModulesMissing = -not (Test-Path -LiteralPath (Join-Path $worktree 'node_modules') -PathType Container)
$distMissing = @(
    'packages/mcp-server/dist/run.js',
    'packages/cli/dist/index.js',
    'packages/bridge-extension/dist/main.js',
    'packages/bridge-extension/dist/panels/default/index.js'
) | Where-Object { -not (Test-Path -LiteralPath (Join-Path $worktree $_) -PathType Leaf) }

try {
    Invoke-Git @('checkout', '--detach', $target) | Out-Null
    if ($Force -or $nodeModulesMissing -or $manifestChanged) {
        Write-Output '==> 安装依赖（npm install）'
        Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $worktree, 'install') | Out-Null
    }
    if ($Force -or $old -ne $target -or $manifestChanged -or $distMissing.Count -gt 0) {
        Write-Output '==> 构建全部 workspace（npm run build）'
        Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $worktree, 'run', 'build') | Out-Null
    } else {
        Write-Output '==> 构建产物已是最新，跳过构建'
    }
} catch {
    $failure = $_.Exception.Message
    $rollbackErrors = @()
    try {
        Invoke-Git @('checkout', '--detach', $old) | Out-Null
        if ($manifestChanged) {
            Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $worktree, 'install') | Out-Null
        }
        Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $worktree, 'run', 'build') | Out-Null
    } catch {
        $rollbackErrors += $_.Exception.Message
    }
    $suffix = if ($rollbackErrors.Count) { "；回滚失败：$($rollbackErrors -join ' | ')" } else { '' }
    throw "运行时更新失败：$failure；已尝试恢复 $($old.Substring(0, 7))$suffix"
}

if ($old -eq $target) {
    Write-Output "Cocos AI 运行时已是最新: $($target.Substring(0, 7))"
} else {
    Write-Output "Cocos AI 运行时已更新: $($old.Substring(0, 7)) -> $($target.Substring(0, 7))"
}
Write-Output 'Named Pipe 无需启动服务。请刷新 Cocos Creator 扩展，并重启 Codex 任务以加载新的 stdio MCP 进程。'
