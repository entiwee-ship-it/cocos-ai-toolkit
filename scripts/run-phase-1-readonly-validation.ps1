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
    [int]$SnapshotPageSize = 500,

    [ValidateRange(0, 10000)]
    [int]$SampleSearchLimit = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
$reportPrefix = "phase-1-$runId"
$probeName = "CocosAiProbe_$($runId.Replace('-', '_'))"
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

    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    return [PSCustomObject]@{
        raw = $raw
        data = $raw | ConvertFrom-Json -AsHashtable
    }
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

function Read-CompleteDocumentSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Document
    )

    $pages = [Collections.Generic.List[object]]::new()
    $cursor = $null
    $seenCursors = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    do {
        $arguments = @('document-snapshot') + $selectorArguments + @('--mode', 'full', '--page-size', [string]$SnapshotPageSize)
        if (-not [string]::IsNullOrWhiteSpace([string]$cursor)) {
            $arguments += @('--cursor', [string]$cursor)
        }
        $page = Invoke-CliJson -Arguments $arguments -Label "CLI document-snapshot $($Document.assetUuid)"
        Assert-Condition -Condition ($page.data.mode -eq 'full') -Message '样本文档快照不是 full 模式'
        Assert-Condition -Condition ($page.data.document.assetUuid -eq $Document.assetUuid) -Message '样本文档快照资产 UUID 不匹配'
        if ($pages.Count -gt 0) {
            Assert-Condition -Condition ($page.data.revision -eq $pages[0].revision) -Message '样本文档分页期间 Revision 发生变化'
        }
        $pages.Add($page.data)
        $cursor = $page.data.page.nextCursor
        if (-not [string]::IsNullOrWhiteSpace([string]$cursor)) {
            Assert-Condition -Condition ($seenCursors.Add([string]$cursor)) -Message '样本文档分页 cursor 出现循环'
        }
    } while (-not [string]::IsNullOrWhiteSpace([string]$cursor))

    $nodes = @($pages | ForEach-Object { @($_.nodes) })
    $componentSchemas = @($pages | ForEach-Object { @($_.componentSchemas) })
    $prefabInstances = @($pages | ForEach-Object { @($_.prefabInstances) })
    $unresolved = @($pages | ForEach-Object { @($_.unresolved) })
    $diagnostics = @($pages | ForEach-Object { @($_.diagnostics) })
    $first = $pages[0]
    Assert-Condition -Condition ([int]$first.page.totalNodes -eq $nodes.Count) -Message '样本文档完整快照节点总数不匹配'
    return [PSCustomObject]@{
        document = $first.document
        revision = $first.revision
        mode = 'full'
        page = [ordered]@{
            offset = 0
            pageSize = $SnapshotPageSize
            totalNodes = $nodes.Count
            nextCursor = $null
        }
        nodes = $nodes
        componentSchemas = $componentSchemas
        prefabInstances = $prefabInstances
        coverage = $first.coverage
        unresolved = $unresolved
        diagnostics = $diagnostics
        sourcePageCount = $pages.Count
    }
}

function Find-SampleDocumentSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [object]$AssetIndex
    )

    $documents = @($AssetIndex.documents | Sort-Object @{ Expression = { if ($_.documentType -eq 'prefab') { 0 } else { 1 } } }, path)
    Assert-Condition -Condition ($documents.Count -gt 0) -Message '资产索引没有 Scene 或 Prefab 文档'
    $attempts = [Collections.Generic.List[object]]::new()
    $candidateDocuments = if ($SampleSearchLimit -eq 0) {
        $documents
    } else {
        @($documents | Select-Object -First $SampleSearchLimit)
    }
    foreach ($document in $candidateDocuments) {
        $opened = Invoke-CliJson -Arguments (@('open-asset') + $selectorArguments + @('--uuid', [string]$document.assetUuid)) -Label "CLI open-asset $($document.assetUuid)"
        $null = Wait-EditorReady
        $snapshot = Read-CompleteDocumentSnapshot -Document $document
        $customSchemas = @($snapshot.componentSchemas | Where-Object {
            -not [string]::IsNullOrWhiteSpace([string]$_.scriptUuid)
        })
        $attempts.Add([PSCustomObject]@{
            assetUuid = $document.assetUuid
            path = $document.path
            componentSchemaCount = @($snapshot.componentSchemas).Count
            customComponentSchemaCount = $customSchemas.Count
        })
        if ($customSchemas.Count -gt 0) {
            return [PSCustomObject]@{
                document = $document
                opened = $opened.data
                snapshot = $snapshot
                componentSchema = $customSchemas[0]
                attempts = $attempts
            }
        }
    }
    $searchScope = if ($SampleSearchLimit -eq 0) { '全部文档' } else { "前 $SampleSearchLimit 个文档" }
    throw "$searchScope 没有可验证的自定义组件 Schema: $($attempts | ConvertTo-Json -Depth 10 -Compress)"
}

