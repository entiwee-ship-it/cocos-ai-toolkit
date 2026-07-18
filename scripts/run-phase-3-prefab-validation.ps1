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

    [ValidateRange(25, 5000)]
    [int]$SnapshotPageSize = 500,

    # 跳过 npm test / typecheck / build 静态检查（重复联调时使用）；dist 产物存在性检查始终执行
    [switch]$SkipStatic
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 阶段三统一验证脚本必须运行在 pwsh 7+（Windows PowerShell 5.1 的参数绑定行为不兼容）。
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "阶段三预制体统一验证脚本必须在 pwsh 7+ 运行，当前宿主版本为 $($PSVersionTable.PSVersion)"
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
$reportPrefix = "phase-3-$runId"
# Creator 节点名不允许的部分字符用下划线形态的运行后缀规避（与阶段二同构）
$fixtureSuffix = $runId.Replace('-', '_')
$cardRootName = "Phase3Card_$fixtureSuffix"
$healthInstanceName = "Phase3Health_$fixtureSuffix"
$pageRootName = "Phase3Page_$fixtureSuffix"
$cardInstanceName = "Phase3CardInst_$fixtureSuffix"
$pageInstanceName = "Phase3PageInst_$fixtureSuffix"
$cardPrefabAssetUrl = "db://assets/Phase3Card-$runId.prefab"
$pagePrefabAssetUrl = "db://assets/Phase3Page-$runId.prefab"
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
# 夹具身份：供 summary 与失败排查使用，主流程逐步填充
$cardRootUuid = $null
$pageRootUuid = $null
$sceneInstanceUuid = $null
$cardPrefab = $null
$pagePrefab = $null

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

function ConvertTo-ProjectRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AssetUrl
    )

    Assert-Condition -Condition ($AssetUrl.StartsWith('db://', [StringComparison]::Ordinal)) -Message "资产 URL 非法: $AssetUrl"
    return $AssetUrl.Substring('db://'.Length).Replace('\', '/')
}

function Restore-ProjectFileFromGit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    # 已跟踪文件：git checkout 逐字还原；未跟踪文件（本轮新建夹具资产）git 无法还原，
    # 记录证据并交由夹具清理的 prefab.delete_asset 删除兜底（阶段二教训：还原以 git 恢复为兜底）。
    $tracked = Invoke-NativeCommand -FilePath $gitExe -Arguments @('-C', $project, 'ls-files', '--error-unmatch', '--', $RelativePath) -Label "$Label git ls-files" -AllowFailure
    if ($tracked.exitCode -eq 0) {
        $null = Invoke-NativeCommand -FilePath $gitExe -Arguments @('-C', $project, 'checkout', '--', $RelativePath) -Label "$Label git checkout"
        return [PSCustomObject]@{ mode = 'git-checkout'; path = $RelativePath }
    }
    return [PSCustomObject]@{ mode = 'untracked-fixture'; path = $RelativePath }
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
    # netstat 与进程查询之间监听进程可能已退出（竞态）：先短重试，仍不可读且监听已消失时按缺失处理
    $processInfo = $null
    for ($attempt = 1; $attempt -le 5 -and $null -eq $processInfo; $attempt += 1) {
        try {
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
        } catch {
            $processInfo = $null
        }
        if ($null -ne $processInfo) { break }
        $stillListening = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { [int]$_.OwningProcess -eq $processId })
        if ($stillListening.Count -eq 0) {
            if ($AllowMissing) { return $null }
            throw "127.0.0.1:$Port 的监听进程 $processId 已退出"
        }
        Start-Sleep -Milliseconds 200
    }
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

function Find-SampleWriteDocument {
    param(
        [Parameter(Mandatory = $true)]
        [object]$AssetIndex
    )

    $documents = @($AssetIndex.documents)
    Assert-Condition -Condition ($documents.Count -gt 0) -Message '资产索引没有 Scene 或 Prefab'
    # 写入验证的草稿文档优先选场景：Prefab 编辑模式会把写入打到 should_hide_in_hierarchy
    # 编辑容器上（层级面板报 isPrefabRoot 错误），场景才是自然的写入目标。
    $scene = $null
    foreach ($document in $documents) {
        if ([string]$document.documentType -eq 'scene') {
            $scene = $document
            break
        }
    }
    $target = $scene
    if ($null -eq $target) {
        foreach ($document in $documents) {
            if ([string]$document.documentType -eq 'prefab') {
                $target = $document
                break
            }
        }
    }
    if ($null -eq $target) {
        $target = $documents[0]
    }
    $assetUuid = [string]($target.assetUuid ?? $target.uuid)
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($assetUuid)) -Message '样本文档缺少资产 UUID'
    return [PSCustomObject]@{
        assetUuid = $assetUuid
        path = [string]($target.path ?? $target.url ?? '')
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

function Find-NodeUuidByName {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Snapshot,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$NotFoundMessage
    )

    foreach ($node in (Read-FirstPageNodes -Snapshot $Snapshot)) {
        if ([string]$node.name -eq $Name) {
            return Read-NodeUuid -Node $node
        }
    }
    throw $NotFoundMessage
}

