[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ProjectId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EditorInstanceId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SampleNodeUuid,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SampleComponentUuid,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$NestedPrefabNodeUuid,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TestPrefabUuid,

    [string]$AssetPattern = 'ClubView',
    [string]$RealProjectPath = 'E:/xile-workspace/qyProject/xy-client',
    [string]$IsolatedProjectPath = 'E:/xile-workspace/worktrees/xy-client-cocos-ai-probe',

    [ValidateRange(10, 600)]
    [int]$ReadyTimeoutSeconds = 120,

    [ValidateRange(100, 5000)]
    [int]$PollIntervalMilliseconds = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$reportsRoot = Join-Path $repoRoot 'reports'
$cliPath = Join-Path $repoRoot 'packages/cli/dist/index.js'
$realProject = (Resolve-Path -LiteralPath $RealProjectPath).Path
$isolatedProject = (Resolve-Path -LiteralPath $IsolatedProjectPath).Path
$worktreeRoot = [IO.Path]::GetFullPath('E:/xile-workspace/worktrees')
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$npmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
$gitExe = (Get-Command git -ErrorAction Stop).Source
$runId = '{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$reportPrefix = "phase-0-$runId"
$probeName = "CocosAiProbe_$($runId.Replace('-', '_'))"
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$steps = [Collections.Generic.List[object]]::new()
$gitStatusBefore = $null
$gitStatusAfter = $null
$prefabSha256Before = $null
$prefabSha256After = $null
$transactionSummary = $null
$failure = $null
$runStatus = 'running'

New-Item -ItemType Directory -Force -Path $reportsRoot | Out-Null

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
}

function Write-JsonReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 100
    Write-ReportFile -Name $Name -Content $json
}

function Write-RawJsonReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$RawJson
    )

    $null = $RawJson | ConvertFrom-Json
    Write-ReportFile -Name $Name -Content $RawJson
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Label
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
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $start.Stop()

    if ($process.ExitCode -ne 0) {
        throw "$Label 失败，退出码 $($process.ExitCode)。stdout: $($stdout.Trim()) stderr: $($stderr.Trim())"
    }

    [PSCustomObject]@{
        label = $Label
        exitCode = $process.ExitCode
        durationMs = $start.ElapsedMilliseconds
        stdout = $stdout.Trim()
        stderr = $stderr.Trim()
    }
}

function Invoke-CliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $result = Invoke-NativeCommand -FilePath $nodeExe -Arguments (@($cliPath) + $Arguments) -Label $Label
    if ([string]::IsNullOrWhiteSpace($result.stdout)) {
        throw "$Label 未返回 JSON"
    }
    try {
        $data = $result.stdout | ConvertFrom-Json
    } catch {
        throw "$Label 返回的内容不是有效 JSON: $($result.stdout)"
    }
    [PSCustomObject]@{
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
        [long]$DurationMs
    )

    $steps.Add([PSCustomObject]@{
        name = $Name
        status = 'passed'
        durationMs = $DurationMs
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
    })
}

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

