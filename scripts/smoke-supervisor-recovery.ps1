#Requires -Version 5.1
<#
.SYNOPSIS
  P2.2.1 real Windows supervisor / autostart recovery smoke.

.DESCRIPTION
  Exercises the production recovery chain on the real machine:

    G1  scheduled task -> supervisor -> LiteLLM + bridge, single instance
    G2  kill bridge only      -> supervisor survives, bridge auto-recovers
    G3  kill LiteLLM only     -> supervisor survives, gateway auto-recovers
    G4  kill supervisor only  -> Task Scheduler restarts it (no manual start)
    G5  >5 bridge failures    -> production recovery never permanently gives up

  It never reboots the machine, never touches the user's proxy and never prints
  secrets. G5 runs in an isolated temp RuntimeDir/LogDir with a fake always-fail
  bridge, so it cannot affect the real checkout state.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\smoke-supervisor-recovery.ps1
    ... -SkipDiscordReady            # process-level recovery only
    ... -SkipG5                      # skip the isolated failure-storm check
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Jarvis Discord Agent Control',
  [string]$RepoRoot = '',
  [int]$ReadyTimeoutSec = 180,
  [int]$SupervisorRestartTimeoutSec = 240,
  [switch]$SkipDiscordReady,
  [switch]$SkipG5,
  [switch]$StopWhenDone
)

$ErrorActionPreference = 'Continue'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

$dataDir = Join-Path $RepoRoot 'data'
$logDir = Join-Path $RepoRoot 'logs'
$supervisorPidFile = Join-Path $dataDir 'jarvis-supervisor.pid'
$lockFile = Join-Path $dataDir 'jarvis-instance.lock'
$gatewayPidFile = Join-Path $dataDir 'litellm\gateway.pid'
$bridgeLog = Join-Path $logDir 'bridge.log'
$supervisorLog = Join-Path $logDir 'supervisor.log'
$resultFile = Join-Path $logDir 'v4-smoke\p221-supervisor-recovery.txt'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resultFile) | Out-Null

$script:results = @()

function Write-Result {
  param([string]$Line)
  Write-Host $Line
  Add-Content -Path $resultFile -Value $Line -Encoding utf8 -ErrorAction SilentlyContinue
}

function Add-Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  $script:results += [pscustomobject]@{ Name = $Name; Ok = [bool]$Ok; Detail = $Detail }
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Result ("{0} {1}{2}" -f $tag, $Name, $(if ($Detail) { ' - ' + $Detail } else { '' }))
}

function Wait-For {
  param([scriptblock]$Condition, [int]$TimeoutSec, [int]$IntervalMs = 1000)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $value = $null
    try { $value = & $Condition } catch { $value = $null }
    if ($value) { return $value }
    Start-Sleep -Milliseconds $IntervalMs
  }
  return $null
}

function Get-LiveProcess {
  param([int]$ProcessId, [string]$Name)
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq $Name) { return $ProcessId }
  } catch {}
  return $null
}

function Get-SupervisorPid {
  if (Test-Path $supervisorPidFile) {
    $raw = (Get-Content $supervisorPidFile -Raw -ErrorAction SilentlyContinue)
    $value = 0
    if ($raw -and [int]::TryParse($raw.Trim(), [ref]$value)) {
      $live = Get-LiveProcess -ProcessId $value -Name 'powershell'
      if ($live) { return $live }
    }
  }
  # Fallback: a just-restarted supervisor may not have written the pid file yet.
  try {
    $rows = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { "$($_.CommandLine)" -match 'start-supervisor\.ps1' }
    $first = @($rows) | Select-Object -First 1
    if ($first) { return [int]$first.ProcessId }
  } catch {}
  return $null
}

function Get-BridgePid {
  if (Test-Path $lockFile) {
    $lock = $null
    try { $lock = (Get-Content $lockFile -Raw -ErrorAction SilentlyContinue) | ConvertFrom-Json } catch { $lock = $null }
    if ($lock -and $lock.pid) {
      $value = 0
      if ([int]::TryParse("$($lock.pid)", [ref]$value)) {
        $live = Get-LiveProcess -ProcessId $value -Name 'node'
        if ($live) { return $live }
      }
    }
  }
  # Fallback: the bridge may be starting and not have written the lock yet.
  try {
    $rows = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { "$($_.CommandLine)" -match 'src\\index\.mjs' }
    $first = @($rows) | Select-Object -First 1
    if ($first) { return [int]$first.ProcessId }
  } catch {}
  return $null
}

function Test-Gateway {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/health/liveliness' -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Get-GatewayPid {
  if (-not (Test-Path $gatewayPidFile)) { return $null }
  $raw = (Get-Content $gatewayPidFile -Raw -ErrorAction SilentlyContinue)
  if (-not $raw) { return $null }
  $value = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$value)) { return $null }
  return $value
}

function Count-Bridges {
  try {
    $rows = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*src\index.mjs*' }
    return @($rows).Count
  } catch { return 0 }
}