function Read-NodePrefabEvidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NodeUuid,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    # 实例身份证据取自 probe.node 原始 Dump 的 __prefab__ 结构（PrefabInfo）：
    # uuid 为源预制体资产，instance.fileId 为实例 FileID；解除关联后两者均为空。
    $result = Invoke-CliJson -Arguments (@('node') + $script:selectorArguments + @('--uuid', $NodeUuid)) -Label $Label
    $rawNode = $result.data.raw
    $prefab = $null
    if ($rawNode -is [Collections.IDictionary] -and $rawNode.Contains('__prefab__')) {
        $prefab = $rawNode['__prefab__']
    }
    $prefabAssetUuid = $null
    $sourceObjectFileId = $null
    $instanceFileId = $null
    if ($prefab -is [Collections.IDictionary]) {
        if ($prefab['uuid'] -is [string] -and $prefab['uuid']) {
            $prefabAssetUuid = [string]$prefab['uuid']
        }
        if ($prefab['fileId'] -is [string] -and $prefab['fileId']) {
            $sourceObjectFileId = [string]$prefab['fileId']
        }
        $instance = $prefab['instance']
        if ($instance -is [Collections.IDictionary]) {
            $instanceValue = $instance['value']
            if ($instanceValue -is [Collections.IDictionary]) {
                $fileId = $instanceValue['fileId']
                if ($fileId -is [Collections.IDictionary] -and $fileId['value'] -is [string] -and $fileId['value']) {
                    $instanceFileId = [string]$fileId['value']
                }
            }
        }
    }
    return [PSCustomObject]@{
        nodeUuid = $NodeUuid
        prefabAssetUuid = $prefabAssetUuid
        sourceObjectFileId = $sourceObjectFileId
        instanceFileId = $instanceFileId
        command = $result.command
    }
}

function Read-PrefabOverrideEvidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NodeUuid,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    # Override 证据取自 probe.prefab 规范化结果：propertyOverrides 数组为非空即存在实例覆盖。
    $result = Invoke-CliJson -Arguments (@('prefab') + $script:selectorArguments + @('--node-uuid', $NodeUuid)) -Label $Label
    $overrides = @($result.data.data.propertyOverrides)
    return [PSCustomObject]@{
        nodeUuid = $NodeUuid
        count = $overrides.Count
        propertyOverrides = $overrides
        command = $result.command
    }
}

function Wait-AssetDocumentByUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AssetUrl,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    # create_from_node 提交后 AssetDB 登记存在刷新延迟：按 URL 轮询资产索引直到文档出现。
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $index = Invoke-CliJson -Arguments (@('asset-index') + $script:selectorArguments) -Label $Label
        foreach ($document in @($index.data.documents)) {
            if ([string]$document.path -eq $AssetUrl) {
                return [PSCustomObject]@{
                    assetUuid = [string]$document.assetUuid
                    path = [string]$document.path
                    filePath = [string]$document.filePath
                }
            }
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "$Label 等待资产登记超时: $AssetUrl"
}

function Collect-PrefabInstanceMarks {
    param(
        [AllowNull()]
        [object]$Node,
        [Parameter(Mandatory = $true)]
        [Collections.Generic.List[string]]$Marks
    )

    # 与 Bridge collectPrefabInstanceMarks 同构：递归收集节点树中的预制体实例标记
    # （根 UUID|源资产|源 FileID|实例 FileID），供 revision.prefabGraph 指纹使用。
    if ($Node -isnot [Collections.IDictionary]) {
        return
    }
    $prefab = $Node['__prefab__']
    if ($prefab -is [Collections.IDictionary] -and $prefab.Count -gt 0 -and $prefab['uuid'] -is [string] -and $prefab['uuid']) {
        $nodeUuid = ''
        $uuidDump = $Node['uuid']
        if ($uuidDump -is [Collections.IDictionary] -and $uuidDump['value'] -is [string]) {
            $nodeUuid = [string]$uuidDump['value']
        }
        $instanceFileId = ''
        $instance = $prefab['instance']
        if ($instance -is [Collections.IDictionary]) {
            $instanceValue = $instance['value']
            if ($instanceValue -is [Collections.IDictionary]) {
                $fileId = $instanceValue['fileId']
                if ($fileId -is [Collections.IDictionary] -and $fileId['value'] -is [string]) {
                    $instanceFileId = [string]$fileId['value']
                }
            }
        }
        $sourceFileId = if ($prefab['fileId'] -is [string]) { [string]$prefab['fileId'] } else { '' }
        $Marks.Add("$nodeUuid|$([string]$prefab['uuid'])|$sourceFileId|$instanceFileId")
    }
    $children = $Node['children']
    if ($children -is [Collections.IList]) {
        foreach ($child in $children) {
            Collect-PrefabInstanceMarks -Node $child -Marks $Marks
        }
    }
}

