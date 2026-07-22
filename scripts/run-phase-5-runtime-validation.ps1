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
    [int]$ValidationTimeoutSeconds = 1800,

    [ValidateRange(25, 5000)]
    [int]$PollIntervalMilliseconds = 200,

    # 重复进行 Creator 联调时可跳过静态检查；构建产物存在性检查始终执行。
    [switch]$SkipStatic
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 阶段五脚本依赖 ConvertFrom-Json -AsHashtable 和稳定的原生进程参数行为。
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "阶段五运行态统一验证脚本必须在 pwsh 7+ 运行，当前宿主版本为 $($PSVersionTable.PSVersion)"
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
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$npmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
$gitExe = (Get-Command git -ErrorAction Stop).Source
$runId = '{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$reportPrefix = "phase-5-$runId"
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$script:managedServer = $null
$script:previewSessionId = $null
$selectedEditor = $null
$gitStatusBefore = $null
$gitStatusAfter = $null
$steps = [Collections.Generic.List[object]]::new()
$failure = $null
$runStatus = 'running'
$mainCompletedSuccessfully = $false

$env:COCOS_AI_PROBE_SERVER_URL = "ws://127.0.0.1:$Port"
$env:COCOS_AI_PROBE_TIMEOUT_MS = [string]($RequestTimeoutSeconds * 1000)
$env:COCOS_AI_REPORT_ROOT = $reportsRoot
$env:COCOS_AI_PROBE_HOST = '127.0.0.1'
$env:COCOS_AI_PROBE_PORT = [string]$Port
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
        [AllowNull()]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return $null -ne $Value -and $Value -is [Collections.IDictionary] -and $Value.Contains($Name)
}

function Write-JsonReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [AllowNull()]
        [object]$Value
    )

    $path = Join-Path $reportsRoot $Name
    ($Value | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $path -Encoding utf8
    return $path
}

function Write-RawJsonReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$RawJson
    )

    $path = Join-Path $reportsRoot $Name
    Set-Content -LiteralPath $path -Value $RawJson -Encoding utf8
    return $path
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
    $timedOut = $false
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $timedOut = $true
        try { $process.Kill($true) } catch { }
        if (-not $process.WaitForExit(10000)) {
            throw "$Label 超时后无法终止子进程"
        }
    }
    $start.Stop()
    $result = [PSCustomObject]@{
        label = $Label
        exitCode = if ($timedOut) { -1 } elseif ($process.HasExited) { $process.ExitCode } else { -1 }
        timedOut = $timedOut
        durationMs = $start.ElapsedMilliseconds
        stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    }
    if ($timedOut) {
        if (-not $AllowFailure) {
            throw "$Label 超过 $TimeoutSeconds 秒仍未完成。stdout: $($result.stdout) stderr: $($result.stderr)"
        }
        return $result
    }
    if ($result.exitCode -ne 0 -and -not $AllowFailure) {
        throw "$Label 失败，退出码 $($result.exitCode)。stdout: $($result.stdout) stderr: $($result.stderr)"
    }
    return $result
}

function Invoke-CliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [int]$TimeoutSeconds = 600,
        [switch]$AllowFailure
    )

    $result = Invoke-NativeCommand -FilePath $nodeExe -Arguments (@($cliPath) + $Arguments) -Label $Label -TimeoutSeconds $TimeoutSeconds -AllowFailure:$AllowFailure
    if ([string]::IsNullOrWhiteSpace($result.stdout)) {
        if ($result.exitCode -ne 0) {
            return [PSCustomObject]@{ raw = $result.stdout; data = $null; command = $result }
        }
        throw "$Label 未返回 JSON"
    }
    try {
        $data = $result.stdout | ConvertFrom-Json -AsHashtable
    } catch {
        if ($AllowFailure -and $result.exitCode -ne 0) {
            return [PSCustomObject]@{ raw = $result.stdout; data = $null; command = $result }
        }
        throw "$Label 返回的内容不是有效 JSON: $($result.stdout)"
    }
    return [PSCustomObject]@{ raw = $result.stdout; data = $data; command = $result }
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