function Kill-Tree {
  param([int]$ProcessId)
  if (-not $ProcessId) { return }
  taskkill /PID $ProcessId /T /F 2>$null | Out-Null
}

Write-Result "=== P2.2.1 supervisor recovery smoke $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Write-Result "repo=$RepoRoot task=$TaskName"

# --- preflight: clean start -------------------------------------------------
$staleSupervisor = Get-SupervisorPid
if ($staleSupervisor) { Write-Result "preflight: stopping the already-running supervisor pid=$staleSupervisor"; Kill-Tree -ProcessId $staleSupervisor }
$staleBridge = Get-BridgePid
if ($staleBridge) { Write-Result "preflight: stopping the already-running bridge pid=$staleBridge"; Kill-Tree -ProcessId $staleBridge }
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
Start-Sleep -Seconds 3

# --- G1: scheduled-task start ----------------------------------------------
try { Start-ScheduledTask -TaskName $TaskName } catch { Add-Check 'G1 scheduled task started' $false "$_" }
Start-Sleep -Seconds 2

$supervisorPid = Wait-For { Get-SupervisorPid } $ReadyTimeoutSec 1000
Add-Check 'G1 supervisor started by the scheduled task' ([bool]$supervisorPid) "pid=$supervisorPid"

$gatewayUp = Wait-For { if (Test-Gateway) { $true } } $ReadyTimeoutSec 2000
Add-Check 'G1 LiteLLM healthy under the supervisor' ([bool]$gatewayUp) "pid=$(Get-GatewayPid)"

$bridgePid = Wait-For { Get-BridgePid } $ReadyTimeoutSec 1000
Add-Check 'G1 bridge process running' ([bool]$bridgePid) "pid=$bridgePid"

Add-Check 'G1 exactly one Jarvis bridge owns the instance lock' ((Count-Bridges) -eq 1) "count=$(Count-Bridges)"

if (-not $SkipDiscordReady) {
  $ready = Wait-For {
    if ((Test-Path $bridgeLog) -and ((Get-Content $bridgeLog -Raw -ErrorAction SilentlyContinue) -match 'control plane ready')) { $true }
  } $ReadyTimeoutSec 2000
  Add-Check 'G1 bridge reached Discord ready' ([bool]$ready)
}

# --- G2: kill bridge only ---------------------------------------------------
$supervisorBefore = Get-SupervisorPid
$bridgeBefore = Get-BridgePid
if ($bridgeBefore) {
  Write-Result "G2 killing bridge pid=$bridgeBefore only"
  Kill-Tree -ProcessId $bridgeBefore
}
$bridgeAfter = Wait-For { $p = Get-BridgePid; if ($p -and $p -ne $bridgeBefore) { $p } } $ReadyTimeoutSec 1000
Add-Check 'G2 bridge auto-recovered with a new pid' ([bool]$bridgeAfter) "old=$bridgeBefore new=$bridgeAfter"
Add-Check 'G2 supervisor PID preserved across the bridge kill' ((Get-SupervisorPid) -eq $supervisorBefore -and [bool]$supervisorBefore) "supervisor=$supervisorBefore"
Add-Check 'G2 no duplicate bridge after recovery' ((Count-Bridges) -eq 1) "count=$(Count-Bridges)"

# --- G3: kill LiteLLM only --------------------------------------------------
$gatewayBefore = Get-GatewayPid
if ($gatewayBefore) {
  Write-Result "G3 killing LiteLLM pid=$gatewayBefore only"
  Kill-Tree -ProcessId $gatewayBefore
}
Start-Sleep -Seconds 2
$gatewayRecovered = Wait-For {
  if ((Test-Gateway) -and ((Get-GatewayPid) -ne $gatewayBefore)) { $true }
} $ReadyTimeoutSec 3000
Add-Check 'G3 LiteLLM auto-recovered' ([bool]$gatewayRecovered) "old=$gatewayBefore new=$(Get-GatewayPid)"
Add-Check 'G3 supervisor survived the LiteLLM kill' ([bool](Get-SupervisorPid)) "supervisor=$(Get-SupervisorPid)"

# --- G4: kill supervisor only -> Task Scheduler must restart it -------------
$supervisorBefore = Get-SupervisorPid
if ($supervisorBefore) {
  Write-Result "G4 killing supervisor pid=$supervisorBefore only (no manual restart afterwards)"
  Kill-Tree -ProcessId $supervisorBefore
}
# The killed supervisor's own process must exit. The restart timing belongs to
# Task Scheduler, so a fixed "must observe it stopped" window would race the
# watchdog; assert the killed PID is really gone instead.
$killedSupervisorStopped = Wait-For {
  -not (Get-Process -Id $supervisorBefore -ErrorAction SilentlyContinue)
} 30 500
Add-Check 'G4 the killed supervisor process really exited' ([bool]$killedSupervisorStopped) "old=$supervisorBefore"

