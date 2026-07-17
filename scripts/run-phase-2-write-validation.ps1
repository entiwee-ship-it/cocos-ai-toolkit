[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ProjectPath,

    [string]$ReportRoot = 'reports',

    [ValidateRange(1024, 65535)]
    [int]$Port = 32188,

    [ValidateRange(10, 600)]
    [int]$ReadyTimeoutSeconds = 120,

    [ValidateRange(10, 600)]
    [int]$RequestTimeoutSeconds = 120,

    [ValidateRange(60, 7200)]
    [int]$ScanTimeoutSeconds = 1800,

    [ValidateRange(25, 5000)]
    [int]$PollIntervalMilliseconds = 100,

    [ValidateRange(1, 500)]
    [int]$SnapshotPageSize = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 阶段二统一验证脚本必须运行在 pwsh 7+（Windows PowerShell 5.1 的参数绑定行为不兼容）。
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "统一写入验证脚本必须在 pwsh 7+ 运行，当前宿主版本为 $($PSVersionTable.PSVersion)"
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$reportsRoot = if ([IO.Path]::IsPathRooted($ReportRoot)) {
    [IO.Path]::GetFullPath($ReportRoot)
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $ReportRoot))
}
$cliPath = Join-Path $repoRoot 'packages/cli/dist/index.js'
$probeServerEntryPath = Join-Path $repoRoot 'packages/probe-server/dist/run.js'
$probeServerScriptPath = Join-Path $repoRoot 'scripts/start-probe-server.ps1'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$npmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
$gitExe = (Get-Command git -ErrorAction Stop).Source
$pwshExe = (Get-Command pwsh -ErrorAction Stop).Source
$runId = '{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$reportPrefix = "phase-2-$runId"
$probeName = "CocosAiWrite_$($runId.Replace('-', '_'))"
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$selectorArguments = $null
$selectedEditor = $null
$gitStatusBefore = $null
$gitStatusAfter = $null
$serverWasRunningAtStart = $false
$script:activeServerControl = $null
$failure = $null
$runStatus = 'running'
$mainCompletedSuccessfully = $false
$steps = [Collections.Generic.List[object]]::new()

$env:COCOS_AI_PROBE_SERVER_URL = "ws://127.0.0.1:$Port"
$env:COCOS_AI_PROBE_TIMEOUT_MS = [string]($RequestTimeoutSeconds * 1000)
New-Item -ItemType Directory -Force -Path $reportsRoot | Out-Null

function Assert-Condition {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Test-ObjectProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($Value -is [Collections.IDictionary]) {
        return $Value.Contains($Name)
    }
    return $null -ne $Value.PSObject.Properties[$Name]
}

function Write-ReportFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    if ([IO.Path]::GetFileName($Name) -ne $Name -or -not $Name.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) {
        throw "报告文件名非法: $Name"
    }
    $path = Join-Path $reportsRoot $Name
    $text = $Content.TrimEnd("`r", "`n") + [Environment]::NewLine
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Dispose()
    }
    return $path
}

function Write-JsonReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value
    )

    return Write-ReportFile -Name $Name -Content ($Value | ConvertTo-Json -Depth 100)
}

function Write-RawJsonReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$RawJson
    )

    $null = $RawJson | ConvertFrom-Json -AsHashtable
    return Write-ReportFile -Name $Name -Content $RawJson
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ($Path.EndsWith('.gz', [StringComparison]::OrdinalIgnoreCase)) {
        $fileStream = [IO.File]::OpenRead($Path)
        try {
            $gzipStream = [IO.Compression.GZipStream]::new(
                $fileStream,
                [IO.Compression.CompressionMode]::Decompress
            )
            try {
                $reader = [IO.StreamReader]::new($gzipStream, [Text.Encoding]::UTF8)
                try {
                    $raw = $reader.ReadToEnd()
                } finally {
                    $reader.Dispose()
                }
            } finally {
                $gzipStream.Dispose()
            }
        } finally {
            $fileStream.Dispose()
        }
    } else {
        $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    }
    return [PSCustomObject]@{
        raw = $raw
        data = $raw | ConvertFrom-Json -AsHashtable
    }
}

