[CmdletBinding()]
param(
    [string]$TaskName = 'Cocos AI Probe Server',
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output "计划任务不存在: $TaskName"
    return
}
if ($Stop -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "已移除计划任务: $TaskName"
