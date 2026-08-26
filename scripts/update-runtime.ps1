<#
.SYNOPSIS
    一键把 Cocos AI 运行时 Worktree 更新到远程最新代码并重建、重启 Probe Server。

.DESCRIPTION
    运行时布局（与 install-bridge.ps1、mcp.json 约定一致）：
    - 开发在主仓库检出（master），MCP / Probe / Bridge 全部从「运行时 Worktree」加载。
    - 本脚本固定运行时 Worktree 的入口路径不变，原地同步代码并重建，
      保证 AI 客户端的 MCP 配置无需修改即可始终指向最新版本。

    执行步骤：
    1. git fetch 并让运行时 Worktree 以 detached HEAD 对齐目标引用（默认 origin/master）。
    2. 依赖清单或 lockfile 变化时执行 npm install。
    3. 代码变化或产物缺失时执行 npm run build（全 workspace）。
    4. 重启 Probe Server，等待 Ready 事件并执行真实 WebSocket editors 请求。
    5. 任一步失败时恢复旧提交、旧构建和更新前的 Probe 运行状态。

    注意：
    - MCP Server 是 AI 客户端在会话启动时拉起的 stdio 进程，
      脚本执行完后需要重启 Kimi Code / Codex 会话才会加载新构建。
    - 若 packages/bridge-extension 有变更，需要在 Cocos Creator 中刷新/重启扩展。

.EXAMPLE
    # 从主仓库检出执行（推荐）
    & E:/xile-workspace/cocos-ai-toolkit/scripts/update-runtime.ps1

.EXAMPLE
    # 只同步代码和构建，不动正在运行的 Probe Server
    & E:/xile-workspace/cocos-ai-toolkit/scripts/update-runtime.ps1 -SkipProbeRestart
#>
param(
    # 运行时 Worktree 路径，与 mcp.json / install-bridge.ps1 的默认约定一致
    [string]$RuntimeWorktree = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
    # 同步目标，默认远程 master 最新
    [string]$TargetRef = 'origin/master',
    # Probe Server 监听端口
    [int]$Port = 32188,
    # 强制重新 npm install + build（即使代码没有变化）
    [switch]$Force,
    # 跳过 Probe Server 重启
    [switch]$SkipProbeRestart
)

$ErrorActionPreference = 'Stop'

function Invoke-Native {
    # 调用外部进程。函数作用域内把 EAP 降为 Continue，
    # 避免外部进程向 stderr 写正常信息（如 git/npm 的提示）被当成终止错误。
    param([string]$FilePath, [string[]]$NativeArgs, [switch]$AllowFail)
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @NativeArgs 2>&1
    $code = $LASTEXITCODE
    if (-not $AllowFail -and $code -ne 0) {
        throw "$FilePath $($NativeArgs -join ' ') 失败（退出码 $code）：`n$($output | Out-String)"
    }
    return @{ Output = @($output | ForEach-Object { "$_" }); ExitCode = $code }
}

function Invoke-Git {
    param([string[]]$GitArgs, [switch]$AllowFail)
    return Invoke-Native -FilePath 'git' -NativeArgs (@('-C', $script:Worktree) + $GitArgs) -AllowFail:$AllowFail
}

function Get-ProbeListener {
    param([int]$Port)
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return $null }
    if ($listeners.Count -gt 1) { throw "端口 $Port 存在多个监听进程，拒绝自动接管" }
    $processId = [int]$listeners[0].OwningProcess
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if (-not $processInfo) { throw "无法读取端口 $Port 监听进程信息（PID $processId）" }
    return [pscustomobject]@{
        ProcessId = $processId
        CommandLine = [string]$processInfo.CommandLine
    }
}

