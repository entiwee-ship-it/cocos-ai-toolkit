param(
    [int]$Port = 32188,
    [string]$ReportRoot = 'reports'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
npm --prefix $repo run build
if ($LASTEXITCODE -ne 0) {
    throw 'Probe Server 构建失败'
}
$env:COCOS_AI_PROBE_HOST = '127.0.0.1'
$env:COCOS_AI_PROBE_PORT = [string]$Port
$env:COCOS_AI_PROBE_REPORT_ROOT = [IO.Path]::GetFullPath((Join-Path $repo $ReportRoot))
New-Item -ItemType Directory -Force -Path $env:COCOS_AI_PROBE_REPORT_ROOT | Out-Null
Write-Output "Probe Server: ws://127.0.0.1:$Port"
Write-Output "报告目录: $env:COCOS_AI_PROBE_REPORT_ROOT"
node (Join-Path $repo 'packages/probe-server/dist/run.js')
