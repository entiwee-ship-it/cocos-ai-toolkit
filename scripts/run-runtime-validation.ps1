[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [string]$ReportRoot = 'reports',
    [switch]$SkipStatic
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot 'run-runtime-validation.mjs'
$arguments = @($runner, '--project-path', [IO.Path]::GetFullPath($ProjectPath), '--report-root', $ReportRoot)
if ($SkipStatic) { $arguments += '--skip-static' }

& $node @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Cocos AI 运行态验证失败（退出码 $LASTEXITCODE）"
}