function Get-PrefabGraphFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    # prefab.apply_to_source 要求 revision.prefabGraph 前置指纹（协议与 Bridge 双重门禁）。
    # 指纹算法与 Bridge captureCurrentDocumentIdentity 一致：实例标记排序后拼接取 SHA-256；
    # 输入为 probe.hierarchy 的原始 query-node-tree（与 Bridge 采集同源），排序按序号规则对齐 JS。
    $hierarchy = Invoke-CliJson -Arguments (@('hierarchy') + $script:selectorArguments + @('--depth', '20')) -Label $Label
    $marks = [Collections.Generic.List[string]]::new()
    Collect-PrefabInstanceMarks -Node $hierarchy.data.raw -Marks $marks
    $sortedMarks = [string[]]$marks.ToArray()
    [Array]::Sort($sortedMarks, [StringComparer]::Ordinal)
    $joined = [string]::Join(';', $sortedMarks)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($joined))
    } finally {
        $sha256.Dispose()
    }
    $hex = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    return "sha256:$hex"
}

function New-WriteRequest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionId,

        [Parameter(Mandatory = $true)]
        [object[]]$Operations,

        [bool]$Save = $true,

        [ValidateSet('current-document', 'source-prefab', 'apply-to-source')]
        [string]$Scope = 'current-document',

        [AllowNull()]
        [object]$ImpactAnalysis = $null,

        [AllowNull()]
        [string]$PrefabGraphRevision = $null
    )

    $request = [ordered]@{
        transactionId = $TransactionId
        idempotencyKey = "key-$TransactionId"
        scope = $Scope
        revision = [ordered]@{
            document = $null
            hierarchy = $null
            assetDatabase = $null
            scriptCompilation = $null
            prefabGraph = $PrefabGraphRevision
        }
        operations = $Operations
        save = $Save
        undoGroup = "phase-3-$TransactionId"
    }
    if ($null -ne $ImpactAnalysis) {
        $request.impactAnalysis = $ImpactAnalysis
    }
    return ($request | ConvertTo-Json -Depth 12 -Compress)
}