function Assert-CleanProjectStatus {
    param([Parameter(Mandatory = $true)][string]$Status)

    $dirtyLines = @($Status -split "`r?`n" | Where-Object { $_ -and -not $_.StartsWith('#', [StringComparison]::Ordinal) })
    Assert-Condition -Condition ($dirtyLines.Count -eq 0) -Message "验收项目必须先保持干净，当前改动: $($dirtyLines -join ' | ')"
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
    return [PSCustomObject]@{ processId = $processIds[0]; url = "ws://127.0.0.1:$Port" }
}

function Start-ManagedProbeServer {
    $existing = Get-ProbeServerListener -AllowMissing
    if ($null -ne $existing) {
        return [PSCustomObject]@{ startedByValidation = $false; listener = $existing; process = $null }
    }

    $stdoutPath = Join-Path $reportsRoot "$reportPrefix-probe-server.stdout.log"
    $stderrPath = Join-Path $reportsRoot "$reportPrefix-probe-server.stderr.log"
    $process = Start-Process -FilePath $nodeExe -ArgumentList @($probeServerEntryPath) -WorkingDirectory $repoRoot `
        -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) {
            $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath) } else { '' }
            throw "Probe Server 在 Ready 前退出，退出码 $($process.ExitCode): $stderr"
        }
        $listener = Get-ProbeServerListener -AllowMissing
        if ($null -ne $listener) {
            Assert-Condition -Condition ($listener.processId -eq $process.Id) -Message '监听进程不是本次启动的 Probe Server'
            return [PSCustomObject]@{
                startedByValidation = $true
                listener = $listener
                process = $process
                stdoutPath = $stdoutPath
                stderrPath = $stderrPath
            }
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    try { $process.Kill($true) } catch { }
    throw '等待 Probe Server Ready 超时'
}

function Stop-ManagedProbeServer {
    param([AllowNull()][object]$Control)

    if ($null -eq $Control -or -not $Control.startedByValidation) { return }
    $listener = Get-ProbeServerListener -AllowMissing
    if ($null -ne $listener) {
        Assert-Condition -Condition ($listener.processId -eq $Control.process.Id) -Message 'Probe Server PID 已变化，拒绝终止未知进程'
        Stop-Process -Id $listener.processId -Force -ErrorAction Stop
    }
    try { Wait-Process -Id $Control.process.Id -Timeout 10 -ErrorAction SilentlyContinue } catch { }
}

function Find-EditorByProjectPath {
    param([Parameter(Mandatory = $true)][object[]]$Editors)

    $matches = @($Editors | Where-Object {
        (Test-ObjectProperty -Value $_ -Name 'projectPath') -and
        [IO.Path]::GetFullPath([string]$_.projectPath).Equals($project, [StringComparison]::OrdinalIgnoreCase)
    })
    Assert-Condition -Condition ($matches.Count -eq 1) -Message "未找到唯一的目标 Creator 实例: $project"
    return $matches[0]
}

function Wait-EditorConnection {
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $lastError = '尚未连接'
    while ([DateTime]::UtcNow -lt $deadline) {
        $result = Invoke-CliJson -Arguments @('editors') -Label '等待 Creator Bridge 连接' -TimeoutSeconds 30 -AllowFailure
        if ($result.command.exitCode -eq 0) {
            try {
                return [PSCustomObject]@{ editor = Find-EditorByProjectPath -Editors @($result.data); command = $result.command; raw = $result.raw }
            } catch {
                $lastError = $_.Exception.Message
            }
        } else {
            $lastError = $result.command.stderr
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "等待 Creator Bridge 连接超时: $lastError"
}

function Assert-PngFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [int]$MinWidth,
        [Parameter(Mandatory = $true)]
        [int]$MinHeight
    )

    Assert-Condition -Condition (Test-Path -LiteralPath $Path -PathType Leaf) -Message "截图文件不存在: $Path"
    $bytes = [IO.File]::ReadAllBytes($Path)
    Assert-Condition -Condition ($bytes.Length -gt 24) -Message "截图文件过小: $Path"
    $signature = [Text.Encoding]::ASCII.GetString($bytes[1..3])
    Assert-Condition -Condition ($signature -eq 'PNG') -Message "截图不是 PNG: $Path"
    $widthBytes = @($bytes[16..19])
    [Array]::Reverse($widthBytes)
    $width = [BitConverter]::ToInt32($widthBytes, 0)
    $heightBytes = @($bytes[20..23])
    [Array]::Reverse($heightBytes)
    $height = [BitConverter]::ToInt32($heightBytes, 0)
    Assert-Condition -Condition ($width -ge $MinWidth -and $height -ge $MinHeight) -Message "截图尺寸异常: ${width}x${height}（要求至少 ${MinWidth}x${MinHeight}）"
}

function Stop-PreviewSessionSafely {
    if ([string]::IsNullOrWhiteSpace($script:previewSessionId)) { return }
    try {
        Invoke-CliJson -Arguments @('preview-stop', '--session-id', $script:previewSessionId) -Label '兜底停止 Preview 会话' -TimeoutSeconds 30 -AllowFailure | Out-Null
    } catch { }
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
    Assert-CleanProjectStatus -Status $gitStatusBefore.project
    $gitBeforePath = Write-JsonReport -Name "$reportPrefix-git-status-before.json" -Value $gitStatusBefore

    if (-not $SkipStatic) {
        $npmTest = Invoke-NativeCommand -FilePath $npmExe -Arguments @('test') -Label 'npm test' -TimeoutSeconds $ValidationTimeoutSeconds
        Add-PassedStep -Name 'npm test' -DurationMs $npmTest.durationMs -Evidence (Write-JsonReport -Name "$reportPrefix-npm-test.json" -Value $npmTest)

        $npmTypecheck = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'typecheck') -Label 'npm run typecheck' -TimeoutSeconds $ValidationTimeoutSeconds
        Add-PassedStep -Name 'npm run typecheck' -DurationMs $npmTypecheck.durationMs -Evidence (Write-JsonReport -Name "$reportPrefix-npm-typecheck.json" -Value $npmTypecheck)

        $npmBuild = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'build') -Label 'npm run build' -TimeoutSeconds $ValidationTimeoutSeconds
        Add-PassedStep -Name 'npm run build' -DurationMs $npmBuild.durationMs -Evidence (Write-JsonReport -Name "$reportPrefix-npm-build.json" -Value $npmBuild)
    } else {
        Add-PassedStep -Name '静态检查跳过（-SkipStatic）' -DurationMs 0 -Evidence (Write-JsonReport -Name "$reportPrefix-static-skipped.json" -Value @{ skipped = $true })
    }
    foreach ($path in @($cliPath, $probeServerEntryPath)) {
        Assert-Condition -Condition (Test-Path -LiteralPath $path -PathType Leaf) -Message "构建产物不存在: $path"
    }

    $script:managedServer = Start-ManagedProbeServer
    $connection = Wait-EditorConnection
    $selectedEditor = $connection.editor
    $editorsPath = Write-RawJsonReport -Name "$reportPrefix-editors.json" -RawJson $connection.raw
    Assert-Condition -Condition ($selectedEditor.creatorVersion -eq '3.8.8') -Message "当前只认证 Creator 3.8.8，实际为 $($selectedEditor.creatorVersion)"
    foreach ($capability in @('probe.previewOpen', 'probe.previewStatus')) {
        Assert-Condition -Condition ($selectedEditor.capabilities -contains $capability) -Message "Bridge 缺少阶段五所需能力: $capability"
    }
    $script:selectorArguments = @('--project-id', [string]$selectedEditor.projectId, '--editor-instance-id', [string]$selectedEditor.editorInstanceId)
    Add-PassedStep -Name 'Bridge 连接与运行态能力检查' -DurationMs $connection.command.durationMs -Evidence $editorsPath

    # Preview 生命周期：启动并等待游戏就绪
    $launch = Invoke-CliJson -Arguments (@('preview-launch') + $script:selectorArguments) -Label 'CLI preview-launch' -TimeoutSeconds $ReadyTimeoutSeconds
    Assert-Condition -Condition ($launch.data.state -eq 'ready') -Message "Preview 会话未进入 ready: $($launch.data.state)"
    Assert-Condition -Condition ([string]$launch.data.url).StartsWith('http://127.0.0.1:') -Message "Preview URL 未规范化为回环地址: $($launch.data.url)"
    Assert-Condition -Condition ($launch.data.pageSource -eq 'self-launched') -Message 'pageSource 必须是 self-launched'
    $script:previewSessionId = [string]$launch.data.sessionId
    $launchPath = Write-RawJsonReport -Name "$reportPrefix-preview-launch.json" -RawJson $launch.raw
    Add-PassedStep -Name 'preview-launch 会话就绪' -DurationMs $launch.command.durationMs -Evidence $launchPath

    $sessions = Invoke-CliJson -Arguments @('preview-sessions', '--project-id', [string]$selectedEditor.projectId) -Label 'CLI preview-sessions'
    Assert-Condition -Condition (@($sessions.data | Where-Object { $_.sessionId -eq $script:previewSessionId -and $_.state -eq 'ready' }).Count -eq 1) -Message 'preview-sessions 未列出就绪会话'
    $sessionsPath = Write-RawJsonReport -Name "$reportPrefix-preview-sessions.json" -RawJson $sessions.raw
    Add-PassedStep -Name 'preview-sessions 会话登记' -DurationMs $sessions.command.durationMs -Evidence $sessionsPath

    # 运行时层级与组件读取
    $hierarchy = Invoke-CliJson -Arguments @('runtime-hierarchy', '--session-id', $script:previewSessionId, '--max-depth', '8') -Label 'CLI runtime-hierarchy' -TimeoutSeconds $ReadyTimeoutSeconds
    Assert-Condition -Condition ($hierarchy.data.source -eq 'preview-runtime') -Message '层级快照 source 必须是 preview-runtime'
    Assert-Condition -Condition ([string]$hierarchy.data.root.name).Length -gt 0 -Message '层级快照根节点名为空'
    Assert-Condition -Condition ($hierarchy.data.root.dynamic -eq $false) -Message '场景根节点不应标记为动态创建'
    $hierarchyPath = Write-RawJsonReport -Name "$reportPrefix-runtime-hierarchy.json" -RawJson $hierarchy.raw
    Add-PassedStep -Name 'runtime-hierarchy 层级读取' -DurationMs $hierarchy.command.durationMs -Evidence $hierarchyPath

    $sceneName = [string]$hierarchy.data.root.name
    $rootChildren = @($hierarchy.data.root.children)
    $probePath = $sceneName
    $probeComponentType = 'UITransform'
    if ($rootChildren.Count -gt 0) {
        $probePath = "$sceneName/$([string]$rootChildren[0].name)"
        $childComponents = @($rootChildren[0].components)
        if ($childComponents.Count -gt 0 -and [string]$childComponents[0].type) {
            $probeComponentType = [string]$childComponents[0].type
        }
    } elseif (@($hierarchy.data.root.components).Count -gt 0) {
        $probeComponentType = [string]@($hierarchy.data.root.components)[0].type
    }
    $component = Invoke-CliJson -Arguments @('runtime-component', '--session-id', $script:previewSessionId, '--path', $probePath, '--component-type', "cc.$($probeComponentType -replace '^cc\.', '')") -Label 'CLI runtime-component'
    Assert-Condition -Condition ($component.data.found -eq $true -or (Test-ObjectProperty -Value $component.data -Name 'properties')) -Message "组件读取失败: $($component.raw)"
    $componentPath = Write-RawJsonReport -Name "$reportPrefix-runtime-component.json" -RawJson $component.raw
    Add-PassedStep -Name 'runtime-component 组件读取' -DurationMs $component.command.durationMs -Evidence $componentPath

    # 方法调用与属性监听（目标组件必须有 UITransform 才执行尺寸改写）
    $invokeTarget = Invoke-CliJson -Arguments @('runtime-component', '--session-id', $script:previewSessionId, '--path', $probePath, '--component-type', 'cc.UITransform') -Label 'CLI runtime-component UITransform' -AllowFailure
    if ($invokeTarget.command.exitCode -eq 0 -and $invokeTarget.data.found -eq $true) {
        $invoke = Invoke-CliJson -Arguments @('runtime-invoke', '--session-id', $script:previewSessionId, '--path', $probePath, '--component-type', 'cc.UITransform', '--method', 'setContentSize', '--args', '[321,222]') -Label 'CLI runtime-invoke'
        Assert-Condition -Condition ($invoke.data.invoked -eq $true) -Message 'invoke 未确认调用'
        $afterInvoke = Invoke-CliJson -Arguments @('runtime-component', '--session-id', $script:previewSessionId, '--path', $probePath, '--component-type', 'cc.UITransform') -Label 'CLI runtime-component 复核'
        Assert-Condition -Condition ($afterInvoke.data.properties._contentSize.width -eq 321 -and $afterInvoke.data.properties._contentSize.height -eq 222) -Message "invoke 未真实生效: $($afterInvoke.raw)"
        $invokePath = Write-RawJsonReport -Name "$reportPrefix-runtime-invoke.json" -RawJson $invoke.raw
        Add-PassedStep -Name 'runtime-invoke 调用并重读生效' -DurationMs ($invoke.command.durationMs + $afterInvoke.command.durationMs) -Evidence $invokePath

        $watchTimeout = Invoke-CliJson -Arguments @('runtime-watch', '--session-id', $script:previewSessionId, '--path', $probePath, '--component-type', 'cc.UITransform', '--property', '_contentSize.width', '--interval-ms', '100', '--timeout-ms', '1500') -Label 'CLI runtime-watch 恒定超时'
        Assert-Condition -Condition ($watchTimeout.data.timedOut -eq $true -and $watchTimeout.data.initialValue -eq 321) -Message "watch 恒定形态异常: $($watchTimeout.raw)"
        $watchTimeoutPath = Write-RawJsonReport -Name "$reportPrefix-runtime-watch-timeout.json" -RawJson $watchTimeout.raw
        Add-PassedStep -Name 'runtime-watch 恒定超时形态' -DurationMs $watchTimeout.command.durationMs -Evidence $watchTimeoutPath

        $resize = Invoke-CliJson -Arguments @('runtime-invoke', '--session-id', $script:previewSessionId, '--path', $probePath, '--component-type', 'cc.UITransform', '--method', 'setContentSize', '--args', '[654,222]') -Label 'CLI runtime-invoke 改值'
        $watchChanged = Invoke-CliJson -Arguments @('runtime-watch', '--session-id', $script:previewSessionId, '--path', $probePath, '--component-type', 'cc.UITransform', '--property', '_contentSize.width', '--interval-ms', '100', '--timeout-ms', '1500') -Label 'CLI runtime-watch 新初值'
        Assert-Condition -Condition ($watchChanged.data.initialValue -eq 654) -Message "watch 未读到改后初值: $($watchChanged.raw)"
        $watchChangedPath = Write-RawJsonReport -Name "$reportPrefix-runtime-watch-changed.json" -RawJson $watchChanged.raw
        Add-PassedStep -Name 'runtime-watch 改值后初值更新' -DurationMs ($resize.command.durationMs + $watchChanged.command.durationMs) -Evidence $watchChangedPath
    } else {
        Add-PassedStep -Name 'runtime-invoke/watch 跳过（目标无 UITransform）' -DurationMs 0 -Evidence (Write-JsonReport -Name "$reportPrefix-runtime-invoke-skipped.json" -Value @{ skipped = $true; path = $probePath })
    }

    # 输入模拟
    $tap = Invoke-CliJson -Arguments @('runtime-input', '--session-id', $script:previewSessionId, '--input-type', 'tap', '--x', '100', '--y', '100') -Label 'CLI runtime-input tap'
    Assert-Condition -Condition ($tap.data.dispatched -eq $true -and $tap.data.pageX -ge 100 -and $tap.data.pageY -ge 100) -Message "tap 回执坐标换算异常: $($tap.raw)"
    $key = Invoke-CliJson -Arguments @('runtime-input', '--session-id', $script:previewSessionId, '--input-type', 'key', '--key', 'Escape') -Label 'CLI runtime-input key'
    Assert-Condition -Condition ($key.data.dispatched -eq $true) -Message 'key 派发未确认'
    $inputPath = Write-JsonReport -Name "$reportPrefix-runtime-input.json" -Value @{ tap = $tap.data; key = $key.data }
    Add-PassedStep -Name 'runtime-input 坐标换算与按键派发' -DurationMs ($tap.command.durationMs + $key.command.durationMs) -Evidence $inputPath

    # Console 捕获
    $console = Invoke-CliJson -Arguments @('runtime-console', '--session-id', $script:previewSessionId) -Label 'CLI runtime-console 全量'
    Assert-Condition -Condition ($console.data.nextSeq -ge @($console.data.entries).Count) -Message 'console 游标小于条目数'
    $consoleError = Invoke-CliJson -Arguments @('runtime-console', '--session-id', $script:previewSessionId, '--level', 'error') -Label 'CLI runtime-console error 过滤'
    Assert-Condition -Condition (@($consoleError.data.entries | Where-Object { $_.level -ne 'error' }).Count -eq 0) -Message 'error 级别过滤混入其它级别'
    $consolePath = Write-JsonReport -Name "$reportPrefix-runtime-console.json" -Value @{ all = $console.data; error = $consoleError.data }
    Add-PassedStep -Name 'runtime-console 全量/过滤/游标' -DurationMs ($console.command.durationMs + $consoleError.command.durationMs) -Evidence $consolePath

    # 截图与视觉验证
    $capture = Invoke-CliJson -Arguments @('runtime-capture', '--session-id', $script:previewSessionId) -Label 'CLI runtime-capture 默认'
    Assert-Condition -Condition (@($capture.data.files).Count -eq 1) -Message '默认截图文件数异常'
    Assert-PngFile -Path ([string]$capture.data.files[0].path) -MinWidth 100 -MinHeight 100
    $capturePath = Write-RawJsonReport -Name "$reportPrefix-runtime-capture.json" -RawJson $capture.raw
    Add-PassedStep -Name 'runtime-capture 默认截图落盘' -DurationMs $capture.command.durationMs -Evidence $capturePath

    $multi = Invoke-CliJson -Arguments @('runtime-capture', '--session-id', $script:previewSessionId, '--resolutions', '[{"width":720,"height":1280},{"width":1280,"height":720}]') -Label 'CLI runtime-capture 多分辨率' -TimeoutSeconds $ReadyTimeoutSeconds
    Assert-Condition -Condition (@($multi.data.files).Count -eq 2) -Message '多分辨率截图数量异常'
    Assert-Condition -Condition ($multi.data.files[0].requestedResolution.width -eq 720 -and $multi.data.files[1].requestedResolution.width -eq 1280) -Message '多分辨率请求值回传异常'
    foreach ($file in @($multi.data.files)) {
        Assert-PngFile -Path ([string]$file.path) -MinWidth 100 -MinHeight 100
    }
    $multiPath = Write-RawJsonReport -Name "$reportPrefix-runtime-capture-multi.json" -RawJson $multi.raw
    Add-PassedStep -Name 'runtime-capture 多分辨率' -DurationMs $multi.command.durationMs -Evidence $multiPath

    # 差异基准图：必须在多分辨率切换之后补拍（与场景验证 capture 步骤同分辨率、无叠加）
    $baselineCapture = Invoke-CliJson -Arguments @('runtime-capture', '--session-id', $script:previewSessionId) -Label 'CLI runtime-capture 差异基准'
    Assert-PngFile -Path ([string]$baselineCapture.data.files[0].path) -MinWidth 100 -MinHeight 100
    $baselineCapturePath = Write-RawJsonReport -Name "$reportPrefix-runtime-capture-baseline.json" -RawJson $baselineCapture.raw
    Add-PassedStep -Name 'runtime-capture 差异基准图' -DurationMs $baselineCapture.command.durationMs -Evidence $baselineCapturePath

    $overlayCapture = Invoke-CliJson -Arguments @('runtime-capture', '--session-id', $script:previewSessionId, '--overlay-nodes', $probePath, '--overlay-anchors', $probePath) -Label 'CLI runtime-capture 叠加'
    Assert-PngFile -Path ([string]$overlayCapture.data.files[0].path) -MinWidth 100 -MinHeight 100
    Assert-Condition -Condition ($overlayCapture.data.files[0].overlays.nodeBounds -eq $true -and $overlayCapture.data.files[0].overlays.anchors -eq $true) -Message '叠加回执未确认'
    $overlayPath = Write-RawJsonReport -Name "$reportPrefix-runtime-capture-overlay.json" -RawJson $overlayCapture.raw
    Add-PassedStep -Name 'runtime-capture 边界锚点叠加' -DurationMs $overlayCapture.command.durationMs -Evidence $overlayPath

    # 自动场景验证（图像差异基准取基准图截图的相对路径：<sessionId>/<文件名>）
    $evidenceSegments = ([string]$baselineCapture.data.files[0].path) -split '[\\/]'
    $baselineRelative = ($evidenceSegments[-2..-1] -join '/')
    $scenarioSteps = @(
        @{ kind = 'launch' },
        @{ kind = 'wait-node'; path = $probePath; timeoutMs = 10000 },
        @{ kind = 'assert-property'; path = $probePath; property = 'UITransform._enabled'; expected = $true },
        @{ kind = 'dispatch-input'; inputType = 'tap'; x = 100; y = 100 },
        @{ kind = 'assert-console'; pattern = 'Init'; timeoutMs = 3000 },
        @{ kind = 'capture' },
        @{ kind = 'assert-image-diff'; baselinePath = $baselineRelative; threshold = 0.0 }
    ) | ConvertTo-Json -Depth 10 -Compress
    if ($scenarioSteps -notmatch '^\[') {
        $scenarioSteps = "[$scenarioSteps]"
    }
    $scenario = Invoke-CliJson -Arguments (@('runtime-scenario', '--session-id', $script:previewSessionId, '--steps', $scenarioSteps)) -Label 'CLI runtime-scenario' -TimeoutSeconds $ValidationTimeoutSeconds
    Assert-Condition -Condition ($scenario.data.passed -eq $true) -Message "场景验证未通过: $($scenario.raw)"
    Assert-Condition -Condition (@($scenario.data.steps).Count -eq 7) -Message '场景报告步骤数异常'
    $scenarioPath = Write-RawJsonReport -Name "$reportPrefix-runtime-scenario.json" -RawJson $scenario.raw
    Add-PassedStep -Name 'runtime-scenario 全链路七步编排' -DurationMs $scenario.command.durationMs -Evidence $scenarioPath

    # Preview 停止与停止后行为
    $stop = Invoke-CliJson -Arguments @('preview-stop', '--session-id', $script:previewSessionId) -Label 'CLI preview-stop'
    Assert-Condition -Condition ($stop.data.closed -eq $true) -Message 'preview-stop 未确认关闭'
    $stopPath = Write-RawJsonReport -Name "$reportPrefix-preview-stop.json" -RawJson $stop.raw
    Add-PassedStep -Name 'preview-stop 会话关闭' -DurationMs $stop.command.durationMs -Evidence $stopPath

    $afterStop = Invoke-CliJson -Arguments @('runtime-hierarchy', '--session-id', $script:previewSessionId) -Label 'CLI runtime-hierarchy 停止后' -AllowFailure
    Assert-Condition -Condition ($afterStop.command.exitCode -ne 0 -and ([string]$afterStop.command.stderr + [string]$afterStop.raw) -match 'PREVIEW_SESSION_CLOSED') -Message "停止后会话未拒绝读取: $($afterStop.raw) $($afterStop.command.stderr)"
    Add-PassedStep -Name '停止后会话拒绝读取' -DurationMs $afterStop.command.durationMs -Evidence (Write-JsonReport -Name "$reportPrefix-runtime-after-stop.json" -Value @{ exitCode = $afterStop.command.exitCode; stderr = $afterStop.command.stderr })
    $script:previewSessionId = $null

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
    $failure = [PSCustomObject]@{
        message = $_.Exception.Message
        scriptStackTrace = $_.ScriptStackTrace
    }
    if ($runStatus -eq 'running') {
        $runStatus = 'failed'
    }
} finally {
    Stop-PreviewSessionSafely
    Stop-ManagedProbeServer -Control $script:managedServer

    $summary = [ordered]@{
        runId = $runId
        phase = 'phase-5-runtime-visual'
        status = $runStatus
        project = $project
        startedAt = $startedAt
        finishedAt = (Get-Date).ToUniversalTime().ToString('o')
        steps = $steps
        failure = $failure
        git = [ordered]@{
            before = $gitStatusBefore
            after = $gitStatusAfter
        }
        previewSessionId = $script:previewSessionId
    }
    $summaryPath = Write-JsonReport -Name "$reportPrefix-summary.json" -Value $summary
    Write-Host "阶段五运行态统一验证 $runStatus，报告: $summaryPath"
    if (-not $mainCompletedSuccessfully) {
        exit 1
    }
}