$supervisorRestarted = Wait-For {
  $p = Get-SupervisorPid
  if ($p -and $p -ne $supervisorBefore) { $p }
} $SupervisorRestartTimeoutSec 5000
Add-Check 'G4 Task Scheduler restarted the supervisor automatically' ([bool]$supervisorRestarted) "old=$supervisorBefore new=$supervisorRestarted"

$bridgeRestored = Wait-For { Get-BridgePid } $ReadyTimeoutSec 2000
Add-Check 'G4 bridge restored after the supervisor restart' ([bool]$bridgeRestored) "pid=$bridgeRestored"
Add-Check 'G4 exactly one bridge after the supervisor restart' ((Count-Bridges) -eq 1) "count=$(Count-Bridges)"

# --- G5: >5 startup failures must not strand production recovery ------------
if (-not $SkipG5) {
  $tmp = Join-Path $env:TEMP ("jarvis-p221-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $tmpLogs = Join-Path $tmp 'logs'
  $tmpRun = Join-Path $tmp 'run'
  New-Item -ItemType Directory -Force -Path $tmpLogs, $tmpRun | Out-Null
  $probe = Join-Path $tmpRun 'always-fail.mjs'
  Set-Content -Path $probe -Value 'process.exit(1);' -Encoding ascii
  $g5Log = Join-Path $tmpLogs 'supervisor.log'
  $supervisorScript = Join-Path $RepoRoot 'scripts\start-supervisor.ps1'

  $g5 = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisorScript`"",
    '-MaxRestarts', '0', '-InitialDelaySec', '1', '-MaxDelaySec', '2',
    '-Entry', "`"$probe`"", '-RunDirectory', "`"$tmpRun`"",
    '-LogDir', "`"$tmpLogs`"", '-RuntimeDir', "`"$tmp`"", '-NoGateway'
  )

  $stormReached = Wait-For {
    if (Test-Path $g5Log) {
      $text = Get-Content $g5Log -Raw -ErrorAction SilentlyContinue
      if (($text -split "`n" | Where-Object { $_ -match 'Bridge UP: starting' }).Count -ge 6) { $true }
    }
  } 60 500
  $g5Text = if (Test-Path $g5Log) { Get-Content $g5Log -Raw -ErrorAction SilentlyContinue } else { '' }
  $g5Starts = @($g5Text -split "`n" | Where-Object { $_ -match 'Bridge UP: starting' }).Count

  Add-Check 'G5 more than five bridge failures still keep retrying' ([bool]$stormReached) "restarts=$g5Starts"
  Add-Check 'G5 isolated supervisor still alive after >5 failures' (-not $g5.HasExited)
  Add-Check 'G5 production mode never logs "Giving up"' (-not ($g5Text -match 'Giving up'))

  Kill-Tree -ProcessId $g5.Id
  Start-Sleep -Seconds 1
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# --- installed task effective settings --------------------------------------
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $settings = $task.Settings
  Add-Check 'installed task: restart on failure configured' ($settings.RestartCount -ge 1 -and [string]$settings.RestartInterval -match 'PT')
    "count=$($settings.RestartCount) interval=$($settings.RestartInterval)"
  Add-Check 'installed task: restart count survives a long outage' ($settings.RestartCount -ge 100) "count=$($settings.RestartCount)"
  Add-Check 'installed task: unlimited execution time limit' ([double]$settings.ExecutionTimeLimit.TotalSeconds -eq 0) "limit=$($settings.ExecutionTimeLimit)"
  Add-Check 'installed task: StartWhenAvailable' ([bool]$settings.StartWhenAvailable)
  $watchdog = $task.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
  Add-Check 'installed task: 1-minute watchdog trigger present' ([bool]$watchdog) "repetition=$(if ($watchdog) { $watchdog.Repetition.Interval } else { 'none' })"
  $action = ($task.Actions | Select-Object -First 1)
  Add-Check 'installed task: native powershell supervisor action' ("$($action.Execute)" -match 'powershell' -and "$($action.Arguments)" -match 'start-supervisor\.ps1')
    "$($action.Execute) $($action.Arguments)"
} else {
  Add-Check 'installed task present' $false
}

Write-Result "supervisor log tail:"
if (Test-Path $supervisorLog) {
  Get-Content $supervisorLog -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Write-Result "  $_" }
}

$failed = @($script:results | Where-Object { -not $_.Ok })
Write-Result ""
Write-Result ("summary: {0}/{1} checks passed" -f ($script:results.Count - $failed.Count), $script:results.Count)
if ($failed.Count) {
  foreach ($f in $failed) { Write-Result ("FAILED: {0} - {1}" -f $f.Name, $f.Detail) }
}

if ($StopWhenDone) {
  Write-Result 'stopping the scheduled task (StopWhenDone)'
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
} else {
  Write-Result 'production supervisor + bridge left running (do not stop a healthy service).'
}

if ($failed.Count) { exit 1 } else { exit 0 }
