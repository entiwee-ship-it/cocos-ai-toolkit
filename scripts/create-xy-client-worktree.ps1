param(
    [string]$SourceRepo = 'E:/xile-workspace/qyProject/xy-client',
    [string]$WorktreePath = 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',
    [string]$BranchName = 'codex/cocos-ai-probe'
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath('E:/xile-workspace/worktrees')
$source = (Resolve-Path -LiteralPath $SourceRepo).Path
$target = [IO.Path]::GetFullPath($WorktreePath)

if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) {
    throw "源目录不是 Git 仓库: $source"
}
if (-not $target.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Worktree 必须位于 $workspaceRoot"
}
if (Test-Path -LiteralPath $target) {
    throw "目标 Worktree 已存在，拒绝覆盖: $target"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
git -C $source worktree add -b $BranchName $target HEAD
if ($LASTEXITCODE -ne 0) {
    throw "创建 Git Worktree 失败"
}

$commit = git -C $source rev-parse HEAD
Write-Output "源 Commit: $commit"
git -C $target status --short --branch
