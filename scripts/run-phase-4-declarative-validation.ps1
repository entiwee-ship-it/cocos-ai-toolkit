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

# 阶段四脚本依赖 ConvertFrom-Json -AsHashtable 和稳定的原生进程参数行为。
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "阶段四声明式统一验证脚本必须在 pwsh 7+ 运行，当前宿主版本为 $($PSVersionTable.PSVersion)"
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
$reportPrefix = "phase-4-$runId"
$fixtureSuffix = $runId.Replace('-', '_')
$dialogName = "Phase4Dialog_$fixtureSuffix"
$labelName = "Phase4Label_$fixtureSuffix"
$targetName = "Phase4Target_$fixtureSuffix"
$executionId = "phase-4-$runId"
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$script:selectorArguments = $null
$script:managedServer = $null
$selectedEditor = $null
$sampleDocument = $null
$gitStatusBefore = $null
$gitStatusAfter = $null
$targetJson = $null
$apply = $null
$rollbackResults = [Collections.Generic.List[object]]::new()
$steps = [Collections.Generic.List[object]]::new()
$failure = $null
$runStatus = 'running'
$mainCompletedSuccessfully = $false

$env:COCOS_AI_PROBE_SERVER_URL = "ws://127.0.0.1:$Port"
$env:COCOS_AI_PROBE_TIMEOUT_MS = [string]($RequestTimeoutSeconds * 1000)
$env:COCOS_AI_REPORT_ROOT = $reportsRoot
$env:COCOS_AI_PROBE_HOST = '127.0.0.1'
$env:COCOS_AI_PROBE_PORT = [string]$Port
$env:COCOS_AI_PROBE_REPORT_ROOT = $reportsRoot
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
        try { $process.Kill($true) } catch { }
        $null = $process.WaitForExit(10000)
        throw "$Label 超过 $TimeoutSeconds 秒仍未完成"
    }
    $result = [PSCustomObject]@{
        label = $Label
        exitCode = $process.ExitCode
        durationMs = $start.ElapsedMilliseconds
        stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    }
    $start.Stop()
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
        [int]$TimeoutSeconds = 600,
        [switch]$AllowFailure
    )

    $result = Invoke-NativeCommand -FilePath $nodeExe -Arguments (@($cliPath) + $Arguments) -Label $Label -TimeoutSeconds $TimeoutSeconds -AllowFailure:$AllowFailure
    if ($result.exitCode -ne 0) {
        return [PSCustomObject]@{ raw = $null; data = $null; command = $result }
    }
    if ([string]::IsNullOrWhiteSpace($result.stdout)) {
        throw "$Label 未返回 JSON"
    }
    try {
        $data = $result.stdout | ConvertFrom-Json -AsHashtable
    } catch {
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
    Assert-Condition -Condition ($dirtyLines.Count -eq 0) -Message "空白验收项目必须先保持干净，当前改动: $($dirtyLines -join ' | ')"
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

function Find-SampleDocument {
    param([Parameter(Mandatory = $true)][object]$AssetIndex)

    $scenes = @($AssetIndex.documents | Where-Object { [string]$_.documentType -eq 'scene' })
    Assert-Condition -Condition ($scenes.Count -gt 0) -Message '资产索引没有可写场景'
    $preferred = @($scenes | Where-Object { [string]$_.path -eq 'db://assets/phase2-probe.scene' })
    $document = if ($preferred.Count -eq 1) { $preferred[0] } else { $scenes[0] }
    $assetUuid = [string]($document.assetUuid ?? $document.uuid)
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($assetUuid)) -Message '样本文档缺少资产 UUID'
    return [PSCustomObject]@{ assetUuid = $assetUuid; path = [string]$document.path }
}

function Find-Phase2ProbeScript {
    param([Parameter(Mandatory = $true)][object]$AssetIndex)

    $matches = @($AssetIndex.assets | Where-Object {
        [string]$_.type -eq 'cc.Script' -and [string]$_.path -eq 'db://assets/Phase2Probe'
    })
    Assert-Condition -Condition ($matches.Count -eq 1) -Message '资产索引中必须存在唯一的 Phase2Probe.ts 脚本'
    return [PSCustomObject]@{ assetUuid = [string]$matches[0].assetUuid; componentType = 'Phase2Probe' }
}