function Assert-ProbeListener {
    param($Listener, [string]$ExpectedEntry, [int]$Port)
    $normalizedEntry = [IO.Path]::GetFullPath($ExpectedEntry).Replace('\', '/')
    $normalizedCommand = ([string]$Listener.CommandLine).Replace('\', '/')
    if ($normalizedCommand.IndexOf($normalizedEntry, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "端口 $Port 被非目标 Probe Server 占用（PID $($Listener.ProcessId): $($Listener.CommandLine)）"
    }
}

function Stop-ProbeRuntime {
    param($Listener, [string]$ExpectedEntry, [int]$Port)
    Assert-ProbeListener -Listener $Listener -ExpectedEntry $ExpectedEntry -Port $Port
    Stop-Process -Id $Listener.ProcessId -Force
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-ProbeListener -Port $Port)) { return }
    }
    throw "Probe Server 停止后端口仍被占用: $Port"
}

function Start-ProbeRuntime {
    param(
        [string]$Worktree,
        [string]$NodePath,
        [string]$ProbeEntry,
        [string]$CliEntry,
        [int]$Port,
        [string]$ReportRoot
    )
    if (-not (Test-Path -LiteralPath $ProbeEntry -PathType Leaf)) { throw "Probe Server 构建产物不存在: $ProbeEntry" }
    if (-not (Test-Path -LiteralPath $CliEntry -PathType Leaf)) { throw "CLI 构建产物不存在: $CliEntry" }
    New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
    $outLog = Join-Path $ReportRoot 'probe-server.out.log'
    $errLog = Join-Path $ReportRoot 'probe-server.err.log'
    Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
    $env:COCOS_AI_PROBE_HOST = '127.0.0.1'
    $env:COCOS_AI_PROBE_PORT = [string]$Port
    $env:COCOS_AI_PROBE_REPORT_ROOT = $ReportRoot
    $env:COCOS_AI_CAPTURE_ROOT = Join-Path $ReportRoot 'runtime-captures'
    $process = Start-Process -FilePath $NodePath -ArgumentList "`"$ProbeEntry`"" -WorkingDirectory $Worktree `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    try {
        $readyMessage = $null
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 500
            if ($process.HasExited) {
                $errTail = if (Test-Path $errLog) { Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue } else { '' }
                throw "Probe Server 启动后立即退出（PID $($process.Id)）：`n$errTail"
            }
            $readyLine = if (Test-Path $outLog) {
                Get-Content $outLog -ErrorAction SilentlyContinue |
                    Where-Object { $_ -match '"type"\s*:\s*"probe-server\.ready"' } |
                    Select-Object -Last 1
            }
            if ($readyLine) {
                $readyMessage = $readyLine | ConvertFrom-Json
                if ($readyMessage.type -eq 'probe-server.ready' -and $readyMessage.url -eq "ws://127.0.0.1:$Port") { break }
            }
        }
        if (-not $readyMessage -or $readyMessage.url -ne "ws://127.0.0.1:$Port") {
            throw "Probe Server 启动后 20 秒内未发布正确 Ready 事件"
        }
        $listener = Get-ProbeListener -Port $Port
        if (-not $listener) { throw "Probe Server 发布 Ready 后未监听端口 $Port" }
        Assert-ProbeListener -Listener $listener -ExpectedEntry $ProbeEntry -Port $Port
        if ($listener.ProcessId -ne $process.Id) {
            throw "Probe Server 监听 PID 与本次启动进程不一致（启动 $($process.Id)，监听 $($listener.ProcessId)）"
        }
        Invoke-Native -FilePath $NodePath -NativeArgs @($CliEntry, 'editors') | Out-Null
        return $process
    } catch {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Start-OrAdoptProbeRuntime {
    param(
        [string]$Worktree,
        [string]$NodePath,
        [string]$ProbeEntry,
        [string]$CliEntry,
        [int]$Port,
        [string]$ReportRoot
    )
    $existing = Get-ProbeListener -Port $Port
    if ($existing) {
        Assert-ProbeListener -Listener $existing -ExpectedEntry $ProbeEntry -Port $Port
        Invoke-Native -FilePath $NodePath -NativeArgs @($CliEntry, 'editors') | Out-Null
        return [pscustomobject]@{ Id = $existing.ProcessId }
    }
    try {
        return Start-ProbeRuntime -Worktree $Worktree -NodePath $NodePath -ProbeEntry $ProbeEntry `
            -CliEntry $CliEntry -Port $Port -ReportRoot $ReportRoot
    } catch {
        $startFailure = $_.Exception.Message
        $existing = Get-ProbeListener -Port $Port
        if (-not $existing) { throw }
        Assert-ProbeListener -Listener $existing -ExpectedEntry $ProbeEntry -Port $Port
        Invoke-Native -FilePath $NodePath -NativeArgs @($CliEntry, 'editors') | Out-Null
        Write-Output "  Bridge 已抢先拉起同源 Probe，更新脚本接管 PID $($existing.ProcessId)：$startFailure"
        return [pscustomobject]@{ Id = $existing.ProcessId }
    }
}

# ---------- 1. 校验运行时 Worktree ----------
$script:Worktree = [IO.Path]::GetFullPath($RuntimeWorktree)
if (-not (Test-Path -LiteralPath $script:Worktree -PathType Container)) {
    throw "运行时 Worktree 不存在: $script:Worktree"
}
$inside = (Invoke-Git @('rev-parse', '--is-inside-work-tree')).Output
if ("$inside".Trim() -ne 'true') {
    throw "目标不是 Git Worktree: $script:Worktree"
}
# 有 tracked 本地改动时拒绝覆盖，untracked（如 reports/ 输出）不影响
$dirtyUnstaged = (Invoke-Git @('diff', '--quiet', 'HEAD', '--') -AllowFail).ExitCode -ne 0
$dirtyStaged = (Invoke-Git @('diff', '--cached', '--quiet') -AllowFail).ExitCode -ne 0
if ($dirtyUnstaged -or $dirtyStaged) {
    throw "运行时 Worktree 存在未提交的 tracked 改动，已中止以避免覆盖: $script:Worktree"
}

# ---------- 2. 解析目标版本 ----------
Write-Output '==> 拉取远程最新代码'
$old = ("$((Invoke-Git @('rev-parse', 'HEAD')).Output)".Trim())
Invoke-Git @('fetch', 'origin', '--prune') | Out-Null
$target = ("$((Invoke-Git @('rev-parse', "$TargetRef^{commit}")).Output)".Trim())
if (-not $target) { throw "无法解析目标引用: $TargetRef" }

$codeChanged = $old -ne $target
$changedFiles = @()
if ($codeChanged) {
    $changedFiles = @((Invoke-Git @('diff', '--name-only', $old, $target)).Output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}
$nodeModulesMissing = -not (Test-Path -LiteralPath (Join-Path $script:Worktree 'node_modules') -PathType Container)
$manifestChanged = $changedFiles | Where-Object { $_ -match '(^|/)package(-lock)?\.json$' }
$mcpEntry = Join-Path $script:Worktree 'packages/mcp-server/dist/run.js'
$probeEntry = Join-Path $script:Worktree 'packages/probe-server/dist/run.js'
$cliEntry = Join-Path $script:Worktree 'packages/cli/dist/index.js'
$distMissing = -not (Test-Path -LiteralPath $mcpEntry -PathType Leaf) -or -not (Test-Path -LiteralPath $probeEntry -PathType Leaf)
$bridgeChanged = $changedFiles | Where-Object { $_ -like 'packages/bridge-extension/*' }
$node = $null
if (-not $SkipProbeRestart) {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = 'D:/nodejs/node.exe' }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "找不到 node.exe: $node" }
}
$oldProbeStopped = $false
$hadOldProbe = $false
$reportRoot = Join-Path $script:Worktree 'reports'

try {
    # 运行工作树只承载构建产物，保持 detached HEAD，避免产生额外本地分支。
    Invoke-Git @('checkout', '--detach', $target) | Out-Null
    if ($codeChanged) {
        Write-Output ("==> 代码已更新: {0} -> {1}" -f $old.Substring(0, 7), $target.Substring(0, 7))
    } else {
        Write-Output ("==> 代码已是最新: {0}" -f $target.Substring(0, 7))
    }

    if ($Force -or $nodeModulesMissing -or $manifestChanged) {
        Write-Output '==> 安装依赖（npm install）'
        Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $script:Worktree, 'install') | Out-Null
    }
    if ($Force -or $codeChanged -or $distMissing -or $manifestChanged) {
        Write-Output '==> 构建全部 workspace（npm run build）'
        Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $script:Worktree, 'run', 'build') | Out-Null
    } else {
        Write-Output '==> 构建产物已是最新，跳过构建'
    }

    if (-not $SkipProbeRestart) {
        Write-Output "==> 重启 Probe Server（端口 $Port）"
        $listener = Get-ProbeListener -Port $Port
        if ($listener) {
            Assert-ProbeListener -Listener $listener -ExpectedEntry $probeEntry -Port $Port
            $hadOldProbe = $true
            Stop-ProbeRuntime -Listener $listener -ExpectedEntry $probeEntry -Port $Port
            $oldProbeStopped = $true
            Write-Output "    已停止旧进程 PID $($listener.ProcessId)"
        }
        $newProbe = Start-OrAdoptProbeRuntime -Worktree $script:Worktree -NodePath $node -ProbeEntry $probeEntry `
            -CliEntry $cliEntry -Port $Port -ReportRoot $reportRoot
        Write-Output "    Probe Server 已就绪并通过 WebSocket 健康检查: ws://127.0.0.1:$Port (PID $($newProbe.Id))"
    }
} catch {
    $updateFailure = $_.Exception.Message
    $rollbackErrors = @()
    try {
        Invoke-Git @('checkout', '--detach', $old) | Out-Null
        Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $script:Worktree, 'install') | Out-Null
        Invoke-Native -FilePath 'npm' -NativeArgs @('--prefix', $script:Worktree, 'run', 'build') | Out-Null
    } catch {
        $rollbackErrors += "源码/构建恢复失败: $($_.Exception.Message)"
    }
    if ($oldProbeStopped -and $hadOldProbe -and -not $SkipProbeRestart -and $rollbackErrors.Count -eq 0) {
        try {
            $restoredProbe = Start-OrAdoptProbeRuntime -Worktree $script:Worktree -NodePath $node -ProbeEntry $probeEntry `
                -CliEntry $cliEntry -Port $Port -ReportRoot $reportRoot
            Write-Output "    已恢复旧 Probe Server（PID $($restoredProbe.Id)）"
        } catch {
            $rollbackErrors += "旧 Probe 恢复失败: $($_.Exception.Message)"
        }
    }
    if ($rollbackErrors.Count -gt 0) {
        throw "更新失败且回滚失败。原始错误: $updateFailure`n回滚失败: $($rollbackErrors -join ' | ')"
    }
    throw "更新失败，已恢复旧运行时 $($old.Substring(0, 7)): $updateFailure"
}

# ---------- 5. 汇总与提醒 ----------
Write-Output ''
Write-Output '==== 更新完成 ===='
Write-Output ("运行时 Worktree : {0}" -f $script:Worktree)
Write-Output ("代码版本        : {0}" -f $target.Substring(0, 7))
Write-Output '后续生效提醒：'
Write-Output '  1. MCP Server 由 AI 客户端在会话启动时拉起，请重启 Kimi Code / Codex 会话加载新版本。'
if ($bridgeChanged) {
    Write-Output '  2. Bridge Extension 有变更，请在 Cocos Creator 中刷新/重启扩展（或重新打开项目）。'
}