function Resolve-ManifestArtifactPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReportPath,
        [Parameter(Mandatory = $true)]
        [object]$Artifact,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    foreach ($name in @('path', 'sha256', 'bytes', 'encoding')) {
        Assert-Condition -Condition (Test-ObjectProperty -Value $Artifact -Name $name) -Message "$Label 引用缺少字段: $name"
    }
    $relativePath = [string]$Artifact.path
    Assert-Condition -Condition (-not [IO.Path]::IsPathRooted($relativePath)) -Message "$Label 引用不能使用绝对路径"
    Assert-Condition -Condition (-not ($relativePath -split '[\\/]' -contains '..')) -Message "$Label 引用不能越过报告目录"
    Assert-Condition -Condition (([string]$Artifact.sha256) -match '^[a-fA-F0-9]{64}$') -Message "$Label SHA-256 格式无效"
    Assert-Condition -Condition ([long]$Artifact.bytes -ge 0) -Message "$Label 字节数无效"

    $reportDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath))
    $artifactPath = [IO.Path]::GetFullPath((Join-Path $reportDirectory $relativePath))
    $pathFromReportDirectory = [IO.Path]::GetRelativePath($reportDirectory, $artifactPath)
    Assert-Condition -Condition (-not ($pathFromReportDirectory -eq '..' -or $pathFromReportDirectory.StartsWith("..$([IO.Path]::DirectorySeparatorChar)"))) -Message "$Label 引用越过报告目录"
    Assert-Condition -Condition (Test-Path -LiteralPath $artifactPath -PathType Leaf) -Message "$Label 文件不存在: $relativePath"

    $encoding = [string]$Artifact.encoding
    if ($encoding -eq 'json') {
        Assert-Condition -Condition ($artifactPath.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase) -and -not $artifactPath.EndsWith('.json.gz', [StringComparison]::OrdinalIgnoreCase)) -Message "$Label JSON 编码与扩展名不一致"
    } elseif ($encoding -eq 'json-gzip') {
        Assert-Condition -Condition ($artifactPath.EndsWith('.json.gz', [StringComparison]::OrdinalIgnoreCase)) -Message "$Label gzip 编码与扩展名不一致"
    } else {
        throw "$Label 编码无效: $encoding"
    }

    $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Condition -Condition ($actualHash -eq ([string]$Artifact.sha256).ToLowerInvariant()) -Message "$Label SHA-256 不一致"
    $actualBytes = (Get-Item -LiteralPath $artifactPath).Length
    Assert-Condition -Condition ($actualBytes -eq [long]$Artifact.bytes) -Message "$Label 字节数不一致"
    return $artifactPath
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [int]$TimeoutSeconds = 600,
        [switch]$AllowFailure
    )

    Write-Host "==> $Label"
    $start = [Diagnostics.Stopwatch]::StartNew()
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $repoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "$Label 启动失败"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try {
            $process.Kill($true)
        } catch {
            throw "$Label 超时且无法终止进程 $($process.Id): $($_.Exception.Message)"
        }
        if (-not $process.WaitForExit(10000)) {
            throw "$Label 超时后无法在 10 秒内终止进程 $($process.Id)"
        }
        throw "$Label 超过 $TimeoutSeconds 秒仍未完成"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $start.Stop()

    $result = [PSCustomObject]@{
        label = $Label
        exitCode = $process.ExitCode
        durationMs = $start.ElapsedMilliseconds
        stdout = $stdout.Trim()
        stderr = $stderr.Trim()
    }
    if ($process.ExitCode -ne 0 -and -not $AllowFailure) {
        throw "$Label 失败，退出码 $($process.ExitCode)。stdout: $($result.stdout) stderr: $($result.stderr)"
    }
    return $result
}

function Invoke-CliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [int]$TimeoutSeconds = 600
    )

    $result = Invoke-NativeCommand -FilePath $nodeExe -Arguments (@($cliPath) + $Arguments) -Label $Label -TimeoutSeconds $TimeoutSeconds
    if ([string]::IsNullOrWhiteSpace($result.stdout)) {
        throw "$Label 未返回 JSON"
    }
    try {
        $data = $result.stdout | ConvertFrom-Json -AsHashtable
    } catch {
        throw "$Label 返回的内容不是有效 JSON: $($result.stdout)"
    }
    return [PSCustomObject]@{
        raw = $result.stdout
        data = $data
        command = $result
    }
}

function Start-NativeCommandProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $repoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "$Label 启动失败"
    }
    return [PSCustomObject]@{
        label = $Label
        process = $process
        stdoutTask = $process.StandardOutput.ReadToEndAsync()
        stderrTask = $process.StandardError.ReadToEndAsync()
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Complete-NativeCommandProcess {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Control,
        [switch]$Terminate,
        [int]$TimeoutSeconds = 30
    )

    $process = $Control.process
    if ($Terminate -and -not $process.HasExited) {
        try {
            $process.Kill($true)
        } catch {
            throw "$($Control.label) 无法终止进程 $($process.Id): $($_.Exception.Message)"
        }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            throw "$($Control.label) 无法在 $TimeoutSeconds 秒内终止进程 $($process.Id)"
        }
    } elseif (-not $process.HasExited -and -not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try {
            $process.Kill($true)
        } catch {
            throw "$($Control.label) 超时且无法终止进程 $($process.Id): $($_.Exception.Message)"
        }
        if (-not $process.WaitForExit(10000)) {
            throw "$($Control.label) 超时后无法在 10 秒内终止进程 $($process.Id)"
        }
    }
    return [PSCustomObject]@{
        label = $Control.label
        exitCode = $process.ExitCode
        stdout = $Control.stdoutTask.GetAwaiter().GetResult().Trim()
        stderr = $Control.stderrTask.GetAwaiter().GetResult().Trim()
        startedAt = $Control.startedAt
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
        terminatedByValidation = [bool]$Terminate
    }
}

function Add-PassedStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [long]$DurationMs,
        [Parameter(Mandatory = $true)]
        [string]$Evidence,
        [int]$ExitCode = 0
    )

    $steps.Add([PSCustomObject]@{
        name = $Name
        status = 'passed'
        exitCode = $ExitCode
        durationMs = $DurationMs
        evidence = $Evidence
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
    })
}

function Get-GitStatusSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryPath,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    return (Invoke-NativeCommand -FilePath $gitExe -Arguments @(
        '-C', $RepositoryPath, 'status', '--porcelain=v2', '--branch'
    ) -Label $Label).stdout
}

function Assert-UnchangedStatus {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Before,
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$After,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ($Before -cne $After) {
        throw "$Label 的 git status 在验证前后发生变化。before: $Before after: $After"
    }
}