function Wait-DesignInspect {
    param([Parameter(Mandatory = $true)][string]$ExpectedAssetUuid)

    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $lastError = '尚未取得 design-inspect'
    while ([DateTime]::UtcNow -lt $deadline) {
        $inspect = Invoke-CliJson -Arguments (@('design-inspect') + $script:selectorArguments) -Label '等待 design-inspect' -TimeoutSeconds 60 -AllowFailure
        if ($inspect.command.exitCode -eq 0 -and [string]$inspect.data.document.assetUuid -eq $ExpectedAssetUuid) {
            return $inspect
        }
        $lastError = if ($inspect.command.exitCode -eq 0) { '当前文档身份尚未切换' } else { $inspect.command.stderr }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "等待 design-inspect 超时: $lastError"
}

function Test-DesignNodeName {
    param(
        [Parameter(Mandatory = $true)][object[]]$Nodes,
        [Parameter(Mandatory = $true)][string]$Name
    )

    foreach ($node in $Nodes) {
        if ([string]$node.name -eq $Name) { return $true }
        if (Test-DesignNodeName -Nodes @($node.children) -Name $Name) { return $true }
    }
    return $false
}

function New-DesignTarget {
    param(
        [Parameter(Mandatory = $true)][object]$Root,
        [Parameter(Mandatory = $true)][object]$ScriptAsset,
        [Parameter(Mandatory = $true)][string]$AssetUuid
    )

    # 合同标记：id = '$dialog' / id = '$label' / id = '$target'；引用在执行期解析为真实 UUID。
    return [ordered]@{
        document = [ordered]@{ scope = 'current-document'; assetUuid = $AssetUuid }
        tree = @(
            [ordered]@{
                id = '$scene'
                fileId = [string]$Root.fileId
                path = [string]$Root.path
                name = [string]$Root.name
                children = @(
                    [ordered]@{
                        id = '$dialog'
                        name = $dialogName
                        components = @(
                            [ordered]@{
                                type = 'Phase2Probe'
                                scriptUuid = $ScriptAsset.assetUuid
                                properties = [ordered]@{ probeFlag = $true }
                                references = [ordered]@{ targetNode = '$target' }
                            }
                        )
                        children = @(
                            [ordered]@{
                                id = '$label'
                                name = $labelName
                                components = @(
                                    [ordered]@{
                                        type = 'cc.Label'
                                        properties = [ordered]@{ string = 'Phase 4'; fontSize = 28 }
                                    }
                                )
                            },
                            [ordered]@{ id = '$target'; name = $targetName }
                        )
                    }
                )
            }
        )
        prune = $false
    }
}

function Assert-PlanKinds {
    param([Parameter(Mandatory = $true)][object]$Plan)

    Assert-Condition -Condition (@($Plan.unresolved).Count -eq 0) -Message "声明式计划含 unresolved: $($Plan.unresolved | ConvertTo-Json -Depth 20 -Compress)"
    $kinds = @($Plan.items | ForEach-Object { [string]$_.kind })
    foreach ($kind in @('node.create', 'component.add', 'component.set_property', 'component.set_reference')) {
        Assert-Condition -Condition ($kinds -contains $kind) -Message "声明式计划缺少操作类型: $kind"
    }
}

function Invoke-DesignRollbackChain {
    param(
        [Parameter(Mandatory = $true)][object]$ApplyResult,
        [switch]$AllowFailure
    )

    $ids = @($ApplyResult.transactions | Where-Object { [string]$_.status -eq 'committed' } | ForEach-Object { [string]$_.transactionId } | Select-Object -Unique)
    [Array]::Reverse($ids)
    foreach ($transactionId in $ids) {
        $rollback = Invoke-CliJson -Arguments (@('transaction-rollback') + $script:selectorArguments + @('--transaction-id', $transactionId)) -Label "声明式事务回滚 $transactionId" -AllowFailure:$AllowFailure
        if ($rollback.command.exitCode -ne 0) {
            if ($AllowFailure) { return $false }
            throw "声明式事务回滚失败: $transactionId"
        }
        Assert-Condition -Condition ($rollback.data.status -eq 'rolled-back') -Message "事务回滚状态异常: $transactionId / $($rollback.data.status)"
        Assert-Condition -Condition ($rollback.data.rollbackEvidence.verifiedClean -eq $true) -Message "事务回滚未验证干净: $transactionId"
        $rollbackResults.Add($rollback.data)
    }
    return $true
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
    foreach ($capability in @('probe.assetIndex', 'probe.openAsset', 'probe.documentSnapshot', 'probe.writePrepare', 'probe.writeConfirm', 'probe.transactionRollback')) {
        Assert-Condition -Condition ($selectedEditor.capabilities -contains $capability) -Message "Bridge 缺少阶段四所需能力: $capability"
    }
    $script:selectorArguments = @('--project-id', [string]$selectedEditor.projectId, '--editor-instance-id', [string]$selectedEditor.editorInstanceId)
    Add-PassedStep -Name 'Bridge 连接与声明式能力检查' -DurationMs $connection.command.durationMs -Evidence $editorsPath

    $assetIndex = Invoke-CliJson -Arguments (@('asset-index') + $script:selectorArguments) -Label 'CLI asset-index'
    $assetIndexPath = Write-RawJsonReport -Name "$reportPrefix-asset-index.json" -RawJson $assetIndex.raw
    $sampleDocument = Find-SampleDocument -AssetIndex $assetIndex.data
    $probeScript = Find-Phase2ProbeScript -AssetIndex $assetIndex.data
    Add-PassedStep -Name '资产与脚本夹具定位' -DurationMs $assetIndex.command.durationMs -Evidence $assetIndexPath

    $null = Invoke-CliJson -Arguments (@('open-asset') + $script:selectorArguments + @('--uuid', $sampleDocument.assetUuid)) -Label 'CLI open-asset'
    $inspect = Wait-DesignInspect -ExpectedAssetUuid $sampleDocument.assetUuid
    $inspectPath = Write-RawJsonReport -Name "$reportPrefix-design-inspect.json" -RawJson $inspect.raw
    Assert-Condition -Condition (@($inspect.data.tree).Count -gt 0) -Message 'design-inspect 没有返回场景根节点'
    $sceneRoot = @($inspect.data.tree)[0]
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$sceneRoot.fileId)) -Message '场景根缺少稳定 fileId'
    Assert-Condition -Condition (-not (Test-DesignNodeName -Nodes @($inspect.data.tree) -Name $dialogName)) -Message '运行前已存在同名阶段四夹具'
    Add-PassedStep -Name 'design-inspect 基线' -DurationMs $inspect.command.durationMs -Evidence $inspectPath

    $target = New-DesignTarget -Root $sceneRoot -ScriptAsset $probeScript -AssetUuid $sampleDocument.assetUuid
    $targetJson = $target | ConvertTo-Json -Depth 30 -Compress
    $targetPath = Write-JsonReport -Name "$reportPrefix-design-target.json" -Value $target

    $plan = Invoke-CliJson -Arguments (@('design-plan') + $script:selectorArguments + @('--target', $targetJson)) -Label 'CLI design-plan'
    Assert-PlanKinds -Plan $plan.data
    $planPath = Write-RawJsonReport -Name "$reportPrefix-design-plan.json" -RawJson $plan.raw
    Add-PassedStep -Name 'design-plan 最小差异与排序' -DurationMs $plan.command.durationMs -Evidence $planPath

    $preview = Invoke-CliJson -Arguments (@('design-preview') + $script:selectorArguments + @('--target', $targetJson)) -Label 'CLI design-preview'
    Assert-Condition -Condition ($preview.data.mode -eq 'preview') -Message 'design-preview 模式异常'
    Assert-Condition -Condition ($preview.data.operationCount -eq @($plan.data.items).Count) -Message 'design-preview 操作数量与 plan 不一致'
    $previewPath = Write-RawJsonReport -Name "$reportPrefix-design-preview.json" -RawJson $preview.raw
    Add-PassedStep -Name 'design-preview 零执行预览' -DurationMs $preview.command.durationMs -Evidence $previewPath

    $apply = Invoke-CliJson -Arguments (@('design-apply') + $script:selectorArguments + @('--target', $targetJson, '--execution-id', $executionId)) -Label 'CLI design-apply' -TimeoutSeconds $ValidationTimeoutSeconds
    Assert-Condition -Condition ($apply.data.status -eq 'committed') -Message "design-apply 未完整提交: $($apply.data.status)"
    Assert-Condition -Condition ($apply.data.verification.passed -eq $true) -Message 'design-apply 内嵌逐项验证未通过'
    $applyPath = Write-RawJsonReport -Name "$reportPrefix-design-apply.json" -RawJson $apply.raw
    Add-PassedStep -Name 'design-apply 事务链执行' -DurationMs $apply.command.durationMs -Evidence $applyPath

    $verify = Invoke-CliJson -Arguments (@('design-verify') + $script:selectorArguments + @('--target', $targetJson)) -Label 'CLI design-verify'
    Assert-Condition -Condition ($verify.data.passed -eq $true) -Message 'design-verify 独立验证未通过'
    $verifyPath = Write-RawJsonReport -Name "$reportPrefix-design-verify.json" -RawJson $verify.raw
    Add-PassedStep -Name 'design-verify 独立重读' -DurationMs $verify.command.durationMs -Evidence $verifyPath

    $dialogUuid = [string]$apply.data.resolutions.nodes['$dialog']
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace($dialogUuid)) -Message 'design-apply 未返回 $dialog 真实 UUID'
    $subtreeExport = Invoke-CliJson -Arguments (@('design-export') + $script:selectorArguments + @('--root-uuid', $dialogUuid, '--scope', 'current-document', '--asset-uuid', $sampleDocument.assetUuid)) -Label 'CLI design-export 子树'
    Assert-Condition -Condition (@($subtreeExport.data.tree).Count -eq 1) -Message 'design-export 子树根数量异常'
    $exportPath = Write-RawJsonReport -Name "$reportPrefix-design-export.json" -RawJson $subtreeExport.raw
    Add-PassedStep -Name 'design-export 子树导出' -DurationMs $subtreeExport.command.durationMs -Evidence $exportPath

    $fullExport = Invoke-CliJson -Arguments (@('design-export') + $script:selectorArguments + @('--scope', 'current-document', '--asset-uuid', $sampleDocument.assetUuid)) -Label 'CLI design-export 完整文档'
    $fullExportPath = Write-RawJsonReport -Name "$reportPrefix-design-export-full.json" -RawJson $fullExport.raw
    $exportTargetJson = $fullExport.data | ConvertTo-Json -Depth 100 -Compress
    $roundTripPlan = Invoke-CliJson -Arguments (@('design-plan') + $script:selectorArguments + @('--target', $exportTargetJson)) -Label 'CLI design-export round-trip plan'
    Assert-Condition -Condition (@($roundTripPlan.data.unresolved).Count -eq 0) -Message 'round-trip plan 包含 unresolved'
    Assert-Condition -Condition ($roundTripPlan.data.items.Count -eq 0) -Message 'round-trip plan 不是零差异'
    $roundTripPath = Write-RawJsonReport -Name "$reportPrefix-design-round-trip-plan.json" -RawJson $roundTripPlan.raw
    Add-PassedStep -Name 'design-export round-trip plan' -DurationMs ($fullExport.command.durationMs + $roundTripPlan.command.durationMs) -Evidence $roundTripPath

    $rolledBack = Invoke-DesignRollbackChain -ApplyResult $apply.data
    Assert-Condition -Condition $rolledBack -Message '声明式事务链回滚失败'
    $rollbackPath = Write-JsonReport -Name "$reportPrefix-design-rollbacks.json" -Value $rollbackResults
    Add-PassedStep -Name '声明式事务链逆序回滚' -DurationMs 0 -Evidence $rollbackPath

    $afterRollback = Wait-DesignInspect -ExpectedAssetUuid $sampleDocument.assetUuid
    Assert-Condition -Condition (-not (Test-DesignNodeName -Nodes @($afterRollback.data.tree) -Name $dialogName)) -Message '回滚后仍存在阶段四夹具根节点'
    $afterRollbackPath = Write-RawJsonReport -Name "$reportPrefix-design-after-rollback.json" -RawJson $afterRollback.raw
    Add-PassedStep -Name '回滚后声明式状态复查' -DurationMs $afterRollback.command.durationMs -Evidence $afterRollbackPath

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
    $cleanupFailures = [Collections.Generic.List[string]]::new()
    if ($null -ne $apply -and @($rollbackResults).Count -eq 0) {
        try {
            $rollbackSucceeded = Invoke-DesignRollbackChain -ApplyResult $apply.data -AllowFailure
            if (-not $rollbackSucceeded) {
                $cleanupFailures.Add('自动事务回滚未完整成功')
            }
        } catch {
            $cleanupFailures.Add("自动事务回滚异常: $($_.Exception.Message)")
        }
    }
    if ($cleanupFailures.Count -gt 0 -or ($null -ne $failure -and $null -ne $apply)) {
        try {
            $null = Write-JsonReport -Name "$reportPrefix-recovery-required.json" -Value ([ordered]@{
                schemaVersion = 1
                status = 'recovery-required'
                executionId = $executionId
                projectPath = $project
                document = $sampleDocument
                transactions = if ($null -ne $apply) { $apply.data.transactions } else { @() }
                rollbackResults = $rollbackResults
                cleanupFailures = $cleanupFailures
                instruction = '禁止继续写入；核对 transaction-status 后逆序回滚，必要时在确认项目基线干净后用 Git 还原目标文档。'
            })
        } catch {
            $cleanupFailures.Add("恢复报告写入失败: $($_.Exception.Message)")
        }
    }

    try {
        Stop-ManagedProbeServer -Control $script:managedServer
    } catch {
        $cleanupFailures.Add("Probe Server 清理失败: $($_.Exception.Message)")
    }
    try {
        Get-ChildItem -LiteralPath $reportsRoot -Filter "$reportPrefix-*.tmp" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    } catch {
        $cleanupFailures.Add("临时文件清理失败: $($_.Exception.Message)")
    }
    if ($null -eq $gitStatusAfter -and $null -ne $gitStatusBefore) {
        try {
            $gitStatusAfter = [ordered]@{
                toolkit = Get-GitStatusSnapshot -RepositoryPath $repoRoot -Label '失败后记录工具仓库状态'
                project = Get-GitStatusSnapshot -RepositoryPath $project -Label '失败后记录 Creator 项目状态'
            }
            $null = Write-JsonReport -Name "$reportPrefix-git-status-after.json" -Value $gitStatusAfter
        } catch {
            $cleanupFailures.Add("失败后 Git 状态记录失败: $($_.Exception.Message)")
        }
    }

    if ($cleanupFailures.Count -gt 0 -and $null -eq $failure) {
        $failure = [ordered]@{ message = $cleanupFailures -join '；' }
        $runStatus = 'failed'
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
        fixture = [ordered]@{ dialogName = $dialogName; labelName = $labelName; targetName = $targetName }
        executionId = $executionId
        gitStatusBefore = $gitStatusBefore
        gitStatusAfter = $gitStatusAfter
        rollbackResults = $rollbackResults
        cleanupFailures = $cleanupFailures
        steps = $steps
        failure = $failure
    }
    try {
        $null = Write-JsonReport -Name "$reportPrefix-summary.json" -Value $summary
    } catch {
        if ($null -ne $failure) {
            Write-Warning "写入 Phase 4 summary 失败，保留原始验证异常: $($_.Exception.Message)"
        } else {
            throw
        }
    }
    Write-Host "Phase 4 报告前缀: $reportPrefix"
    Write-Host "Phase 4 最终状态: $runStatus"
    if ($mainCompletedSuccessfully -and $runStatus -ne 'passed') {
        throw "Phase 4 主流程完成，但收尾失败: $($failure.message)"
    }
}