function Assert-Phase1ReportSchema {
    param(
        [Parameter(Mandatory = $true)]
        [object]$ScanResult,
        [Parameter(Mandatory = $true)]
        [object]$Checkpoint,
        [Parameter(Mandatory = $true)]
        [string]$CheckpointPath,
        [Parameter(Mandatory = $true)]
        [string]$ReportPath,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedProjectId,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedProjectPath,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCreatorVersion
    )

    foreach ($name in @('scanId', 'status', 'reportPath', 'checkpointPath')) {
        Assert-Condition -Condition (Test-ObjectProperty -Value $ScanResult -Name $name) -Message "项目扫描 CLI 结果缺少字段: $name"
    }
    foreach ($name in @('version', 'scanId', 'assetUuids', 'completedAssetUuids', 'failures', 'documents', 'unresolved', 'result')) {
        Assert-Condition -Condition (Test-ObjectProperty -Value $Checkpoint -Name $name) -Message "项目扫描 checkpoint 缺少字段: $name"
    }
    Assert-Condition -Condition ($Checkpoint.version -eq 2) -Message "项目扫描 checkpoint 版本无效: $($Checkpoint.version)"
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$Checkpoint.scanId)) -Message '项目扫描 checkpoint scanId 为空'
    Assert-Condition -Condition ($ScanResult.scanId -eq $Checkpoint.scanId) -Message '项目扫描 CLI 与 checkpoint scanId 不一致'
    Assert-Condition -Condition ($ScanResult.status -eq $Checkpoint.result.status) -Message '项目扫描 CLI 与 checkpoint 状态不一致'
    Assert-Condition -Condition ($Checkpoint.result.status -in @('completed', 'completed-with-gaps')) -Message "项目扫描报告状态无效: $($Checkpoint.result.status)"
    Assert-Condition -Condition (@($Checkpoint.completedAssetUuids).Count -eq @($Checkpoint.assetUuids).Count) -Message '项目扫描未处理全部 Scene/Prefab 清单'
    Assert-Condition -Condition ((@($Checkpoint.documents).Count + @($Checkpoint.failures).Count) -eq @($Checkpoint.completedAssetUuids).Count) -Message '已完成资产没有且仅有快照或失败证据'
    Assert-Condition -Condition (Test-Path -LiteralPath $ReportPath -PathType Leaf) -Message '项目扫描报告未落盘'
    Assert-Condition -Condition ((Get-Content -LiteralPath $ReportPath -TotalCount 1).Trim() -eq '{') -Message '项目扫描报告缺少 JSON 对象起始边界'
    Assert-Condition -Condition ((Get-Content -LiteralPath $ReportPath -Tail 1).Trim() -eq '}') -Message '项目扫描报告缺少 JSON 对象结束边界'

    $reportDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath))
    $checkpointDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($CheckpointPath))
    foreach ($document in @($Checkpoint.documents)) {
        foreach ($name in @('assetUuid', 'revision', 'snapshotPath', 'snapshotHash', 'summary', 'coverage')) {
            Assert-Condition -Condition (Test-ObjectProperty -Value $document -Name $name) -Message "文档快照引用缺少字段: $name"
        }
        $relativeSnapshotPath = [string]$document.snapshotPath
        Assert-Condition -Condition (-not [IO.Path]::IsPathRooted($relativeSnapshotPath)) -Message '文档快照引用不能使用绝对路径'
        Assert-Condition -Condition (-not ($relativeSnapshotPath -split '[\\/]' -contains '..')) -Message '文档快照引用不能越过报告目录'
        $snapshotPath = [IO.Path]::GetFullPath((Join-Path $checkpointDirectory $relativeSnapshotPath))
        $pathFromReportRoot = [IO.Path]::GetRelativePath($reportDirectory, $snapshotPath)
        Assert-Condition -Condition (-not ($pathFromReportRoot -eq '..' -or $pathFromReportRoot.StartsWith("..$([IO.Path]::DirectorySeparatorChar)"))) -Message '文档快照引用越过报告目录'
        Assert-Condition -Condition (Test-Path -LiteralPath $snapshotPath -PathType Leaf) -Message "文档快照文件不存在: $relativeSnapshotPath"
        $actualHash = (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-Condition -Condition ($actualHash -eq ([string]$document.snapshotHash).ToLowerInvariant()) -Message "文档快照哈希不一致: $($document.assetUuid)"
        $snapshot = (Read-JsonFile -Path $snapshotPath).data
        foreach ($name in @('document', 'revision', 'mode', 'page', 'nodes', 'componentSchemas', 'prefabInstances', 'coverage', 'unresolved', 'diagnostics')) {
            Assert-Condition -Condition (Test-ObjectProperty -Value $snapshot -Name $name) -Message "完整文档快照缺少字段: $name"
        }
        Assert-Condition -Condition ($snapshot.document.assetUuid -eq $document.assetUuid) -Message '文档快照资产 UUID 与 checkpoint 引用不一致'
        Assert-Condition -Condition ($snapshot.revision -eq $document.revision) -Message '文档快照 Revision 与 checkpoint 引用不一致'
        Assert-Condition -Condition ($snapshot.mode -eq 'full' -and $snapshot.page.offset -eq 0 -and $null -eq $snapshot.page.nextCursor) -Message '文档快照不是完整 full 结果'
        Assert-Condition -Condition (@($snapshot.nodes).Count -eq $document.summary.nodes) -Message '文档快照节点数与摘要不一致'
        Assert-Condition -Condition (@($snapshot.componentSchemas).Count -eq $document.summary.components) -Message '文档快照组件数与摘要不一致'
        Assert-Condition -Condition (@($snapshot.prefabInstances).Count -eq $document.summary.prefabInstances) -Message '文档快照 Prefab 实例数与摘要不一致'
    }

    $Report = $Checkpoint.result
    foreach ($name in @('projectId', 'projectPath', 'creatorVersion')) {
        Assert-Condition -Condition (Test-ObjectProperty -Value $Report.project -Name $name) -Message "项目扫描报告 project 缺少字段: $name"
    }
    Assert-Condition -Condition ($Report.project.projectId -eq $ExpectedProjectId) -Message '项目扫描报告 projectId 与目标编辑器不一致'
    Assert-Condition -Condition ([IO.Path]::GetFullPath([string]$Report.project.projectPath).Equals([IO.Path]::GetFullPath($ExpectedProjectPath), [StringComparison]::OrdinalIgnoreCase)) -Message '项目扫描报告 projectPath 与目标项目不一致'
    Assert-Condition -Condition ($Report.project.creatorVersion -eq $ExpectedCreatorVersion) -Message '项目扫描报告 Creator 版本与认证版本不一致'
    $gapEvidenceCount = @($Checkpoint.unresolved).Count + @($Report.diagnostics | Where-Object {
        $_.severity -in @('warning', 'error')
    }).Count
    if ((Test-ObjectProperty -Value $Report.prefabGraph -Name 'blocked') -and $Report.prefabGraph.blocked -eq $true) {
        $gapEvidenceCount += 1
    }
    if ($Report.status -eq 'completed-with-gaps') {
        Assert-Condition -Condition ($gapEvidenceCount -gt 0) -Message '项目扫描报告状态为 completed-with-gaps，但没有 unresolved、错误诊断或 blocked 证据'
    }
    $null = [DateTimeOffset]::Parse([string]$Report.startedAt)
    $null = [DateTimeOffset]::Parse([string]$Report.finishedAt)
    Assert-Condition -Condition (Test-ObjectProperty -Value $Report.prefabGraph -Name 'nodes') -Message 'Prefab 图缺少 nodes'
    Assert-Condition -Condition (Test-ObjectProperty -Value $Report.prefabGraph -Name 'edges') -Message 'Prefab 图缺少 edges'
}

