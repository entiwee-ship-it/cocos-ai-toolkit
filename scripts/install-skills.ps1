<#
.SYNOPSIS
    把仓库自带的 cocos-ai-toolkit 使用技能安装到 AI 客户端的技能目录。

.DESCRIPTION
    技能源固定在仓库 skills/cocos-ai-toolkit。默认用 Junction 挂接（活链接，
    仓库更新后技能即更新，无需重装）；离线/打包场景可用 -Copy 改为复制。

    支持的目标：
    - kimi    ：$HOME/.kimi-code/skills（Kimi Code，用户级）
    - codex   ：$HOME/.codex/skills（Codex，用户级）
    - claude  ：$HOME/.claude/skills（Claude Code，用户级）
    - project ：当前工作目录/.agents/skills（项目级，仅对该工作区生效）
    - custom  ：用 -CustomPath 指定完整技能目录

.EXAMPLE
    # 安装到 Kimi Code 用户级技能目录（Junction）
    & scripts/install-skills.ps1 -Target kimi

.EXAMPLE
    # 安装到项目级 .agents/skills，覆盖已存在的旧安装
    & scripts/install-skills.ps1 -Target project -Force
#>
param(
    [ValidateSet('kimi', 'codex', 'claude', 'project', 'custom')]
    [string]$Target = 'kimi',
    # Target=custom 时的完整技能目录（如 D:/tools/skills）
    [string]$CustomPath = '',
    # 用复制代替 Junction（复制后仓库更新不会同步，需要重新安装）
    [switch]$Copy,
    # 目标已存在且不是本仓库挂接时，允许删除后重装
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $repo 'skills/cocos-ai-toolkit'
if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md') -PathType Leaf)) {
    throw "技能源不存在: $source（缺少 SKILL.md）"
}

$skillsRoot = switch ($Target) {
    'kimi' { Join-Path $HOME '.kimi-code/skills' }
    'codex' { Join-Path $HOME '.codex/skills' }
    'claude' { Join-Path $HOME '.claude/skills' }
    'project' { Join-Path (Get-Location).Path '.agents/skills' }
    'custom' {
        if (-not $CustomPath) { throw 'Target=custom 时必须提供 -CustomPath' }
        [IO.Path]::GetFullPath($CustomPath)
    }
}
New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null
$dest = Join-Path $skillsRoot 'cocos-ai-toolkit'

if (Test-Path -LiteralPath $dest) {
    $existing = Get-Item -LiteralPath $dest -Force
    $isJunction = $existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink'
    $targetPath = if ($existing.Target) { [IO.Path]::GetFullPath([string]$existing.Target) } else { '' }
    $expected = (Resolve-Path -LiteralPath $source).Path
    if ($isJunction -and -not $Copy -and $targetPath.TrimEnd('\') -ieq $expected.TrimEnd('\')) {
        Write-Output "技能已挂接，无需变更: $dest -> $expected"
        exit 0
    }
    if (-not $Force) {
        throw "目标已存在且不是本仓库挂接: $dest（如需覆盖请加 -Force）"
    }
    Remove-Item -LiteralPath $dest -Recurse -Force
    Write-Output "已移除现有安装: $dest"
}

if ($Copy) {
    Copy-Item -LiteralPath $source -Destination $dest -Recurse
    Write-Output "已复制技能: $source -> $dest"
    Write-Output '注意：复制模式下仓库更新不会同步，更新后请重新执行本脚本。'
} else {
    New-Item -ItemType Junction -Path $dest -Target $source | Out-Null
    Write-Output "已挂接技能: $dest -> $source"
}
Write-Output '技能列表在 AI 会话启动时加载，请重启会话后使用。'