function Get-ProbeServerListener {
    param([switch]$AllowMissing)

    $connections = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $processIds = @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    if ($processIds.Count -eq 0) {
        if ($AllowMissing) { return $null }
        throw "127.0.0.1:$Port 当前没有 Probe Server 监听"
    }
    Assert-Condition -Condition ($processIds.Count -eq 1) -Message "127.0.0.1:$Port 存在多个监听进程"
    $processId = $processIds[0]
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    Assert-Condition -Condition ($null -ne $processInfo) -Message "无法读取监听进程 $processId"
    $normalizedCommandLine = ([string]$processInfo.CommandLine).Replace('\', '/')
    $normalizedEntryPath = $probeServerEntryPath.Replace('\', '/')
    Assert-Condition -Condition ($normalizedCommandLine.Contains($normalizedEntryPath, [StringComparison]::OrdinalIgnoreCase)) -Message "端口 $Port 被非目标 Probe Server 进程占用: $normalizedCommandLine"
    return [PSCustomObject]@{
        processId = $processId
        parentProcessId = [int]$processInfo.ParentProcessId
        commandLine = [string]$processInfo.CommandLine
        executablePath = [string]$processInfo.ExecutablePath
        url = "ws://127.0.0.1:$Port"
    }
}

function Wait-ProbeServerReady {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$WrapperProcess,
        [Parameter(Mandatory = $true)]
        [string]$StdoutPath,
        [Parameter(Mandatory = $true)]
        [string]$StderrPath
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $lastListenerError = '尚未收到 probe-server.ready'
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($WrapperProcess.HasExited) {
            $stderr = if (Test-Path -LiteralPath $StderrPath) { [IO.File]::ReadAllText($StderrPath) } else { '' }
            throw "Probe Server 在 Ready 前退出，退出码 $($WrapperProcess.ExitCode): $stderr"
        }
        if (Test-Path -LiteralPath $StdoutPath) {
            $readyLine = Get-Content -LiteralPath $StdoutPath -ErrorAction SilentlyContinue |
                Where-Object { $_ -like '*"type":"probe-server.ready"*' } |
                Select-Object -Last 1
            if ($readyLine) {
                try {
                    $ready = $readyLine | ConvertFrom-Json
                    Assert-Condition -Condition ($ready.type -eq 'probe-server.ready') -Message 'Probe Server Ready 事件类型错误'
                    Assert-Condition -Condition ($ready.url -eq "ws://127.0.0.1:$Port") -Message "Probe Server Ready URL 不匹配: $($ready.url)"
                    $listener = Get-ProbeServerListener
                    Assert-Condition -Condition ($listener.parentProcessId -eq $WrapperProcess.Id) -Message 'Probe Server Node 进程不属于本次启动的 PowerShell Wrapper'
                    return [PSCustomObject]@{
                        event = $ready
                        listener = $listener
                    }
                } catch {
                    $lastListenerError = $_.Exception.Message
                }
            }
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "等待 Probe Server Ready 超时: $StdoutPath，最后错误: $lastListenerError"
}

function ConvertTo-StartProcessArgument {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    Assert-Condition -Condition (-not $Value.Contains('"', [StringComparison]::Ordinal)) -Message "进程参数包含非法双引号: $Value"
    $trailingBackslashCount = 0
    for ($index = $Value.Length - 1; $index -ge 0 -and $Value[$index] -eq '\'; $index -= 1) {
        $trailingBackslashCount += 1
    }
    $escapedTrailingBackslashes = if ($trailingBackslashCount -gt 0) {
        ('\' * $trailingBackslashCount) -join ''
    } else {
        ''
    }
    return '"' + $Value + $escapedTrailingBackslashes + '"'
}

function Start-ProbeServerProcess {
    param([int]$Generation)

    $stdoutPath = Join-Path $reportsRoot "$reportPrefix-probe-server-$Generation.stdout.log"
    $stderrPath = Join-Path $reportsRoot "$reportPrefix-probe-server-$Generation.stderr.log"
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $stdoutPath)) -Message "Probe Server stdout 已存在: $stdoutPath"
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $stderrPath)) -Message "Probe Server stderr 已存在: $stderrPath"
    $argumentList = @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', (ConvertTo-StartProcessArgument -Value $probeServerScriptPath),
        '-Port', [string]$Port,
        '-ReportRoot', (ConvertTo-StartProcessArgument -Value $reportsRoot),
        '-SkipBuild'
    )
    $wrapper = Start-Process -FilePath $pwshExe -ArgumentList $argumentList -WorkingDirectory $repoRoot `
        -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    try {
        $ready = Wait-ProbeServerReady -WrapperProcess $wrapper -StdoutPath $stdoutPath -StderrPath $stderrPath
    } catch {
        $readyFailure = $_.Exception.Message
        $cleanupFailures = [Collections.Generic.List[string]]::new()
        try {
            if (-not $wrapper.HasExited) {
                $wrapper.Kill($true)
                if (-not $wrapper.WaitForExit(10000)) {
                    throw "Wrapper 进程 $($wrapper.Id) 无法在 10 秒内终止"
                }
            }
        } catch {
            $cleanupFailures.Add($_.Exception.Message)
        }
        try {
            $failedStartListener = Get-ProbeServerListener -AllowMissing
            if ($null -ne $failedStartListener) {
                $failedStartControl = [PSCustomObject]@{
                    wrapperProcess = $wrapper
                    listener = $failedStartListener
                }
                $null = Stop-ProbeServerProcess -Control $failedStartControl
            }
        } catch {
            $cleanupFailures.Add($_.Exception.Message)
        }
        if ($cleanupFailures.Count -gt 0) {
            throw "Probe Server Ready 失败: $readyFailure；启动清理失败: $($cleanupFailures -join '；')"
        }
        throw "Probe Server Ready 失败: $readyFailure"
    }
    return [PSCustomObject]@{
        generation = $Generation
        wrapperProcess = $wrapper
        listener = $ready.listener
        readyEvent = $ready.event
        stdoutPath = $stdoutPath
        stderrPath = $stderrPath
        startedByValidation = $true
    }
}

function Stop-ProbeServerProcess {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Control
    )

    $current = Get-ProbeServerListener
    Assert-Condition -Condition ($current.processId -eq $Control.listener.processId) -Message 'Probe Server 监听 PID 已变化，拒绝终止未知进程'
    if ($null -ne $Control.wrapperProcess) {
        Assert-Condition -Condition ($current.parentProcessId -eq $Control.wrapperProcess.Id) -Message 'Probe Server 父进程已变化，拒绝终止未知进程树'
    }
    Stop-Process -Id $current.processId -Force -ErrorAction Stop
    try { Wait-Process -Id $current.processId -Timeout 10 -ErrorAction SilentlyContinue } catch { }
    if ($null -ne $Control.wrapperProcess) {
        if (-not $Control.wrapperProcess.HasExited) {
            try { Stop-Process -Id $Control.wrapperProcess.Id -Force -ErrorAction Stop } catch { }
        }
        try { Wait-Process -Id $Control.wrapperProcess.Id -Timeout 10 -ErrorAction SilentlyContinue } catch { }
        if (-not $Control.wrapperProcess.WaitForExit(10000)) {
            throw "Probe Server Wrapper 进程 $($Control.wrapperProcess.Id) 无法在 10 秒内终止"
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -eq (Get-ProbeServerListener -AllowMissing)) {
            return [PSCustomObject]@{
                stoppedProcessId = $current.processId
                stoppedAt = (Get-Date).ToUniversalTime().ToString('o')
            }
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "Probe Server 进程 $($current.processId) 停止后端口仍未释放"
}

function Get-ServerEvidence {
    param([Parameter(Mandatory = $true)][object]$Control)

    return [ordered]@{
        generation = $Control.generation
        wrapperProcessId = if ($null -ne $Control.wrapperProcess) { $Control.wrapperProcess.Id } else { $null }
        nodeProcessId = $Control.listener.processId
        url = $Control.listener.url
        readyEvent = $Control.readyEvent
        stdoutPath = $Control.stdoutPath
        stderrPath = $Control.stderrPath
        startedByValidation = $Control.startedByValidation
    }
}

function Find-EditorByProjectPath {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Editors,
        [string]$ExpectedProjectId,
        [string]$ExpectedEditorInstanceId
    )

    $matches = @($Editors | Where-Object {
        (Test-ObjectProperty -Value $_ -Name 'projectPath') -and
        [IO.Path]::GetFullPath([string]$_.projectPath).Equals($project, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]::IsNullOrWhiteSpace($ExpectedProjectId) -or $_.projectId -eq $ExpectedProjectId) -and
        ([string]::IsNullOrWhiteSpace($ExpectedEditorInstanceId) -or $_.editorInstanceId -eq $ExpectedEditorInstanceId)
    })
    Assert-Condition -Condition ($matches.Count -eq 1) -Message "未找到唯一的目标 Creator 实例: $project"
    return $matches[0]
}

function Wait-EditorReconnect {
    param(
        [string]$ExpectedProjectId,
        [string]$ExpectedEditorInstanceId
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $attempts = 0
    $lastError = '尚未请求 editors'
    while ([DateTime]::UtcNow -lt $deadline) {
        $attempts += 1
        $result = Invoke-NativeCommand -FilePath $nodeExe -Arguments @($cliPath, 'editors') -Label '等待 Creator Bridge 重连' -TimeoutSeconds 30 -AllowFailure
        if ($result.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($result.stdout)) {
            try {
                $editors = @($result.stdout | ConvertFrom-Json)
                $editor = Find-EditorByProjectPath -Editors $editors -ExpectedProjectId $ExpectedProjectId -ExpectedEditorInstanceId $ExpectedEditorInstanceId
                return [PSCustomObject]@{
                    attempts = $attempts
                    editor = $editor
                    command = $result
                }
            } catch {
                $lastError = $_.Exception.Message
            }
        } else {
            $lastError = $result.stderr
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "等待 Creator Bridge 重连超时: $lastError"
}

function Wait-EditorReady {
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $state = Invoke-CliJson -Arguments (@('state') + $selectorArguments) -Label '等待 Creator Scene 和 AssetDB Ready'
        if ($state.data.ready.scene -eq $true -and $state.data.ready.assetDatabase -eq $true) {
            return $state
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw '等待 Creator Scene 和 AssetDB Ready 超时'
}

function Find-SampleWriteDocument {
    param(
        [Parameter(Mandatory = $true)]
        [object]$AssetIndex
    )

    $documents = @($AssetIndex.documents)
    Assert-Condition -Condition ($documents.Count -gt 0) -Message '资产索引没有 Scene 或 Prefab'
    # 阶段二写入目标固定 Prefab：场景保存语义不同，隔离验证只选 prefab 类型文档。
    $prefab = $null
    foreach ($document in $documents) {
        if ([string]$document.documentType -eq 'prefab') {
            $prefab = $document
            break
        }
    }
    if ($null -eq $prefab) {
        $prefab = $documents[0]
    }
    $assetUuid = [string]($prefab.assetUuid ?? $prefab.uuid)
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($assetUuid)) -Message '样本文档缺少资产 UUID'
    return [PSCustomObject]@{
        assetUuid = $assetUuid
        path = [string]($prefab.path ?? $prefab.url ?? '')
    }
}

function Read-CurrentDocumentSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExpectedAssetUuid,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    # 文档身份解析存在瞬时 CURRENT_DOCUMENT_UUID_EMPTY（Phase 1 实测）：
    # 打开资产后按身份匹配重试，直到快照钉住目标文档。
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $attempt = 0
    while ([DateTime]::UtcNow -lt $deadline) {
        $attempt += 1
        $snapshot = Invoke-CliJson -Arguments (@('document-snapshot') + $script:selectorArguments + @('--mode', 'full', '--page-size', [string]$SnapshotPageSize)) -Label $Label
        if ([string]$snapshot.data.document.assetUuid -eq $ExpectedAssetUuid) {
            return $snapshot
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "$Label 在 $attempt 次尝试后仍未钉住目标文档 $ExpectedAssetUuid"
}

function Read-FirstPageNodes {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Snapshot
    )

    $nodes = @($Snapshot.data.nodes)
    Assert-Condition -Condition ($nodes.Count -gt 0) -Message '样本文档快照没有节点'
    return $nodes
}

function Read-NodeUuid {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Node
    )

    # 快照节点为规范化结构：UUID 在 identity.objectUuid。
    $uuid = [string]($Node.identity.objectUuid ?? $Node.uuid)
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($uuid)) -Message '快照节点缺少 UUID'
    return $uuid
}

function New-WriteRequest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionId,

        [Parameter(Mandatory = $true)]
        [object[]]$Operations,

        [bool]$Save = $true
    )

    return ([ordered]@{
        transactionId = $TransactionId
        idempotencyKey = "key-$TransactionId"
        scope = 'current-document'
        revision = [ordered]@{
            document = $null
            hierarchy = $null
            assetDatabase = $null
            scriptCompilation = $null
        }
        operations = $Operations
        save = $Save
        undoGroup = "phase-2-$TransactionId"
    } | ConvertTo-Json -Depth 12 -Compress)
}

function Invoke-WriteTransaction {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionId,

        [Parameter(Mandatory = $true)]
        [object[]]$Operations,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $requestJson = New-WriteRequest -TransactionId $TransactionId -Operations $Operations
    $prepare = Invoke-CliJson -Arguments (@('write-prepare') + $script:selectorArguments + @('--request', $requestJson)) -Label "$Label write-prepare"
    Assert-Condition -Condition ($prepare.data.status -eq 'validated') -Message "$Label prepare 状态异常: $($prepare.data.status)"
    $preparePath = Write-JsonReport -Name "$reportPrefix-$TransactionId-prepare.json" -Value ([ordered]@{
        request = ($requestJson | ConvertFrom-Json -AsHashtable)
        response = $prepare.data
    })

    $confirm = Invoke-CliJson -Arguments (@('write-confirm') + $script:selectorArguments + @('--transaction-id', $TransactionId)) -Label "$Label write-confirm"
    Assert-Condition -Condition ($confirm.data.status -eq 'committed') -Message "$Label confirm 状态异常: $($confirm.data.status)"
    Assert-Condition -Condition ($confirm.data.verification.passed -eq $true) -Message "$Label 重读验证未通过"
    $confirmPath = Write-JsonReport -Name "$reportPrefix-$TransactionId-confirm.json" -Value $confirm.data
    Add-PassedStep -Name $Label -DurationMs ($prepare.command.durationMs + $confirm.command.durationMs) -Evidence $confirmPath
    return [PSCustomObject]@{
        prepare = $prepare.data
        confirm = $confirm.data
        preparePath = $preparePath
        confirmPath = $confirmPath
    }
}

function Invoke-TransactionRollback {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionId,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $rollback = Invoke-CliJson -Arguments (@('transaction-rollback') + $script:selectorArguments + @('--transaction-id', $TransactionId)) -Label "$Label transaction-rollback"
    Assert-Condition -Condition ($rollback.data.status -eq 'rolled-back') -Message "$Label 回滚状态异常: $($rollback.data.status)"
    Assert-Condition -Condition ($rollback.data.rollbackEvidence.verifiedClean -eq $true) -Message "$Label 回滚后重读未验证干净"
    $rollbackPath = Write-JsonReport -Name "$reportPrefix-$TransactionId-rollback.json" -Value $rollback.data
    Add-PassedStep -Name $Label -DurationMs $rollback.command.durationMs -Evidence $rollbackPath
    return $rollback.data
}

function Invoke-WriteInterruptRecovery {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootNodeUuid,

        [Parameter(Mandatory = $true)]
        [string]$RootOriginalName
    )

    $interruptTxId = "tx-int-$runId"
    $operations = @(
        [ordered]@{ type = 'node.rename'; nodeUuid = $RootNodeUuid; name = "${RootOriginalName}_Interrupt" }
    )
    $requestJson = New-WriteRequest -TransactionId $interruptTxId -Operations $operations
    $prepare = Invoke-CliJson -Arguments (@('write-prepare') + $script:selectorArguments + @('--request', $requestJson)) -Label '中断种子 write-prepare'
    Assert-Condition -Condition ($prepare.data.status -eq 'validated') -Message '中断种子 prepare 状态异常'

    $script:activeServerControl = Stop-ProbeServerProcess -Control $script:activeServerControl
    $interruptedConfirm = Invoke-NativeCommand -FilePath $nodeExe -Arguments (@($cliPath, 'write-confirm') + $script:selectorArguments + @('--transaction-id', $interruptTxId)) -Label 'Server 中断 write-confirm' -AllowFailure
    Assert-Condition -Condition ($interruptedConfirm.exitCode -ne 0) -Message 'Server 中断后 write-confirm 未按预期失败'

    $script:activeServerControl = Start-ProbeServerProcess -Generation 2
    $reconnect = Wait-EditorReconnect
    $status = Invoke-CliJson -Arguments (@('transaction-status') + $script:selectorArguments + @('--transaction-id', $interruptTxId)) -Label '重连后 transaction-status'
    Assert-Condition -Condition (@('validated', 'outcome-unknown') -contains $status.data.status) -Message "重连后事务状态异常: $($status.data.status)"

    $finalStatus = $null
    if ($status.data.status -eq 'validated') {
        # confirm 未到达 Bridge：重连后补执行并回滚，验证链路完整。
        $confirm = Invoke-CliJson -Arguments (@('write-confirm') + $script:selectorArguments + @('--transaction-id', $interruptTxId)) -Label '重连后补 write-confirm'
        Assert-Condition -Condition ($confirm.data.status -eq 'committed') -Message '重连后补执行未提交'
        $finalStatus = $confirm.data.status
    } else {
        # confirm 已到达 Bridge 但结果未知：按恢复纪律禁止续写，直接回滚。
        $finalStatus = 'outcome-unknown'
    }
    $rollback = Invoke-CliJson -Arguments (@('transaction-rollback') + $script:selectorArguments + @('--transaction-id', $interruptTxId)) -Label '中断事务回滚'
    Assert-Condition -Condition ($rollback.data.status -eq 'rolled-back') -Message '中断事务回滚状态异常'

    $recoveryPath = Write-JsonReport -Name "$reportPrefix-write-interrupt-recovery.json" -Value ([ordered]@{
        schemaVersion = 1
        beforeInterruptionRequest = ($requestJson | ConvertFrom-Json -AsHashtable)
        cliInterruptionError = [ordered]@{
            exitCode = $interruptedConfirm.exitCode
            stderr = $interruptedConfirm.stderr
        }
        editorReconnect = $reconnect
        statusAfterReconnect = $status.data.status
        finalStatus = $finalStatus
        rollback = $rollback.data
    })
    Add-PassedStep -Name 'Server 中断恢复证据' -DurationMs 0 -Evidence $recoveryPath
    return $recoveryPath
}

try {
    Assert-Condition -Condition (Test-Path -LiteralPath $project -PathType Container) -Message "项目目录不存在: $project"
    foreach ($repository in @($repoRoot, $project)) {
        $inside = Invoke-NativeCommand -FilePath $gitExe -Arguments @('-C', $repository, 'rev-parse', '--is-inside-work-tree') -Label "确认 Git 仓库 $repository"
        Assert-Condition -Condition ($inside.stdout -eq 'true') -Message "不是 Git 仓库: $repository"
    }
    $gitStatusBefore = [ordered]@{
        toolkit = Get-GitStatusSnapshot -RepositoryPath $repoRoot -Label '记录工具仓库验证前状态'
        project = Get-GitStatusSnapshot -RepositoryPath $project -Label '记录 Creator 项目验证前状态'
    }
    $gitBeforePath = Write-JsonReport -Name "$reportPrefix-git-status-before.json" -Value $gitStatusBefore

    $npmTest = Invoke-NativeCommand -FilePath $npmExe -Arguments @('test') -Label 'npm test' -TimeoutSeconds $ScanTimeoutSeconds
    $npmTestPath = Write-JsonReport -Name "$reportPrefix-npm-test.json" -Value $npmTest
    Add-PassedStep -Name 'npm test' -DurationMs $npmTest.durationMs -Evidence $npmTestPath -ExitCode $npmTest.exitCode

    $npmTypecheck = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'typecheck') -Label 'npm run typecheck' -TimeoutSeconds $ScanTimeoutSeconds
    $npmTypecheckPath = Write-JsonReport -Name "$reportPrefix-npm-typecheck.json" -Value $npmTypecheck
    Add-PassedStep -Name 'npm run typecheck' -DurationMs $npmTypecheck.durationMs -Evidence $npmTypecheckPath -ExitCode $npmTypecheck.exitCode

    $npmBuild = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'build') -Label 'npm run build' -TimeoutSeconds $ScanTimeoutSeconds
    $npmBuildPath = Write-JsonReport -Name "$reportPrefix-npm-build.json" -Value $npmBuild
    Add-PassedStep -Name 'npm run build' -DurationMs $npmBuild.durationMs -Evidence $npmBuildPath -ExitCode $npmBuild.exitCode
    foreach ($path in @($cliPath, $probeServerEntryPath, $probeServerScriptPath)) {
        Assert-Condition -Condition (Test-Path -LiteralPath $path -PathType Leaf) -Message "构建或脚本产物不存在: $path"
    }

    $existingListener = Get-ProbeServerListener -AllowMissing
    $serverWasRunningAtStart = $null -ne $existingListener
    if ($serverWasRunningAtStart) {
        $existingServerControl = [PSCustomObject]@{
            wrapperProcess = $null
            listener = $existingListener
        }
        $null = Stop-ProbeServerProcess -Control $existingServerControl
    }
    $script:activeServerControl = Start-ProbeServerProcess -Generation 1
    $initialReconnect = Wait-EditorReconnect

    $editors = Invoke-CliJson -Arguments @('editors') -Label 'CLI editors'
    $editorsPath = Write-RawJsonReport -Name "$reportPrefix-editors.json" -RawJson $editors.raw
    $selectedEditor = Find-EditorByProjectPath -Editors @($editors.data)
    Assert-Condition -Condition ($selectedEditor.creatorVersion -eq '3.8.8') -Message "当前只认证 Creator 3.8.8，实际为 $($selectedEditor.creatorVersion)"
    foreach ($capability in @('probe.editorState', 'probe.assetIndex', 'probe.openAsset', 'probe.documentSnapshot', 'probe.writePrepare', 'probe.writeConfirm', 'probe.transactionStatus', 'probe.transactionList', 'probe.transactionRollback')) {
        Assert-Condition -Condition ($selectedEditor.capabilities -contains $capability) -Message "Bridge 缺少写能力: $capability"
    }
    $script:selectorArguments = @('--project-id', [string]$selectedEditor.projectId, '--editor-instance-id', [string]$selectedEditor.editorInstanceId)
    Add-PassedStep -Name 'Bridge 连接与写能力检查' -DurationMs $editors.command.durationMs -Evidence $editorsPath

    $state = Invoke-CliJson -Arguments (@('state') + $script:selectorArguments) -Label 'CLI state'
    $statePath = Write-RawJsonReport -Name "$reportPrefix-state.json" -RawJson $state.raw
    Assert-Condition -Condition ([IO.Path]::GetFullPath([string]$state.data.projectPath).Equals($project, [StringComparison]::OrdinalIgnoreCase)) -Message 'Editor state 项目路径不匹配'
    Assert-Condition -Condition ($state.data.ready.scene -eq $true -and $state.data.ready.assetDatabase -eq $true) -Message 'Creator Scene 或 AssetDB 尚未 Ready'
    Add-PassedStep -Name 'Editor state' -DurationMs $state.command.durationMs -Evidence $statePath

    $assetIndex = Invoke-CliJson -Arguments (@('asset-index') + $script:selectorArguments) -Label 'CLI asset-index'
    $assetIndexPath = Write-RawJsonReport -Name "$reportPrefix-asset-index.json" -RawJson $assetIndex.raw
    $sampleDocument = Find-SampleWriteDocument -AssetIndex $assetIndex.data
    Add-PassedStep -Name 'Asset 索引与样本文档选择' -DurationMs $assetIndex.command.durationMs -Evidence $assetIndexPath

    $opened = Invoke-CliJson -Arguments (@('open-asset') + $script:selectorArguments + @('--uuid', $sampleDocument.assetUuid)) -Label 'CLI open-asset'
    $baselineSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label '只读基线快照'
    $baselinePath = Write-RawJsonReport -Name "$reportPrefix-baseline-snapshot.json" -RawJson $baselineSnapshot.raw
    $baselineNodes = Read-FirstPageNodes -Snapshot $baselineSnapshot
    # 夹具节点：快照中第一个带组件且带局部变换的节点（场景伪根没有 position dump，不能作为写入目标）
    $fixtureNode = $null
    $fixtureComponent = $null
    foreach ($node in $baselineNodes) {
        $candidateUuid = Read-NodeUuid -Node $node
        $candidateComponent = @($baselineSnapshot.data.componentSchemas) | Where-Object { [string]$_.nodeUuid -eq $candidateUuid } | Select-Object -First 1
        if ($null -ne $candidateComponent -and $null -ne $node.localTransform.position) {
            $fixtureNode = $node
            $fixtureComponent = $candidateComponent
            break
        }
    }
    Assert-Condition -Condition ($null -ne $fixtureNode) -Message '基线快照没有带组件和变换的可用节点'
    $rootNodeUuid = Read-NodeUuid -Node $fixtureNode
    $rootOriginalName = [string]$fixtureNode.name
    Add-PassedStep -Name '只读基线快照' -DurationMs $baselineSnapshot.command.durationMs -Evidence $baselinePath

    # T1：节点原子写（创建探针节点 + 重命名根节点 + 修改根节点变换）
    $t1 = Invoke-WriteTransaction -TransactionId "tx-nodes-$runId" -Label 'T1 节点原子写' -Operations @(
        [ordered]@{ type = 'node.create'; parentNodeUuid = $rootNodeUuid; name = $probeName },
        [ordered]@{ type = 'node.rename'; nodeUuid = $rootNodeUuid; name = "${rootOriginalName}_Phase2" },
        [ordered]@{ type = 'node.set_transform'; nodeUuid = $rootNodeUuid; localTransform = [ordered]@{ position = [ordered]@{ x = 11; y = 22; z = 0 } } }
    )

    # 回读层级，找到 T1 创建的探针节点 UUID
    $afterWriteSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label '写入后层级回读'
    $afterWritePath = Write-RawJsonReport -Name "$reportPrefix-after-write-snapshot.json" -RawJson $afterWriteSnapshot.raw
    $createdNodeUuid = $null
    foreach ($node in (Read-FirstPageNodes -Snapshot $afterWriteSnapshot)) {
        if ([string]$node.name -eq $probeName) {
            $createdNodeUuid = Read-NodeUuid -Node $node
            break
        }
    }
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($createdNodeUuid)) -Message '写入后层级中找不到探针节点'

    # T2：组件原子写（探针节点挂内置组件 + 夹具节点组件停用）
    $rootComponentUuid = [string]$fixtureComponent.componentUuid
    $t2 = Invoke-WriteTransaction -TransactionId "tx-components-$runId" -Label 'T2 组件原子写' -Operations @(
        [ordered]@{ type = 'component.add'; nodeUuid = $createdNodeUuid; componentType = 'cc.Sprite'; scriptUuid = $null },
        [ordered]@{ type = 'component.enable'; componentUuid = $rootComponentUuid; enabled = $false }
    )

    # T3：自定义脚本挂载守卫（优先快照中已注册的自定义组件类；空项目回退到验证夹具脚本）
    $aliveScript = @($baselineSnapshot.data.componentSchemas) | Where-Object {
        -not [string]::IsNullOrWhiteSpace([string]$_.scriptUuid) -and [string]$_.className -ne 'cc.MissingScript'
    } | Select-Object -First 1
    if ($null -ne $aliveScript) {
        $scriptUuid = [string]$aliveScript.scriptUuid
        $scriptClassName = [string]$aliveScript.className
    } else {
        $fixtureScript = @($assetIndex.data.scripts) | Where-Object { [string]$_.scriptPath -like '*Phase2Probe.ts' } | Select-Object -First 1
        Assert-Condition -Condition ($null -ne $fixtureScript) -Message '没有可用自定义脚本（快照无已注册组件类，资产索引无 Phase2Probe.ts）'
        $scriptUuid = [string]$fixtureScript.assetUuid
        $scriptClassName = 'Phase2Probe'
    }
    $t3 = Invoke-WriteTransaction -TransactionId "tx-script-$runId" -Label 'T3 自定义脚本挂载' -Operations @(
        [ordered]@{ type = 'component.add'; nodeUuid = $createdNodeUuid; componentType = $scriptClassName; scriptUuid = $scriptUuid }
    )

    # 提交后事务清单应为空（全部 committed）
    $transactionList = Invoke-CliJson -Arguments (@('transaction-list') + $script:selectorArguments) -Label 'CLI transaction-list'
    $transactionListPath = Write-RawJsonReport -Name "$reportPrefix-transaction-list.json" -RawJson $transactionList.raw
    Assert-Condition -Condition (@($transactionList.data).Count -eq 0) -Message '提交后仍存在未完成事务'
    Add-PassedStep -Name '提交后事务清单为空' -DurationMs $transactionList.command.durationMs -Evidence $transactionListPath

    # 整事务回滚：T3 → T2 → T1，每次回滚后重读验证干净
    $null = Invoke-TransactionRollback -TransactionId "tx-script-$runId" -Label 'T3 回滚'
    $null = Invoke-TransactionRollback -TransactionId "tx-components-$runId" -Label 'T2 回滚'
    $null = Invoke-TransactionRollback -TransactionId "tx-nodes-$runId" -Label 'T1 回滚'

    # 回滚后再验证干净：层级中不再存在探针节点，夹具节点名称还原
    $rolledBackSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label '回滚后层级复查'
    $rolledBackPath = Write-RawJsonReport -Name "$reportPrefix-rolled-back-snapshot.json" -RawJson $rolledBackSnapshot.raw
    $rolledBackNodes = Read-FirstPageNodes -Snapshot $rolledBackSnapshot
    foreach ($node in $rolledBackNodes) {
        Assert-Condition -Condition ([string]$node.name -ne $probeName) -Message '回滚后仍存在探针节点'
    }
    $rolledBackFixture = $null
    foreach ($node in $rolledBackNodes) {
        if ((Read-NodeUuid -Node $node) -eq $rootNodeUuid) {
            $rolledBackFixture = $node
            break
        }
    }
    Assert-Condition -Condition ($null -ne $rolledBackFixture) -Message '回滚后找不到夹具节点'
    Assert-Condition -Condition ([string]$rolledBackFixture.name -eq $rootOriginalName) -Message '回滚后夹具节点名称未还原'
    Add-PassedStep -Name '回滚后层级复查干净' -DurationMs $rolledBackSnapshot.command.durationMs -Evidence $rolledBackPath

    # Server 中断恢复证据（独立 JSON）
    $interruptRecoveryPath = Invoke-WriteInterruptRecovery -RootNodeUuid $rootNodeUuid -RootOriginalName $rootOriginalName

    $gitStatusAfter = [ordered]@{
        toolkit = Get-GitStatusSnapshot -RepositoryPath $repoRoot -Label '记录工具仓库验证后状态'
        project = Get-GitStatusSnapshot -RepositoryPath $project -Label '记录 Creator 项目验证后状态'
    }
    $gitAfterPath = Write-JsonReport -Name "$reportPrefix-git-status-after.json" -Value $gitStatusAfter
    Assert-UnchangedStatus -Before $gitStatusBefore.toolkit -After $gitStatusAfter.toolkit -Label '工具仓库'
    Assert-UnchangedStatus -Before $gitStatusBefore.project -After $gitStatusAfter.project -Label 'Creator 项目'
    Add-PassedStep -Name 'Git 状态前后逐字对比' -DurationMs 0 -Evidence $gitAfterPath

    $runStatus = 'passed'
    $mainCompletedSuccessfully = $true
} catch {
    $runStatus = 'failed'
    $failure = [ordered]@{
        message = $_.Exception.Message
        category = [string]$_.CategoryInfo.Category
        target = [string]$_.CategoryInfo.TargetName
    }
    throw
} finally {
    $cleanupFailure = $null
    try {
        if (-not $serverWasRunningAtStart -and $null -ne $script:activeServerControl) {
            $null = Stop-ProbeServerProcess -Control $script:activeServerControl
            $script:activeServerControl = $null
        } elseif ($serverWasRunningAtStart -and $null -eq (Get-ProbeServerListener -AllowMissing)) {
            $script:activeServerControl = Start-ProbeServerProcess -Generation 99
        }
    } catch {
        $cleanupFailure = $_.Exception.Message
        if ($null -eq $failure) {
            $failure = [ordered]@{ message = "Probe Server 状态恢复失败: $cleanupFailure" }
            $runStatus = 'failed'
        }
    }

    try {
        # 清理本轮报告的原子写临时文件，避免污染 Git 对比
        Get-ChildItem -LiteralPath $reportsRoot -Filter "$reportPrefix-*.tmp" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    } catch {
        $cleanupFailure = "临时文件清理失败: $($_.Exception.Message)"
    }

    if ($null -eq $gitStatusAfter -and $null -ne $gitStatusBefore) {
        try {
            $gitStatusAfter = [ordered]@{
                toolkit = Get-GitStatusSnapshot -RepositoryPath $repoRoot -Label '失败后记录工具仓库状态'
                project = Get-GitStatusSnapshot -RepositoryPath $project -Label '失败后记录 Creator 项目状态'
            }
            $null = Write-JsonReport -Name "$reportPrefix-git-status-after.json" -Value $gitStatusAfter
        } catch {
            if ($null -eq $failure) {
                $failure = [ordered]@{ message = $_.Exception.Message }
                $runStatus = 'failed'
            }
        }
    }

    $summary = [ordered]@{
        schemaVersion = 1
        runId = $runId
        reportPrefix = $reportPrefix
        status = $runStatus
        startedAt = $startedAt
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
        projectPath = $project
        projectId = if ($null -ne $selectedEditor) { $selectedEditor.projectId } else { $null }
        editorInstanceId = if ($null -ne $selectedEditor) { $selectedEditor.editorInstanceId } else { $null }
        creatorVersion = if ($null -ne $selectedEditor) { $selectedEditor.creatorVersion } else { $null }
        probeName = $probeName
        probeServerUrl = $env:COCOS_AI_PROBE_SERVER_URL
        serverWasRunningAtStart = $serverWasRunningAtStart
        gitStatusBefore = $gitStatusBefore
        gitStatusAfter = $gitStatusAfter
        cleanupFailure = $cleanupFailure
        steps = $steps
        failure = $failure
    }
    try {
        $null = Write-JsonReport -Name "$reportPrefix-summary.json" -Value $summary
    } catch {
        $summaryWriteFailure = $_.Exception.Message
        if ($null -ne $failure) {
            Write-Warning "写入 Phase 2 summary 失败，保留原始验证异常: $summaryWriteFailure"
        } else {
            throw "写入 Phase 2 summary 失败: $summaryWriteFailure"
        }
    }
    Write-Host "Phase 2 报告前缀: $reportPrefix"
    Write-Host "Phase 2 最终状态: $runStatus"
    if ($mainCompletedSuccessfully -and $runStatus -ne 'passed') {
        throw "Phase 2 主流程完成，但收尾失败: $($failure.message)"
    }
}
