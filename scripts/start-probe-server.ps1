param(
    [int]$Port = 32188,
    [string]$ReportRoot = 'reports',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $SkipBuild) {
    npm --prefix $repo run build
    if ($LASTEXITCODE -ne 0) {
        throw 'Probe Server 构建失败'
    }
}
$serverEntry = Join-Path $repo 'packages/probe-server/dist/run.js'
if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
    throw "Probe Server 构建产物不存在: $serverEntry"
}
$resolvedReportRoot = if ([IO.Path]::IsPathRooted($ReportRoot)) {
    [IO.Path]::GetFullPath($ReportRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $repo $ReportRoot))
}
$env:COCOS_AI_PROBE_HOST = '127.0.0.1'
$env:COCOS_AI_PROBE_PORT = [string]$Port
$env:COCOS_AI_PROBE_REPORT_ROOT = $resolvedReportRoot
New-Item -ItemType Directory -Force -Path $env:COCOS_AI_PROBE_REPORT_ROOT | Out-Null
Write-Output "Probe Server: ws://127.0.0.1:$Port"
Write-Output "报告目录: $env:COCOS_AI_PROBE_REPORT_ROOT"
# run.js 只会在实际监听成功后向 stdout 输出 probe-server.ready JSON；自动化调用方必须等待该事件。
node $serverEntry
if ($LASTEXITCODE -ne 0) {
    throw "Probe Server 异常退出，退出码 $LASTEXITCODE"
}
