param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,
    [string]$ToolkitPath = 'E:/xile-workspace/worktrees/cocos-ai-toolkit-phase-0',
    [string]$WorktreeRoot = 'E:/xile-workspace/worktrees'
)

$ErrorActionPreference = 'Stop'
$sourceProject = (Resolve-Path -LiteralPath $ProjectPath).Path
$toolkit = (Resolve-Path -LiteralPath $ToolkitPath).Path
$worktreeRoot = [IO.Path]::GetFullPath($WorktreeRoot)

if (-not $sourceProject.StartsWith($worktreeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "项目必须位于隔离 Worktree 根目录: $worktreeRoot"
}
if ((git -C $sourceProject rev-parse --is-inside-work-tree) -ne 'true') {
    throw "目标不是 Git Worktree: $sourceProject"
}

npm --prefix $toolkit run build --workspace cocos-ai-bridge
if ($LASTEXITCODE -ne 0) {
    throw 'Bridge 构建失败'
}

$extensionPath = Join-Path $sourceProject 'extensions/cocos-ai-bridge'
$bridgePath = Join-Path $toolkit 'packages/bridge-extension'
if (Test-Path -LiteralPath $extensionPath) {
    $existing = Get-Item -LiteralPath $extensionPath -Force
    $target = if ($existing.Target) { [IO.Path]::GetFullPath([string]$existing.Target) } else { '' }
    $expected = (Resolve-Path -LiteralPath $bridgePath).Path
    if ($existing.LinkType -ne 'Junction' -or $target.TrimEnd('\') -ine $expected.TrimEnd('\')) {
        throw "扩展目标已存在且不是本工具 Junction，拒绝覆盖: $extensionPath"
    }
    Write-Output "Bridge Junction 已存在: $extensionPath"
} else {
    New-Item -ItemType Junction -Path $extensionPath -Target $bridgePath | Out-Null
    Write-Output "已安装 Bridge Junction: $extensionPath -> $bridgePath"
}
Write-Output '请重启或刷新 Cocos Creator 扩展后再进行握手验证。'
