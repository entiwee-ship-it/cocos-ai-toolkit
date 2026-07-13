param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,
    [string]$ToolkitPath = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0'
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$bridgePath = (Resolve-Path -LiteralPath (Join-Path $ToolkitPath 'packages/bridge-extension')).Path
$extensionPath = Join-Path $project 'extensions/cocos-ai-bridge'

if (-not (Test-Path -LiteralPath $extensionPath)) {
    Write-Output 'Bridge Junction 不存在，无需移除。'
    exit 0
}
$item = Get-Item -LiteralPath $extensionPath -Force
$target = if ($item.Target) { [IO.Path]::GetFullPath([string]$item.Target) } else { '' }
if ($item.LinkType -ne 'Junction' -or $target.TrimEnd('\') -ine $bridgePath.TrimEnd('\')) {
    throw "目标不是指向本工具 Bridge 的 Junction，拒绝删除: $extensionPath"
}
Remove-Item -LiteralPath $extensionPath -Force
Write-Output "已移除 Bridge Junction: $extensionPath"