function Test-PathWithin {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChildPath,
        [Parameter(Mandatory = $true)]
        [string]$ParentPath
    )

    $child = [IO.Path]::GetFullPath($ChildPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $parent = [IO.Path]::GetFullPath($ParentPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $child.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or
        $child.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Get-GitStatusSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectPath,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $result = Invoke-NativeCommand -FilePath $gitExe -Arguments @('-C', $ProjectPath, 'status', '--short', '--branch') -Label $Label
    return $result.stdout
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

function Wait-TargetAsset {
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $lastReason = '尚未执行 query-asset-info'
    while ([DateTime]::UtcNow -lt $deadline) {
        # assets --uuid 会进入 Creator asset-db/query-asset-info；CLI 失败立即抛出，只重试成功响应中的未就绪状态。
        $probe = Invoke-CliJson -Arguments (@('assets') + $selectorArguments + @('--pattern', $AssetPattern, '--uuid', $TestPrefabUuid)) -Label '等待目标 Prefab query-asset-info'
        if ($null -ne $probe.data.details -and $probe.data.details.uuid -eq $TestPrefabUuid) {
            return $probe
        }
        $lastReason = 'query-asset-info 尚未返回目标 UUID'
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "等待目标 Prefab 超时: $lastReason"
}

function Wait-HierarchySample {
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $lastReason = '尚未读取层级'
    while ([DateTime]::UtcNow -lt $deadline) {
        # CLI/协议错误立即失败；只有当前文档尚未出现目标样本时才继续条件轮询。
        $probe = Invoke-CliJson -Arguments (@('hierarchy') + $selectorArguments + @('--depth', '20')) -Label '等待已打开 Prefab 层级'
        $containsAllSamples = $probe.raw.Contains($SampleNodeUuid, [StringComparison]::Ordinal) -and
            $probe.raw.Contains($SampleComponentUuid, [StringComparison]::Ordinal) -and
            $probe.raw.Contains($NestedPrefabNodeUuid, [StringComparison]::Ordinal) -and
            $probe.raw.Contains($TestPrefabUuid, [StringComparison]::OrdinalIgnoreCase)
        if ($containsAllSamples) {
            return $probe
        }
        $lastReason = '当前已打开文档不包含全部运行期样本 UUID'
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    }
    throw "等待样本层级超时，请确认 Creator 已打开目标 Prefab，并刷新运行期节点/组件 UUID: $lastReason"
}

try {
    Assert-Condition -Condition (-not $realProject.Equals($isolatedProject, [StringComparison]::OrdinalIgnoreCase)) -Message '真实项目和隔离项目不能是同一路径'
    Assert-Condition -Condition (Test-PathWithin -ChildPath $isolatedProject -ParentPath $worktreeRoot) -Message "隔离项目必须位于 $worktreeRoot"

    $realGit = Invoke-NativeCommand -FilePath $gitExe -Arguments @('-C', $realProject, 'rev-parse', '--is-inside-work-tree') -Label '确认真实项目 Git 仓库'
    $isolatedGit = Invoke-NativeCommand -FilePath $gitExe -Arguments @('-C', $isolatedProject, 'rev-parse', '--is-inside-work-tree') -Label '确认隔离项目 Git Worktree'
    Assert-Condition -Condition ($realGit.stdout -eq 'true') -Message '真实项目不是 Git 仓库'
    Assert-Condition -Condition ($isolatedGit.stdout -eq 'true') -Message '隔离项目不是 Git Worktree'

    $gitStatusBefore = [ordered]@{
        realProject = Get-GitStatusSnapshot -ProjectPath $realProject -Label '记录真实项目验证前状态'
        isolatedProject = Get-GitStatusSnapshot -ProjectPath $isolatedProject -Label '记录隔离项目验证前状态'
    }
    Write-JsonReport -Name "$reportPrefix-git-status-before.json" -Value $gitStatusBefore

    $npmTest = Invoke-NativeCommand -FilePath $npmExe -Arguments @('test') -Label 'npm test'
    Write-JsonReport -Name "$reportPrefix-npm-test.json" -Value $npmTest
    Add-PassedStep -Name 'npm test' -DurationMs $npmTest.durationMs

    $npmTypecheck = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'typecheck') -Label 'npm run typecheck'
    Write-JsonReport -Name "$reportPrefix-npm-typecheck.json" -Value $npmTypecheck
    Add-PassedStep -Name 'npm run typecheck' -DurationMs $npmTypecheck.durationMs

    $npmBuild = Invoke-NativeCommand -FilePath $npmExe -Arguments @('run', 'build') -Label 'npm run build'
    Write-JsonReport -Name "$reportPrefix-npm-build.json" -Value $npmBuild
    Add-PassedStep -Name 'npm run build' -DurationMs $npmBuild.durationMs
    Assert-Condition -Condition (Test-Path -LiteralPath $cliPath -PathType Leaf) -Message "CLI 构建产物不存在: $cliPath"

    $editors = Invoke-CliJson -Arguments @('editors') -Label 'CLI editors'
    Write-RawJsonReport -Name "$reportPrefix-editors.json" -RawJson $editors.raw
    $selectedEditors = @($editors.data | Where-Object {
        $_.projectId -eq $ProjectId -and $_.editorInstanceId -eq $EditorInstanceId
    })
    Assert-Condition -Condition ($selectedEditors.Count -eq 1) -Message '未找到唯一的目标编辑器实例'
    $selectedEditor = $selectedEditors[0]
    Assert-Condition -Condition ([IO.Path]::GetFullPath([string]$selectedEditor.projectPath).Equals($isolatedProject, [StringComparison]::OrdinalIgnoreCase)) -Message '目标编辑器不是隔离项目'
    Assert-Condition -Condition ([string]$selectedEditor.creatorVersion -like '3.8.*') -Message "Creator 版本不属于 3.8.x: $($selectedEditor.creatorVersion)"
    foreach ($capability in @('probe.editorState', 'probe.assets', 'probe.hierarchy', 'probe.node', 'probe.component', 'probe.prefab', 'probe.undoSavePrepare', 'probe.undoSaveConfirm', 'probe.undoSaveStatus')) {
        Assert-Condition -Condition ($selectedEditor.capabilities -contains $capability) -Message "Bridge 缺少能力: $capability"
    }
    Add-PassedStep -Name 'CLI editors' -DurationMs $editors.command.durationMs

    $selectorArguments = @('--project-id', $ProjectId, '--editor-instance-id', $EditorInstanceId)
    $state = Invoke-CliJson -Arguments (@('state') + $selectorArguments) -Label 'CLI state'
    Write-RawJsonReport -Name "$reportPrefix-state.json" -RawJson $state.raw
    Assert-Condition -Condition ([IO.Path]::GetFullPath([string]$state.data.projectPath).Equals($isolatedProject, [StringComparison]::OrdinalIgnoreCase)) -Message 'state 返回的项目路径不是隔离项目'
    Assert-Condition -Condition ($state.data.ready.scene -eq $true -and $state.data.ready.assetDatabase -eq $true) -Message 'Creator Scene 或 AssetDB 尚未 Ready'
    Add-PassedStep -Name 'CLI state' -DurationMs $state.command.durationMs

    $assets = Wait-TargetAsset
    Write-RawJsonReport -Name "$reportPrefix-assets.json" -RawJson $assets.raw
    Assert-Condition -Condition ($assets.data.details.type -eq 'cc.Prefab') -Message '目标资产不是 cc.Prefab'
    $prefabPath = [IO.Path]::GetFullPath([string]$assets.data.details.file)
    Assert-Condition -Condition (Test-PathWithin -ChildPath $prefabPath -ParentPath $isolatedProject) -Message '目标 Prefab 不在隔离项目内'
    Assert-Condition -Condition (Test-Path -LiteralPath $prefabPath -PathType Leaf) -Message "目标 Prefab 文件不存在: $prefabPath"
    $prefabSha256Before = (Get-FileHash -LiteralPath $prefabPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Add-PassedStep -Name 'CLI assets' -DurationMs $assets.command.durationMs

    $hierarchy = Wait-HierarchySample
    Write-RawJsonReport -Name "$reportPrefix-hierarchy.json" -RawJson $hierarchy.raw
    Add-PassedStep -Name 'CLI hierarchy' -DurationMs $hierarchy.command.durationMs

    $node = Invoke-CliJson -Arguments (@('node') + $selectorArguments + @('--uuid', $SampleNodeUuid)) -Label 'CLI node'
    Write-RawJsonReport -Name "$reportPrefix-node.json" -RawJson $node.raw
    Assert-Condition -Condition ($node.data.data.identity.objectUuid -eq $SampleNodeUuid) -Message '节点探针未返回目标节点 UUID'
    Assert-Condition -Condition ($node.raw.Contains($SampleComponentUuid, [StringComparison]::Ordinal)) -Message '节点探针未返回目标自定义组件引用'
    Add-PassedStep -Name 'CLI node' -DurationMs $node.command.durationMs

    $component = Invoke-CliJson -Arguments (@('component') + $selectorArguments + @('--uuid', $SampleComponentUuid)) -Label 'CLI component'
    Write-RawJsonReport -Name "$reportPrefix-component.json" -RawJson $component.raw
    Assert-Condition -Condition ($component.data.data.class.custom -eq $true) -Message '组件探针未识别出自定义组件'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$component.data.data.class.scriptUuid)) -Message '自定义组件缺少脚本 UUID'
    Assert-Condition -Condition (@($component.data.data.properties.PSObject.Properties).Count -gt 0) -Message '自定义组件属性为空'
    Add-PassedStep -Name 'CLI component' -DurationMs $component.command.durationMs

    $prefab = Invoke-CliJson -Arguments (@('prefab') + $selectorArguments + @('--node-uuid', $NestedPrefabNodeUuid)) -Label 'CLI prefab'
    Write-RawJsonReport -Name "$reportPrefix-prefab.json" -RawJson $prefab.raw
    Assert-Condition -Condition ($prefab.data.document.assetUuid -eq $TestPrefabUuid) -Message 'Prefab 探针所属文档 UUID 不匹配'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$prefab.data.data.sourcePrefabAssetUuid)) -Message '嵌套 Prefab 缺少源 Prefab UUID'
    Assert-Condition -Condition (@($prefab.data.data.instanceChain).Count -ge 2) -Message '嵌套 Prefab 实例链不足两层'
    Assert-Condition -Condition (@($prefab.data.data.propertyOverrides).Count -gt 0) -Message '嵌套 Prefab 未返回 Property Override'
    Assert-Condition -Condition (@($prefab.data.data.unresolved).Count -eq 0) -Message '嵌套 Prefab 样本仍有 unresolved'
    Add-PassedStep -Name 'CLI prefab' -DurationMs $prefab.command.durationMs

    $prepare = Invoke-CliJson -Arguments (@('probe-undo-save-prepare') + $selectorArguments + @(
        '--project-path', $isolatedProject,
        '--document-uuid', $TestPrefabUuid,
        '--probe-name', $probeName
    )) -Label 'CLI probe-undo-save-prepare'
    Write-RawJsonReport -Name "$reportPrefix-undo-prepare.json" -RawJson $prepare.raw
    Assert-Condition -Condition ($prepare.data.status -eq 'prepared') -Message 'Undo 事务未进入 prepared'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$prepare.data.transactionId)) -Message 'prepare 缺少 transactionId'
    Assert-Condition -Condition (-not [string]::IsNullOrWhiteSpace([string]$prepare.data.revision)) -Message 'prepare 缺少 revision'
    Assert-Condition -Condition ($prepare.data.baseline.assetSha256 -eq $prefabSha256Before) -Message 'prepare 的 Prefab SHA-256 与磁盘基线不一致'
    Add-PassedStep -Name 'CLI probe-undo-save-prepare' -DurationMs $prepare.command.durationMs

    $transactionId = [string]$prepare.data.transactionId
    $revision = [string]$prepare.data.revision
    $confirm = Invoke-CliJson -Arguments (@('probe-undo-save-confirm') + $selectorArguments + @(
        '--transaction-id', $transactionId,
        '--expected-revision', $revision
    )) -Label 'CLI probe-undo-save-confirm'
    Write-RawJsonReport -Name "$reportPrefix-undo-confirm.json" -RawJson $confirm.raw
    Assert-Condition -Condition ($confirm.data.status -eq 'rolled-back') -Message "confirm 最终状态不是 rolled-back: $($confirm.data.status)"
    Assert-Condition -Condition ($confirm.data.result.rollbackMethod -eq 'undo') -Message "Creator Undo 未直接完成回滚: $($confirm.data.result.rollbackMethod)"
    Assert-Condition -Condition ($confirm.data.result.diskHashRestored -eq $true) -Message 'Undo 事务未恢复磁盘哈希'
    foreach ($snapshotName in @('created', 'saved')) {
        $snapshot = $confirm.data.result.$snapshotName
        Assert-Condition -Condition ($snapshot.hasUITransform -eq $true) -Message "$snapshotName 状态缺少 cc.UITransform"
        Assert-Condition -Condition ($snapshot.position.x -eq 17 -and $snapshot.position.y -eq 23 -and $snapshot.position.z -eq 0) -Message "$snapshotName 状态 Position 不匹配"
    }
    Add-PassedStep -Name 'CLI probe-undo-save-confirm' -DurationMs $confirm.command.durationMs

    $status = Invoke-CliJson -Arguments (@('probe-undo-save-status') + $selectorArguments + @('--transaction-id', $transactionId)) -Label 'CLI probe-undo-save-status'
    Write-RawJsonReport -Name "$reportPrefix-undo-status.json" -RawJson $status.raw
    Assert-Condition -Condition ($status.data.status -eq 'rolled-back') -Message "status 最终状态不是 rolled-back: $($status.data.status)"
    Assert-Condition -Condition ($status.data.transactionId -eq $transactionId -and $status.data.revision -eq $revision) -Message 'status 返回的事务身份不匹配'
    Assert-Condition -Condition ($status.data.result.rolledBack.probeExists -eq $false) -Message 'status 显示探针节点仍存在'
    Add-PassedStep -Name 'CLI probe-undo-save-status' -DurationMs $status.command.durationMs

    $hierarchyAfter = Invoke-CliJson -Arguments (@('hierarchy') + $selectorArguments + @('--depth', '20')) -Label '回滚后重新读取层级'
    Write-RawJsonReport -Name "$reportPrefix-hierarchy-after.json" -RawJson $hierarchyAfter.raw
    Assert-Condition -Condition (-not $hierarchyAfter.raw.Contains($probeName, [StringComparison]::Ordinal)) -Message '回滚后层级仍残留探针节点'

    $prefabSha256After = (Get-FileHash -LiteralPath $prefabPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Condition -Condition ($prefabSha256After -eq $prefabSha256Before) -Message '回滚后 Prefab SHA-256 未恢复'
    $transactionSummary = [ordered]@{
        transactionId = $transactionId
        revision = $revision
        status = $status.data.status
        probeName = $probeName
        createdNodeUuid = $status.data.createdNodeUuid
        rollbackMethod = $status.data.result.rollbackMethod
        recoveryMethod = $status.data.result.recoveryMethod
        undoSource = $status.data.result.undoSource
    }

    $gitStatusAfter = [ordered]@{
        realProject = Get-GitStatusSnapshot -ProjectPath $realProject -Label '记录真实项目验证后状态'
        isolatedProject = Get-GitStatusSnapshot -ProjectPath $isolatedProject -Label '记录隔离项目验证后状态'
    }
    Write-JsonReport -Name "$reportPrefix-git-status-after.json" -Value $gitStatusAfter
    Assert-UnchangedStatus -Before $gitStatusBefore.realProject -After $gitStatusAfter.realProject -Label '真实项目'
    Assert-UnchangedStatus -Before $gitStatusBefore.isolatedProject -After $gitStatusAfter.isolatedProject -Label '隔离项目'
    Add-PassedStep -Name '双项目 git status 对比' -DurationMs 0

    $runStatus = 'passed'
} catch {
    $runStatus = 'failed'
    $failure = [ordered]@{
        message = $_.Exception.Message
        category = [string]$_.CategoryInfo.Category
        target = [string]$_.CategoryInfo.TargetName
    }
    throw
} finally {
    $summary = [ordered]@{
        schemaVersion = 1
        runId = $runId
        status = $runStatus
        startedAt = $startedAt
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
        projectId = $ProjectId
        editorInstanceId = $EditorInstanceId
        creatorVersion = if ($null -ne (Get-Variable selectedEditor -ValueOnly -ErrorAction SilentlyContinue)) { $selectedEditor.creatorVersion } else { $null }
        realProjectPath = $realProject
        isolatedProjectPath = $isolatedProject
        testPrefabUuid = $TestPrefabUuid
        prefabSha256Before = $prefabSha256Before
        prefabSha256After = $prefabSha256After
        transaction = $transactionSummary
        gitStatusBefore = $gitStatusBefore
        gitStatusAfter = $gitStatusAfter
        steps = $steps
        failure = $failure
    }
    Write-JsonReport -Name "$reportPrefix-summary.json" -Value $summary
    Write-Host "Phase 0 报告前缀: $reportPrefix"
    Write-Host "Phase 0 最终状态: $runStatus"
}
