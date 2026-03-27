$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$dllPath = 'd:\OpenClaw\Develop\openclaw\extensions\abb-robot-control\src\ABBBridge.dll'
if (-not (Test-Path $dllPath)) { throw "DLL not found: $dllPath" }
Add-Type -Path $dllPath

$bridge = New-Object ABBBridge
$records = New-Object System.Collections.Generic.List[object]

function Invoke-BridgeMethod {
  param(
    [string]$Name,
    [scriptblock]$Call,
    [int]$TimeoutMs = 12000
  )

  Write-Output "STEP_START $Name"
  try {
    $task = & $Call
    if ($null -eq $task) {
      Write-Output "STEP_FAIL $Name | no task returned"
      $script:records.Add([pscustomobject]@{ name = $Name; ok = $false; kind = 'no-task'; result = $null; error = 'no task returned' }) | Out-Null
      return $null
    }

    if (-not $task.Wait($TimeoutMs)) {
      Write-Output "STEP_TIMEOUT $Name | ${TimeoutMs}ms"
      $script:records.Add([pscustomobject]@{ name = $Name; ok = $false; kind = 'timeout'; result = $null; error = "timeout ${TimeoutMs}ms" }) | Out-Null
      return $null
    }

    $result = $task.Result
    $json = ($result | ConvertTo-Json -Depth 30 -Compress)
    Write-Output "STEP_END $Name | $json"
    $script:records.Add([pscustomobject]@{ name = $Name; ok = $true; kind = 'ok'; result = $result; error = $null }) | Out-Null
    return $result
  } catch {
    Write-Output "STEP_FAIL $Name | $($_.Exception.Message)"
    $script:records.Add([pscustomobject]@{ name = $Name; ok = $false; kind = 'exception'; result = $null; error = $_.Exception.Message }) | Out-Null
    return $null
  }
}

$connectPayload = @{ host = '127.0.0.1'; port = 7000 }
$empty = @{}

$scan = Invoke-BridgeMethod -Name 'scan_controllers' -Call { $bridge.ScanControllers($empty) }
$connect = Invoke-BridgeMethod -Name 'connect' -Call { $bridge.Connect($connectPayload) }
$status = Invoke-BridgeMethod -Name 'get_status' -Call { $bridge.GetStatus($empty) }
$system = Invoke-BridgeMethod -Name 'get_system_info' -Call { $bridge.GetSystemInfo($empty) }
$service = Invoke-BridgeMethod -Name 'get_service_info' -Call { $bridge.GetServiceInfo($empty) }
$getSpeed = Invoke-BridgeMethod -Name 'get_speed' -Call { $bridge.GetSpeedRatio($empty) }
$setSpeed = Invoke-BridgeMethod -Name 'set_speed' -Call { $bridge.SetSpeedRatio(@{ speed = 25 }) }
$joints = Invoke-BridgeMethod -Name 'get_joints' -Call { $bridge.GetJointPositions($empty) }
$world = Invoke-BridgeMethod -Name 'get_world_position' -Call { $bridge.GetWorldPosition($empty) }
$log = Invoke-BridgeMethod -Name 'get_event_log' -Call { $bridge.GetEventLogEntries(@{ categoryId = 0; limit = 15 }) }
$tasks = Invoke-BridgeMethod -Name 'list_tasks' -Call { $bridge.ListTasks($empty) }

$taskName = 'T_ROB1'
$moduleName = 'MainModule'
if ($tasks -and $tasks.success -and $tasks.tasks -and $tasks.tasks.Count -gt 0) {
  $taskName = [string]$tasks.tasks[0].taskName
  if ($tasks.tasks[0].modules -and $tasks.tasks[0].modules.Count -gt 0) {
    $moduleName = [string]$tasks.tasks[0].modules[0]
  }
}

$backupDir = 'd:\OpenClaw\Develop\openclaw\scripts\_abb_backup'
if (-not (Test-Path $backupDir)) { New-Item -Path $backupDir -ItemType Directory | Out-Null }
$backup = Invoke-BridgeMethod -Name 'backup_module' -Call { $bridge.BackupModule(@{ taskName = $taskName; moduleName = $moduleName; outputDir = $backupDir }) }
$resetpp = Invoke-BridgeMethod -Name 'reset_program_pointer' -Call { $bridge.ResetProgramPointer(@{ taskName = $taskName }) }

if ($joints -and $joints.success -and $joints.joints -and $joints.joints.Count -eq 6) {
  $target = @(
    [double]$joints.joints[0],
    [double]$joints.joints[1],
    [double]$joints.joints[2],
    [double]$joints.joints[3],
    [double]$joints.joints[4],
    [double]$joints.joints[5]
  )
  $movj = Invoke-BridgeMethod -Name 'move_to_joints' -Call { $bridge.MoveToJoints(@{ joints = $target; speed = 6; zone = 'fine' }) }
}

$rapidLoad = Invoke-BridgeMethod -Name 'load_rapid' -Call { $bridge.LoadRapidProgram(@{ rapidCode = 'PROC main()\n  TPWrite "hello";\nENDPROC'; taskName = $taskName }) }
$rapidStart = Invoke-BridgeMethod -Name 'start_rapid' -Call { $bridge.StartRapid(@{ allowRealExecution = $false }) }
$rapidStop = Invoke-BridgeMethod -Name 'stop_rapid' -Call { $bridge.StopRapid($empty) }
$disconnect = Invoke-BridgeMethod -Name 'disconnect' -Call { $bridge.Disconnect($empty) }

$outPath = 'd:\OpenClaw\Develop\openclaw\scripts\_dll_direct_records.json'
$records | ConvertTo-Json -Depth 50 | Set-Content -Path $outPath -Encoding UTF8
Write-Output 'DLL_DIRECT_DONE'
