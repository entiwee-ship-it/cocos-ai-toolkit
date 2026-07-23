<#
.SYNOPSIS
    一键把 Cocos AI 运行时 Worktree 更新到远程最新代码并重建、重启 Probe Server。

.DESCRIPTION
    运行时布局（与 install-bridge.ps1、mcp.json 约定一致）：
    - 开发在主仓库检出（master），MCP / Probe / Bridge 全部从「运行时 Worktree」加载。
    - 本脚本固定运行时 Worktree 的入口路径不变，原地同步代码并重建，
      保证 AI 客户端的 MCP 配置无需修改即可始终指向最新版本。

    执行步骤：
    1. git fetch 并把运行时 Worktree 的本地 runtime 分支重置到目标引用（默认 origin/master）。
    2. 依赖清单或 lockfile 变化时执行 npm install。
    3. 代码变化或产物缺失时执行 npm run build（全 workspace）。
    4. 重启 Probe Server 并等待端口就绪。

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

# ---------- 2. 同步代码到最新 ----------
Write-Output '==> 拉取远程最新代码'
Invoke-Git @('fetch', 'origin', '--prune') | Out-Null
$target = ("$((Invoke-Git @('rev-parse', "$TargetRef^{commit}")).Output)".Trim())
$old = ("$((Invoke-Git @('rev-parse', 'HEAD')).Output)".Trim())
if (-not $target) { throw "无法解析目标引用: $TargetRef" }

$codeChanged = $old -ne $target
# 本地固定使用 runtime 分支指向目标引用，幂等且不影响其它检出
Invoke-Git @('checkout', '-B', 'runtime', $target) | Out-Null
Invoke-Git @('branch', '--set-upstream-to=origin/master', 'runtime') -AllowFail | Out-Null
if ($codeChanged) {
    Write-Output ("==> 代码已更新: {0} -> {1}" -f $old.Substring(0, 7), $target.Substring(0, 7))
} else {
    Write-Output ("==> 代码已是最新: {0}" -f $target.Substring(0, 7))
}

# ---------- 3. 依赖与构建 ----------
$changedFiles = @()
if ($codeChanged) {
    $changedFiles = @((Invoke-Git @('diff', '--name-only', $old, $target)).Output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}
$nodeModulesMissing = -not (Test-Path -LiteralPath (Join-Path $script:Worktree 'node_modules') -PathType Container)
$manifestChanged = $changedFiles | Where-Object { $_ -match '(^|/)package(-lock)?\.json$' }
$mcpEntry = Join-Path $script:Worktree 'packages/mcp-server/dist/run.js'
$probeEntry = Join-Path $script:Worktree 'packages/probe-server/dist/run.js'
$distMissing = -not (Test-Path -LiteralPath $mcpEntry -PathType Leaf) -or -not (Test-Path -LiteralPath $probeEntry -PathType Leaf)

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

$bridgeChanged = $changedFiles | Where-Object { $_ -like 'packages/bridge-extension/*' }

# ---------- 4. 重启 Probe Server ----------
if (-not $SkipProbeRestart) {
    Write-Output "==> 重启 Probe Server（端口 $Port）"
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $procId = $listener.OwningProcess
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId").CommandLine
        if ($cmd -match 'probe-server') {
            Stop-Process -Id $procId -Force
            Start-Sleep -Milliseconds 500
            Write-Output "    已停止旧进程 PID $procId"
        } else {
            throw "端口 $Port 被非 Probe Server 进程占用（PID ${procId}: $cmd），已中止"
        }
    }

    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = 'D:/nodejs/node.exe' }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "找不到 node.exe: $node" }
    if (-not (Test-Path -LiteralPath $probeEntry -PathType Leaf)) { throw "Probe Server 构建产物不存在: $probeEntry" }

    $reportRoot = Join-Path $script:Worktree 'reports'
    New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
    # 环境变量会被子进程继承
    $env:COCOS_AI_PROBE_HOST = '127.0.0.1'
    $env:COCOS_AI_PROBE_PORT = [string]$Port
    $env:COCOS_AI_PROBE_REPORT_ROOT = $reportRoot
    $outLog = Join-Path $reportRoot 'probe-server.out.log'
    $errLog = Join-Path $reportRoot 'probe-server.err.log'
    $proc = Start-Process -FilePath $node -ArgumentList "`"$probeEntry`"" -WorkingDirectory $script:Worktree `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) {
            $errTail = if (Test-Path $errLog) { Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue } else { '' }
            throw "Probe Server 启动后立即退出（PID $($proc.Id)）：`n$errTail"
        }
        try {
            $tcp = [Net.Sockets.TcpClient]::new()
            $tcp.Connect('127.0.0.1', $Port)
            $tcp.Close()
            $ready = $true
            break
        } catch { }
    }
    if (-not $ready) { throw "Probe Server 启动后 20 秒内未监听端口 $Port" }
    Write-Output "    Probe Server 已就绪: ws://127.0.0.1:$Port (PID $($proc.Id))"
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