function Wait-ScanCheckpointProgress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CheckpointPath,
        [Parameter(Mandatory = $true)]
        [object]$ScanProcess
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($ScanTimeoutSeconds)
    $lastReason = 'checkpoint 尚未生成'
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($ScanProcess.process.HasExited) {
            $completed = Complete-NativeCommandProcess -Control $ScanProcess
            throw "项目扫描在形成部分 checkpoint 前已结束。exitCode=$($completed.exitCode) stdout=$($completed.stdout) stderr=$($completed.stderr)"
        }
        if (Test-Path -LiteralPath $CheckpointPath -PathType Leaf) {
            try {
                $checkpoint = Read-JsonFile -Path $CheckpointPath
                $completedCount = @($checkpoint.data.completedAssetUuids).Count
                $totalCount = @($checkpoint.data.assetUuids).Count
                if ($completedCount -gt 0 -and $completedCount -lt $totalCount) {
                    return $checkpoint
                }
                $lastReason = "checkpoint 进度 $completedCount/$totalCount 不是可中断区间"
            } catch {
                $lastReason = $_.Exception.Message
            }
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "等待部分 checkpoint 超时: $lastReason"
}

function Invoke-ServerInterruptRecovery {
    param(
        [Parameter(Mandatory = $true)]
        [object]$AssetIndex
    )

    $seedScan = $null
    $seedScanCompleted = $false
    try {
    Assert-Condition -Condition (@($AssetIndex.documents).Count -ge 2) -Message 'Server 中断恢复验证至少需要两个 Scene/Prefab 文档'
    $seedReportName = "$reportPrefix-interrupt-seed.json"
    $seedCheckpointName = "$reportPrefix-interrupt-seed.checkpoint.json"
    $seedCheckpointPath = Join-Path $reportsRoot $seedCheckpointName
    $scanArguments = @(
        $cliPath,
        'scan-project'
    ) + $selectorArguments + @(
        '--report-root', $reportsRoot,
        '--report', $seedReportName,
        '--page-size', [string]$SnapshotPageSize,
        '--include-raw', 'true',
        '--concurrency', '1'
    )
    $seedScan = Start-NativeCommandProcess -FilePath $nodeExe -Arguments $scanArguments -Label 'CLI scan-project 中断种子扫描'
    $partialCheckpoint = Wait-ScanCheckpointProgress -CheckpointPath $seedCheckpointPath -ScanProcess $seedScan

    $checkpointName = "$reportPrefix-interrupt-resume.checkpoint.json"
    $checkpointPath = Join-Path $reportsRoot $checkpointName
    $null = Write-RawJsonReport -Name $checkpointName -RawJson $partialCheckpoint.raw
    $checkpointHashBefore = (Get-FileHash -LiteralPath $checkpointPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $beforeRequest = Invoke-CliJson -Arguments (@('state') + $selectorArguments) -Label 'Server 中断前 CLI state'
    $beforeInterruptionRequest = [ordered]@{
        request = $beforeRequest.data
        checkpointPath = $checkpointPath
        checkpointSha256 = $checkpointHashBefore
        scanId = $partialCheckpoint.data.scanId
        completedAssetCount = @($partialCheckpoint.data.completedAssetUuids).Count
        totalAssetCount = @($partialCheckpoint.data.assetUuids).Count
        server = Get-ServerEvidence -Control $script:activeServerControl
    }
    $null = Write-JsonReport -Name "$reportPrefix-server-interrupt-before.json" -Value $beforeInterruptionRequest

    $stopped = Stop-ProbeServerProcess -Control $script:activeServerControl
    $script:activeServerControl = $null
    $interruptedState = Invoke-NativeCommand -FilePath $nodeExe -Arguments (@($cliPath, 'state') + $selectorArguments) -Label 'Server 中断期间 CLI state' -TimeoutSeconds 30 -AllowFailure
    Assert-Condition -Condition ($interruptedState.exitCode -ne 0) -Message 'Probe Server 已停止，但 CLI state 未失败'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($interruptedState.stderr)) -Message 'CLI 中断错误缺少 stderr JSON'
    $errorPayload = $interruptedState.stderr | ConvertFrom-Json
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$errorPayload.code)) -Message 'CLI 中断错误缺少稳定 code'
    $cliInterruptionError = [ordered]@{
        stoppedServer = $stopped
        exitCode = $interruptedState.exitCode
        stdout = $interruptedState.stdout
        stderr = $errorPayload
    }
    $null = Write-JsonReport -Name "$reportPrefix-server-interrupt-error.json" -Value $cliInterruptionError
    $seedScanResult = Complete-NativeCommandProcess -Control $seedScan -Terminate
    $seedScanCompleted = $true

    $script:activeServerControl = Start-ProbeServerProcess -Generation 2
    $reconnect = Wait-EditorReconnect -ExpectedProjectId $selectedEditor.projectId -ExpectedEditorInstanceId $selectedEditor.editorInstanceId
    $editorReconnect = [ordered]@{
        attempts = $reconnect.attempts
        editor = $reconnect.editor
        server = Get-ServerEvidence -Control $script:activeServerControl
    }
    $null = Write-JsonReport -Name "$reportPrefix-server-interrupt-reconnect.json" -Value $editorReconnect

    $resumeReportName = "$reportPrefix-interrupt-resumed.json"
    $resume = Invoke-CliJson -Arguments (@('scan-project') + $selectorArguments + @(
        '--report-root', $reportsRoot,
        '--report', $resumeReportName,
        '--resume', $checkpointName,
        '--page-size', [string]$SnapshotPageSize,
        '--include-raw', 'true',
        '--concurrency', '1'
    )) -Label 'CLI scan-project 使用同一 checkpoint 恢复' -TimeoutSeconds $ScanTimeoutSeconds
    $checkpointAfter = Read-JsonFile -Path $checkpointPath
    Assert-Condition -Condition ($resume.data.scanId -eq $partialCheckpoint.data.scanId) -Message '恢复扫描返回了不同 scanId'
    Assert-Condition -Condition ($checkpointAfter.data.scanId -eq $partialCheckpoint.data.scanId) -Message '恢复后 checkpoint scanId 发生变化'
    Assert-Condition -Condition (@($checkpointAfter.data.completedAssetUuids).Count -ge @($partialCheckpoint.data.completedAssetUuids).Count) -Message '恢复后 checkpoint 完成数倒退'
    Assert-Condition -Condition ($resume.data.status -in @('completed', 'completed-with-gaps')) -Message "恢复扫描状态无效: $($resume.data.status)"
    $connectionFailures = @($checkpointAfter.data.failures | Where-Object {
        $_.code -in @('CLIENT_NOT_CONNECTED', 'SERVER_CONNECTION_CLOSED', 'SERVER_REQUEST_TIMEOUT', 'EDITOR_INSTANCE_DISCONNECTED')
    })
    Assert-Condition -Condition ($connectionFailures.Count -eq 0) -Message '恢复扫描保留了 Server 中断产生的连接失败'
    $resumeCheckpointResult = [ordered]@{
        cli = $resume.data
        seedScanProcess = $seedScanResult
        checkpointPath = $checkpointPath
        checkpointSha256Before = $checkpointHashBefore
        checkpointSha256After = (Get-FileHash -LiteralPath $checkpointPath -Algorithm SHA256).Hash.ToLowerInvariant()
        scanId = $checkpointAfter.data.scanId
        completedBefore = @($partialCheckpoint.data.completedAssetUuids).Count
        completedAfter = @($checkpointAfter.data.completedAssetUuids).Count
        totalAssets = @($checkpointAfter.data.assetUuids).Count
        reportStatus = $resume.data.status
    }
    $interruptEvidence = [ordered]@{
        schemaVersion = 1
        runId = $runId
        beforeInterruptionRequest = $beforeInterruptionRequest
        cliInterruptionError = $cliInterruptionError
        editorReconnect = $editorReconnect
        resumeCheckpointResult = $resumeCheckpointResult
    }
    $evidencePath = Write-JsonReport -Name "$reportPrefix-server-interrupt-recovery.json" -Value $interruptEvidence
    Add-PassedStep -Name 'Probe Server 中断与同 checkpoint 恢复' -DurationMs 0 -Evidence $evidencePath
    return $interruptEvidence
    } finally {
        if ($null -ne $seedScan -and -not $seedScanCompleted) {
            try {
                $null = Complete-NativeCommandProcess -Control $seedScan -Terminate
            } catch {
                Write-Warning "种子扫描清理失败，保留原始验证异常: $($_.Exception.Message)"
            }
        }
    }
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
    foreach ($capability in @('probe.editorState', 'probe.assetIndex', 'probe.openAsset', 'probe.component', 'probe.documentSnapshot')) {
        Assert-Condition -Condition ($selectedEditor.capabilities -contains $capability) -Message "Bridge 缺少只读能力: $capability"
    }
    $selectorArguments = @('--project-id', [string]$selectedEditor.projectId, '--editor-instance-id', [string]$selectedEditor.editorInstanceId)
    Add-PassedStep -Name 'Bridge 连接与 Creator 3.8.8 选择' -DurationMs $editors.command.durationMs -Evidence $editorsPath

    $state = Invoke-CliJson -Arguments (@('state') + $selectorArguments) -Label 'CLI state'
    $statePath = Write-RawJsonReport -Name "$reportPrefix-state.json" -RawJson $state.raw
    Assert-Condition -Condition ([IO.Path]::GetFullPath([string]$state.data.projectPath).Equals($project, [StringComparison]::OrdinalIgnoreCase)) -Message 'Editor state 项目路径不匹配'
    Assert-Condition -Condition ($state.data.ready.scene -eq $true -and $state.data.ready.assetDatabase -eq $true) -Message 'Creator Scene 或 AssetDB 尚未 Ready'
    Add-PassedStep -Name 'Editor state' -DurationMs $state.command.durationMs -Evidence $statePath

    $assetIndex = Invoke-CliJson -Arguments (@('asset-index') + $selectorArguments) -Label 'CLI asset-index'
    $assetIndexPath = Write-RawJsonReport -Name "$reportPrefix-asset-index.json" -RawJson $assetIndex.raw
    foreach ($name in @('assets', 'scripts', 'documents', 'unresolved')) {
        Assert-Condition -Condition (Test-ObjectProperty -Value $assetIndex.data -Name $name) -Message "资产索引缺少字段: $name"
    }
    Assert-Condition -Condition (@($assetIndex.data.documents).Count -gt 0) -Message '资产索引没有 Scene 或 Prefab'
    Add-PassedStep -Name 'Asset 索引' -DurationMs $assetIndex.command.durationMs -Evidence $assetIndexPath

    $sample = Find-SampleDocumentSnapshot -AssetIndex $assetIndex.data
    $snapshotPath = Write-JsonReport -Name "$reportPrefix-document-snapshot-full.json" -Value ([ordered]@{
        document = $sample.document
        opened = $sample.opened
        attempts = $sample.attempts
        snapshot = $sample.snapshot
    })
    Assert-Condition -Condition ($sample.snapshot.page.offset -eq 0 -and $null -eq $sample.snapshot.page.nextCursor) -Message '样本文档完整快照分页边界无效'
    Assert-Condition -Condition ($sample.snapshot.page.totalNodes -eq @($sample.snapshot.nodes).Count) -Message '样本文档完整快照不完整'
    Add-PassedStep -Name '样本文档完整快照' -DurationMs 0 -Evidence $snapshotPath

    $componentSchema = Invoke-CliJson -Arguments (@('component-schema') + $selectorArguments + @('--uuid', [string]$sample.componentSchema.componentUuid)) -Label 'CLI component-schema'
    $componentSchemaPath = Write-RawJsonReport -Name "$reportPrefix-component-schema.json" -RawJson $componentSchema.raw
    $componentPayload = $componentSchema.data['data']
    $componentIdentity = $componentPayload['identity']
    $componentTypeSchema = $componentPayload['schema']
    Assert-Condition -Condition ([string]$componentIdentity['objectUuid'] -eq [string]$sample.componentSchema.componentUuid) -Message '组件 Schema 的组件 UUID 与请求不匹配'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$componentTypeSchema['scriptUuid'])) -Message '自定义组件 Schema 缺少脚本 UUID'
    Assert-Condition -Condition (Test-ObjectProperty -Value $componentTypeSchema -Name 'properties') -Message '组件 Schema 缺少 properties'
    Add-PassedStep -Name '自定义 Component Schema' -DurationMs $componentSchema.command.durationMs -Evidence $componentSchemaPath

    $prefabGraph = Invoke-CliJson -Arguments (@('prefab-graph') + $selectorArguments) -Label 'CLI prefab-graph' -TimeoutSeconds $ScanTimeoutSeconds
    $prefabGraphPath = Write-RawJsonReport -Name "$reportPrefix-prefab-graph.json" -RawJson $prefabGraph.raw
    Assert-Condition -Condition (Test-ObjectProperty -Value $prefabGraph.data -Name 'nodes') -Message 'Prefab 图缺少 nodes'
    Assert-Condition -Condition (Test-ObjectProperty -Value $prefabGraph.data -Name 'edges') -Message 'Prefab 图缺少 edges'
    Add-PassedStep -Name 'Prefab 图' -DurationMs $prefabGraph.command.durationMs -Evidence $prefabGraphPath

    $scanReportName = "$reportPrefix-project-scan.json"
    $projectScan = Invoke-CliJson -Arguments (@('scan-project') + $selectorArguments + @(
        '--report-root', $reportsRoot,
        '--report', $scanReportName,
        '--page-size', [string]$SnapshotPageSize,
        '--include-raw', 'true',
        '--concurrency', '1'
    )) -Label 'CLI scan-project' -TimeoutSeconds $ScanTimeoutSeconds
    $projectScanResultPath = Write-RawJsonReport -Name "$reportPrefix-project-scan-result.json" -RawJson $projectScan.raw
    $scanReportPath = Join-Path $reportsRoot $scanReportName
    $checkpointName = $scanReportName.Substring(0, $scanReportName.Length - '.json'.Length) + '.checkpoint.json'
    $checkpointPath = Join-Path $reportsRoot $checkpointName
    Assert-Condition -Condition (Test-Path -LiteralPath $scanReportPath -PathType Leaf) -Message '项目扫描报告未落盘'
    Assert-Condition -Condition (Test-Path -LiteralPath $checkpointPath -PathType Leaf) -Message '项目扫描 checkpoint 未落盘'
    $scanCheckpoint = Read-JsonFile -Path $checkpointPath
    Assert-Condition -Condition ($projectScan.data.scanId -eq $scanCheckpoint.data.scanId) -Message '项目扫描 CLI 与 checkpoint scanId 不一致'
    Add-PassedStep -Name '项目全量只读扫描' -DurationMs $projectScan.command.durationMs -Evidence $projectScanResultPath

    $interruptRecovery = Invoke-ServerInterruptRecovery -AssetIndex $assetIndex.data

    Assert-Phase1ReportSchema -ScanResult $projectScan.data `
        -Checkpoint $scanCheckpoint.data `
        -CheckpointPath $checkpointPath `
        -ReportPath $scanReportPath `
        -ExpectedProjectId ([string]$selectedEditor.projectId) `
        -ExpectedProjectPath $project `
        -ExpectedCreatorVersion '3.8.8'
    $schemaEvidencePath = Write-JsonReport -Name "$reportPrefix-report-schema.json" -Value ([ordered]@{
        schemaVersion = 1
        runId = $runId
        status = 'passed'
        reportPath = $scanReportPath
        scanId = $scanCheckpoint.data.scanId
        projectStatus = $scanCheckpoint.data.result.status
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    })
    Add-PassedStep -Name '项目扫描报告 Schema' -DurationMs 0 -Evidence $schemaEvidencePath

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
            Write-Warning "写入 Phase 1 summary 失败，保留原始验证异常: $summaryWriteFailure"
        } else {
            throw "写入 Phase 1 summary 失败: $summaryWriteFailure"
        }
    }
    Write-Host "Phase 1 报告前缀: $reportPrefix"
    Write-Host "Phase 1 最终状态: $runStatus"
    if ($mainCompletedSuccessfully -and $runStatus -ne 'passed') {
        throw "Phase 1 主流程完成，但收尾失败: $($failure.message)"
    }
}