function Invoke-WriteTransaction {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionId,

        [Parameter(Mandatory = $true)]
        [object[]]$Operations,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [ValidateSet('current-document', 'source-prefab', 'apply-to-source')]
        [string]$Scope = 'current-document',

        [AllowNull()]
        [object]$ImpactAnalysis = $null,

        [AllowNull()]
        [string]$PrefabGraphRevision = $null
    )

    $requestJson = New-WriteRequest -TransactionId $TransactionId -Operations $Operations -Scope $Scope -ImpactAnalysis $ImpactAnalysis -PrefabGraphRevision $PrefabGraphRevision
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

    if (-not $SkipStatic) {
        $npmTest = Invoke-NativeCommand -FilePath $npmExe -Arguments @('test') -Label 'npm test' -TimeoutSeconds $ScanTimeoutSeconds
        $npmTestPath = Write-JsonReport -Name "$reportPrefix-npm-test.json" -Value $npmTest
        Add-PassedStep -Name 'npm test' -DurationMs $npmTest.durationMs -Evidence $npmTestPath -ExitCode $npmTest.exitCode

        $npmTypecheck = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'typecheck') -Label 'npm run typecheck' -TimeoutSeconds $ScanTimeoutSeconds
        $npmTypecheckPath = Write-JsonReport -Name "$reportPrefix-npm-typecheck.json" -Value $npmTypecheck
        Add-PassedStep -Name 'npm run typecheck' -DurationMs $npmTypecheck.durationMs -Evidence $npmTypecheckPath -ExitCode $npmTypecheck.exitCode

        $npmBuild = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'build') -Label 'npm run build' -TimeoutSeconds $ScanTimeoutSeconds
        $npmBuildPath = Write-JsonReport -Name "$reportPrefix-npm-build.json" -Value $npmBuild
        Add-PassedStep -Name 'npm run build' -DurationMs $npmBuild.durationMs -Evidence $npmBuildPath -ExitCode $npmBuild.exitCode
    } else {
        $skipStaticPath = Write-JsonReport -Name "$reportPrefix-static-skipped.json" -Value ([ordered]@{
            skipped = $true
            reason = '-SkipStatic 指定跳过 npm test / typecheck / build'
        })
        Add-PassedStep -Name '静态检查跳过（-SkipStatic）' -DurationMs 0 -Evidence $skipStaticPath
    }
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
    foreach ($capability in @('probe.editorState', 'probe.assetIndex', 'probe.openAsset', 'probe.hierarchy', 'probe.node', 'probe.prefab', 'probe.documentSnapshot', 'probe.writePrepare', 'probe.writeConfirm', 'probe.transactionStatus', 'probe.transactionList', 'probe.transactionRollback')) {
        Assert-Condition -Condition ($selectedEditor.capabilities -contains $capability) -Message "Bridge 缺少阶段三所需能力: $capability"
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
    # 三层嵌套夹具的底层资产：空白项目必须已存在唯一的 healthDialog.prefab（6 节点带组件）
    $healthDialogMatches = @($assetIndex.data.documents | Where-Object {
        [string]$_.documentType -eq 'prefab' -and [string]$_.path -like '*healthDialog.prefab'
    })
    Assert-Condition -Condition ($healthDialogMatches.Count -eq 1) -Message '资产索引中必须存在唯一的 healthDialog.prefab 夹具资产'
    $healthDialogPrefab = [PSCustomObject]@{
        assetUuid = [string]($healthDialogMatches[0].assetUuid ?? $healthDialogMatches[0].uuid)
        path = [string]$healthDialogMatches[0].path
    }
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($healthDialogPrefab.assetUuid)) -Message 'healthDialog.prefab 缺少资产 UUID'
    Add-PassedStep -Name 'Asset 索引与夹具资产定位' -DurationMs $assetIndex.command.durationMs -Evidence $assetIndexPath

    $opened = Invoke-CliJson -Arguments (@('open-asset') + $script:selectorArguments + @('--uuid', $sampleDocument.assetUuid)) -Label 'CLI open-asset'
    $baselineSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label '只读基线快照'
    $baselinePath = Write-RawJsonReport -Name "$reportPrefix-baseline-snapshot.json" -RawJson $baselineSnapshot.raw
    $baselineNodes = Read-FirstPageNodes -Snapshot $baselineSnapshot
    # 夹具节点：快照中第一个带组件且带局部变换的节点（场景伪根没有 position dump，不能作为写入目标）
    $fixtureNode = $null
    foreach ($node in $baselineNodes) {
        $candidateComponent = @($baselineSnapshot.data.componentSchemas) | Where-Object { [string]$_.nodeUuid -eq (Read-NodeUuid -Node $node) } | Select-Object -First 1
        if ($null -ne $candidateComponent -and $null -ne $node.localTransform.position) {
            $fixtureNode = $node
            break
        }
    }
    Assert-Condition -Condition ($null -ne $fixtureNode) -Message '基线快照没有带组件和变换的可用节点'
    $rootNodeUuid = Read-NodeUuid -Node $fixtureNode
    $rootOriginalName = [string]$fixtureNode.name
    $sceneRelativePath = ConvertTo-ProjectRelativePath -AssetUrl $sampleDocument.path
    Add-PassedStep -Name '只读基线快照' -DurationMs $baselineSnapshot.command.durationMs -Evidence $baselinePath

    # 夹具自举：三层嵌套（Phase3Page → Phase3Card → healthDialog）全部用工具自身写能力构建。
    # 每步都是独立写事务并 committed；新建节点/资产身份经只读回读钉住后再驱动下一步。
    $cardRootTxId = "tx-fixture-card-root-$runId"
    $null = Invoke-WriteTransaction -TransactionId $cardRootTxId -Label '夹具自举：Card 根节点' -Operations @(
        [ordered]@{ type = 'node.create'; parentNodeUuid = $rootNodeUuid; name = $cardRootName }
    )
    $cardRootSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label 'Card 根节点回读'
    $cardRootUuid = Find-NodeUuidByName -Snapshot $cardRootSnapshot -Name $cardRootName -NotFoundMessage '夹具自举后找不到 Card 根节点'

    $cardInstanceTxId = "tx-fixture-card-instance-$runId"
    $null = Invoke-WriteTransaction -TransactionId $cardInstanceTxId -Label '夹具自举：Card 内嵌实例' -Operations @(
        [ordered]@{ type = 'prefab.instantiate'; prefabAssetUuid = $healthDialogPrefab.assetUuid; parentNodeUuid = $cardRootUuid; name = $healthInstanceName }
    )
    $cardInstanceSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label 'Card 内嵌实例回读'
    $healthInstanceUuid = Find-NodeUuidByName -Snapshot $cardInstanceSnapshot -Name $healthInstanceName -NotFoundMessage '夹具自举后找不到 Card 内嵌实例'
    $healthInstanceEvidence = Read-NodePrefabEvidence -NodeUuid $healthInstanceUuid -Label 'Card 内嵌实例 probe.node 证据'
    Assert-Condition -Condition ($healthInstanceEvidence.prefabAssetUuid -eq $healthDialogPrefab.assetUuid) -Message 'Card 内嵌实例源资产关联异常'

    $cardPrefabTxId = "tx-fixture-card-prefab-$runId"
    $null = Invoke-WriteTransaction -TransactionId $cardPrefabTxId -Label '夹具自举：Card 生成预制体' -Operations @(
        [ordered]@{ type = 'prefab.create_from_node'; nodeUuid = $cardRootUuid; assetUrl = $cardPrefabAssetUrl }
    )
    $cardPrefab = Wait-AssetDocumentByUrl -AssetUrl $cardPrefabAssetUrl -Label 'Card 预制体资产登记'
    $cardRootInstanceEvidence = Read-NodePrefabEvidence -NodeUuid $cardRootUuid -Label 'Card 根节点实例关联证据'
    Assert-Condition -Condition ($cardRootInstanceEvidence.prefabAssetUuid -eq $cardPrefab.assetUuid) -Message 'create_from_node 后 Card 根节点未关联新预制体'

    $pageRootTxId = "tx-fixture-page-root-$runId"
    $null = Invoke-WriteTransaction -TransactionId $pageRootTxId -Label '夹具自举：Page 根节点' -Operations @(
        [ordered]@{ type = 'node.create'; parentNodeUuid = $rootNodeUuid; name = $pageRootName }
    )
    $pageRootSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label 'Page 根节点回读'
    $pageRootUuid = Find-NodeUuidByName -Snapshot $pageRootSnapshot -Name $pageRootName -NotFoundMessage '夹具自举后找不到 Page 根节点'

    $pageInstanceTxId = "tx-fixture-page-instance-$runId"
    $null = Invoke-WriteTransaction -TransactionId $pageInstanceTxId -Label '夹具自举：Page 内嵌实例' -Operations @(
        [ordered]@{ type = 'prefab.instantiate'; prefabAssetUuid = $cardPrefab.assetUuid; parentNodeUuid = $pageRootUuid; name = $cardInstanceName }
    )
    $pageInstanceSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label 'Page 内嵌实例回读'
    $cardInstanceUuid = Find-NodeUuidByName -Snapshot $pageInstanceSnapshot -Name $cardInstanceName -NotFoundMessage '夹具自举后找不到 Page 内嵌实例'
    $cardInstanceEvidence = Read-NodePrefabEvidence -NodeUuid $cardInstanceUuid -Label 'Page 内嵌实例 probe.node 证据'
    Assert-Condition -Condition ($cardInstanceEvidence.prefabAssetUuid -eq $cardPrefab.assetUuid) -Message 'Page 内嵌实例源资产关联异常'

    $pagePrefabTxId = "tx-fixture-page-prefab-$runId"
    $null = Invoke-WriteTransaction -TransactionId $pagePrefabTxId -Label '夹具自举：Page 生成预制体' -Operations @(
        [ordered]@{ type = 'prefab.create_from_node'; nodeUuid = $pageRootUuid; assetUrl = $pagePrefabAssetUrl }
    )
    $pagePrefab = Wait-AssetDocumentByUrl -AssetUrl $pagePrefabAssetUrl -Label 'Page 预制体资产登记'
    $pageRootInstanceEvidence = Read-NodePrefabEvidence -NodeUuid $pageRootUuid -Label 'Page 根节点实例关联证据'
    Assert-Condition -Condition ($pageRootInstanceEvidence.prefabAssetUuid -eq $pagePrefab.assetUuid) -Message 'create_from_node 后 Page 根节点未关联新预制体'

    # 提交后事务清单应为空（全部 committed）
    $transactionList = Invoke-CliJson -Arguments (@('transaction-list') + $script:selectorArguments) -Label 'CLI transaction-list'
    $transactionListPath = Write-RawJsonReport -Name "$reportPrefix-transaction-list.json" -RawJson $transactionList.raw
    Assert-Condition -Condition (@($transactionList.data).Count -eq 0) -Message '提交后仍存在未完成事务'
    Add-PassedStep -Name '提交后事务清单为空' -DurationMs $transactionList.command.durationMs -Evidence $transactionListPath

    # 实例化事务：把三层嵌套的 Phase3Page 挂到场景夹具根下，验证实例身份（probe.node 的 __prefab__）
    $instantiateTxId = "tx-instantiate-$runId"
    $null = Invoke-WriteTransaction -TransactionId $instantiateTxId -Label '实例化事务' -Operations @(
        [ordered]@{ type = 'prefab.instantiate'; prefabAssetUuid = $pagePrefab.assetUuid; parentNodeUuid = $rootNodeUuid; name = $pageInstanceName }
    )
    $instantiatedSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label '实例化后层级回读'
    $sceneInstanceUuid = Find-NodeUuidByName -Snapshot $instantiatedSnapshot -Name $pageInstanceName -NotFoundMessage '实例化后层级中找不到场景实例节点'
    $instanceEvidence = Read-NodePrefabEvidence -NodeUuid $sceneInstanceUuid -Label '实例化后 probe.node 实例证据'
    Assert-Condition -Condition ($instanceEvidence.prefabAssetUuid -eq $pagePrefab.assetUuid) -Message '实例化后 __prefab__.uuid 与源资产不一致'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($instanceEvidence.instanceFileId)) -Message '实例化后缺少实例 FileID'
    $instanceEvidencePath = Write-JsonReport -Name "$reportPrefix-instantiate-evidence.json" -Value $instanceEvidence
    Add-PassedStep -Name '实例化验证' -DurationMs $instanceEvidence.command.durationMs -Evidence $instanceEvidencePath

    # 覆盖事务：对场景实例根写一笔变换，验证 Override 产生
    $overrideTxId = "tx-override-$runId"
    $null = Invoke-WriteTransaction -TransactionId $overrideTxId -Label '覆盖事务' -Operations @(
        [ordered]@{ type = 'node.set_transform'; nodeUuid = $sceneInstanceUuid; localTransform = [ordered]@{ position = [ordered]@{ x = 33; y = 44; z = 0 } } }
    )
    $overrideEvidence = Read-PrefabOverrideEvidence -NodeUuid $sceneInstanceUuid -Label '覆盖后 probe.prefab 覆盖证据'
    Assert-Condition -Condition ($overrideEvidence.count -gt 0) -Message '覆盖写后实例没有产生 Override'
    $overrideEvidencePath = Write-JsonReport -Name "$reportPrefix-override-evidence.json" -Value $overrideEvidence
    Add-PassedStep -Name '覆盖验证' -DurationMs $overrideEvidence.command.durationMs -Evidence $overrideEvidencePath

    # 还原事务：整实例还原 Override，验证覆盖清除
    $revertTxId = "tx-revert-$runId"
    $null = Invoke-WriteTransaction -TransactionId $revertTxId -Label '还原事务' -Operations @(
        [ordered]@{ type = 'prefab.revert_override'; instanceRootUuid = $sceneInstanceUuid }
    )
    $revertEvidence = Read-PrefabOverrideEvidence -NodeUuid $sceneInstanceUuid -Label '还原后 probe.prefab 覆盖证据'
    Assert-Condition -Condition ($revertEvidence.count -eq 0) -Message '整实例还原后仍残留 Override'
    $revertEvidencePath = Write-JsonReport -Name "$reportPrefix-revert-evidence.json" -Value $revertEvidence
    Add-PassedStep -Name '还原验证' -DurationMs $revertEvidence.command.durationMs -Evidence $revertEvidencePath

    # 应用到源：先造一笔 Override 再应用到源；scope=apply-to-source 必须携带内联影响分析与
    # revision.prefabGraph 前置指纹（协议与 Bridge 双重门禁），指纹由只读层级即时推导。
    $prefabGraphRevision = Get-PrefabGraphFingerprint -Label '应用到源前 prefabGraph 指纹采集'
    $impactAnalysis = [ordered]@{
        sourceAssetUuid = $pagePrefab.assetUuid
        sourceAssetPath = $pagePrefabAssetUrl
        affectedDocuments = @(
            [ordered]@{
                assetUuid = $sampleDocument.assetUuid
                path = $sampleDocument.path
                documentType = 'scene'
                instanceCount = 1
            }
        )
        totalInstanceCount = 1
        overrideLayers = @('current-document')
        risks = @('应用到源将改写源预制体磁盘文件；本轮夹具资产为新建未跟踪文件，内容由清理步骤的 prefab.delete_asset 删除兜底，已跟踪场景文件由 git checkout 还原')
    }
    $applyTxId = "tx-apply-$runId"
    $null = Invoke-WriteTransaction -TransactionId $applyTxId -Label '应用到源事务' -Scope 'apply-to-source' -ImpactAnalysis $impactAnalysis -PrefabGraphRevision $prefabGraphRevision -Operations @(
        [ordered]@{ type = 'node.set_transform'; nodeUuid = $sceneInstanceUuid; localTransform = [ordered]@{ position = [ordered]@{ x = 55; y = 66; z = 0 } } },
        [ordered]@{ type = 'prefab.apply_to_source'; instanceRootUuid = $sceneInstanceUuid }
    )
    $applyEvidence = Read-PrefabOverrideEvidence -NodeUuid $sceneInstanceUuid -Label '应用到源后 probe.prefab 覆盖证据'
    Assert-Condition -Condition ($applyEvidence.count -eq 0) -Message '应用到源后实例仍残留 Override'
    $applyInstanceEvidence = Read-NodePrefabEvidence -NodeUuid $sceneInstanceUuid -Label '应用到源后实例关联复查'
    Assert-Condition -Condition ($applyInstanceEvidence.prefabAssetUuid -eq $pagePrefab.assetUuid) -Message '应用到源后实例源资产关联变化'
    # 应用到源已改写源预制体磁盘文件：已跟踪文件 git checkout 还原；
    # 本轮新建夹具资产未被 Git 跟踪，记录证据由清理步骤的 prefab.delete_asset 删除兜底。
    $applyRestore = Restore-ProjectFileFromGit -RelativePath (ConvertTo-ProjectRelativePath -AssetUrl $pagePrefabAssetUrl) -Label '源预制体文件还原'
    $applyEvidencePath = Write-JsonReport -Name "$reportPrefix-apply-to-source-evidence.json" -Value ([ordered]@{
        prefabGraphRevision = $prefabGraphRevision
        impactAnalysis = $impactAnalysis
        overridesAfterApply = $applyEvidence.count
        restore = $applyRestore
    })
    Add-PassedStep -Name '应用到源验证与源文件还原' -DurationMs $applyEvidence.command.durationMs -Evidence $applyEvidencePath

    # 解除关联事务：解除后 __prefab__ 必须为空；随后回滚该事务（逆操作 link_instance）验证关联恢复
    $unlinkTxId = "tx-unlink-$runId"
    $null = Invoke-WriteTransaction -TransactionId $unlinkTxId -Label '解除关联事务' -Operations @(
        [ordered]@{ type = 'prefab.unlink_instance'; instanceRootUuid = $sceneInstanceUuid }
    )
    $unlinkEvidence = Read-NodePrefabEvidence -NodeUuid $sceneInstanceUuid -Label '解除关联后 probe.node 证据'
    Assert-Condition -Condition ([string]::IsNullOrWhiteSpace($unlinkEvidence.prefabAssetUuid)) -Message '解除关联后 __prefab__ 仍指向源资产'
    Assert-Condition -Condition ([string]::IsNullOrWhiteSpace($unlinkEvidence.instanceFileId)) -Message '解除关联后仍残留实例 FileID'
    $unlinkEvidencePath = Write-JsonReport -Name "$reportPrefix-unlink-evidence.json" -Value $unlinkEvidence
    Add-PassedStep -Name '解除关联验证' -DurationMs $unlinkEvidence.command.durationMs -Evidence $unlinkEvidencePath

    $null = Invoke-TransactionRollback -TransactionId $unlinkTxId -Label '解除关联回滚'
    $relinkEvidence = Read-NodePrefabEvidence -NodeUuid $sceneInstanceUuid -Label '回滚解除关联后 probe.node 证据'
    Assert-Condition -Condition ($relinkEvidence.prefabAssetUuid -eq $pagePrefab.assetUuid) -Message '解除关联回滚后实例关联未恢复'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($relinkEvidence.instanceFileId)) -Message '解除关联回滚后缺少实例 FileID'
    $relinkEvidencePath = Write-JsonReport -Name "$reportPrefix-relink-evidence.json" -Value $relinkEvidence
    Add-PassedStep -Name '解除关联回滚验证' -DurationMs $relinkEvidence.command.durationMs -Evidence $relinkEvidencePath

    # 逐组回滚 verifiedClean（逆序）：还原事务与应用到源事务的逆操作为空，
    # 按阶段二同构判定跳过逐组回滚，源文件由 Git 还原与清理步骤兜底。
    $null = Invoke-TransactionRollback -TransactionId $overrideTxId -Label '覆盖事务回滚'
    $null = Invoke-TransactionRollback -TransactionId $instantiateTxId -Label '实例化事务回滚'
    $skippedRollbackPath = Write-JsonReport -Name "$reportPrefix-skipped-rollbacks.json" -Value ([ordered]@{
        skipped = @(
            [ordered]@{ transactionId = $revertTxId; reason = 'prefab.revert_override 逆操作为空（原覆盖值已丢），保留 before 证据供审计' },
            [ordered]@{ transactionId = $applyTxId; reason = 'prefab.apply_to_source 逆操作为空（源资产已改写），由 Git 还原与清理步骤兜底' }
        )
    })
    Add-PassedStep -Name '逆操作为空事务跳过回滚' -DurationMs 0 -Evidence $skippedRollbackPath

    # 回滚后再验证干净：层级中不再存在场景实例节点，夹具自举节点仍在（由清理步骤统一移除）
    $rolledBackSnapshot = Read-CurrentDocumentSnapshot -ExpectedAssetUuid $sampleDocument.assetUuid -Label '回滚后层级复查'
    $rolledBackPath = Write-RawJsonReport -Name "$reportPrefix-rolled-back-snapshot.json" -RawJson $rolledBackSnapshot.raw
    $rolledBackNodes = Read-FirstPageNodes -Snapshot $rolledBackSnapshot
    foreach ($node in $rolledBackNodes) {
        Assert-Condition -Condition ([string]$node.name -ne $pageInstanceName) -Message '回滚后仍存在场景实例节点'
    }
    foreach ($fixtureName in @($cardRootName, $pageRootName)) {
        $fixtureFound = $false
        foreach ($node in $rolledBackNodes) {
            if ([string]$node.name -eq $fixtureName) {
                $fixtureFound = $true
                break
            }
        }
        Assert-Condition -Condition $fixtureFound -Message '回滚后夹具自举节点缺失'
    }
    $finalTransactionList = Invoke-CliJson -Arguments (@('transaction-list') + $script:selectorArguments) -Label '回滚后 CLI transaction-list'
    Assert-Condition -Condition (@($finalTransactionList.data).Count -eq 0) -Message '回滚后仍存在未完成事务'
    Add-PassedStep -Name '回滚后层级复查干净' -DurationMs $rolledBackSnapshot.command.durationMs -Evidence $rolledBackPath

    # Server 中断恢复证据（独立 JSON）
    $interruptRecoveryPath = Invoke-WriteInterruptRecovery -RootNodeUuid $rootNodeUuid -RootOriginalName $rootOriginalName

    # 夹具清理：删除自举的两个预制体资产（先外层 Page 后内层 Card），场景文件用 git checkout 还原
    $cleanupTxId = "tx-cleanup-$runId"
    $null = Invoke-WriteTransaction -TransactionId $cleanupTxId -Label '夹具清理' -Operations @(
        [ordered]@{ type = 'prefab.delete_asset'; assetUrl = $pagePrefabAssetUrl },
        [ordered]@{ type = 'prefab.delete_asset'; assetUrl = $cardPrefabAssetUrl }
    )
    $finalAssetIndex = Invoke-CliJson -Arguments (@('asset-index') + $script:selectorArguments) -Label '夹具清理后 asset-index'
    foreach ($document in @($finalAssetIndex.data.documents)) {
        Assert-Condition -Condition ([string]$document.path -ne $pagePrefabAssetUrl -and [string]$document.path -ne $cardPrefabAssetUrl) -Message '夹具清理后仍存在自举预制体资产'
    }
    $sceneRestore = Restore-ProjectFileFromGit -RelativePath $sceneRelativePath -Label '场景文件还原'
    Assert-Condition -Condition ($sceneRestore.mode -eq 'git-checkout') -Message '场景文件必须是已跟踪文件并由 git checkout 还原'
    $cleanupPath = Write-JsonReport -Name "$reportPrefix-fixture-cleanup.json" -Value ([ordered]@{
        deletedAssets = @($pagePrefabAssetUrl, $cardPrefabAssetUrl)
        sceneRestore = $sceneRestore
    })
    Add-PassedStep -Name '夹具清理验证' -DurationMs $finalAssetIndex.command.durationMs -Evidence $cleanupPath

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
        skipStatic = [bool]$SkipStatic
        fixture = [ordered]@{
            cardPrefabAssetUrl = $cardPrefabAssetUrl
            pagePrefabAssetUrl = $pagePrefabAssetUrl
            cardRootUuid = $cardRootUuid
            pageRootUuid = $pageRootUuid
            sceneInstanceUuid = $sceneInstanceUuid
            cardPrefabAssetUuid = if ($null -ne $cardPrefab) { $cardPrefab.assetUuid } else { $null }
            pagePrefabAssetUuid = if ($null -ne $pagePrefab) { $pagePrefab.assetUuid } else { $null }
        }
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
            Write-Warning "写入 Phase 3 summary 失败，保留原始验证异常: $summaryWriteFailure"
        } else {
            throw "写入 Phase 3 summary 失败: $summaryWriteFailure"
        }
    }
    Write-Host "Phase 3 报告前缀: $reportPrefix"
    Write-Host "Phase 3 最终状态: $runStatus"
    if ($mainCompletedSuccessfully -and $runStatus -ne 'passed') {
        throw "Phase 3 主流程完成，但收尾失败: $($failure.message)"
    }
}
