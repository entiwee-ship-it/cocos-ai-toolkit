[CmdletBinding()]
param(
    [string]$TaskName = 'Cocos AI Probe Server',
    [string]$RuntimeWorktree = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
    [int]$Port = 32188,
    [string]$ReportRoot = '',
    [string]$NodePath = '',
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$runtime = (Resolve-Path -LiteralPath $RuntimeWorktree).Path
$startScript = Join-Path $runtime 'scripts/start-probe-server.ps1'
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "Probe 启动脚本不存在: $startScript"
}
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'packages/probe-server/dist/run.js') -PathType Leaf)) {
    throw "Probe 构建产物不存在，请先同步并构建运行时 Worktree: $runtime"
}
$reportRootPath = if ($ReportRoot) {
    [IO.Path]::GetFullPath($ReportRoot)
} else {
    Join-Path $runtime 'reports'
}
$node = if ($NodePath) {
    [IO.Path]::GetFullPath($NodePath)
} else {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $command.Source } else { 'D:/nodejs/node.exe' }
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw "找不到 node.exe: $node"
}

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$actionArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy Bypass',
    '-WindowStyle Hidden',
    "-File `"$startScript`"",
    "-Port $Port",
    "-ReportRoot `"$reportRootPath`"",
    "-NodePath `"$node`"",
    '-SkipBuild'
) -join ' '
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $actionArguments -WorkingDirectory $runtime
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description '当前用户登录后启动 Cocos AI Probe Server；失败自动重试。' `
    -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
}
[pscustomobject]@{
    TaskName = $registered.TaskName
    User = $user
    State = [string]$registered.State
    Execute = $registered.Actions[0].Execute
    Arguments = $registered.Actions[0].Arguments
    RuntimeWorktree = $runtime
} | ConvertTo-Json -Compress
