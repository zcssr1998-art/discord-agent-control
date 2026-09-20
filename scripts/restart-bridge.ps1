#Requires -Version 5.1
<#
.SYNOPSIS
  P0: safe developer restart of the production Jarvis bridge.

.DESCRIPTION
  Restarts ONLY the bridge through the existing supervisor chain:

    Task Scheduler -> scripts/start-supervisor.ps1 -> bridge (node src/index.mjs)

  It never kills the supervisor, never touches the proxy, never reboots, and
  never starts a second bridge: the supervisor relaunches exactly one bridge
  from the same checkout and the instance lock guarantees single-instance.
  Active Work IS interrupted by a bridge restart, so this script refuses to
  run while a Work turn looks active unless -Force is passed.

  Usage:
    .\scripts\restart-bridge.ps1              # safe restart (refuses when busy)
    .\scripts\restart-bridge.ps1 -Force       # restart even if Work looks active
    .\scripts\restart-bridge.ps1 -TimeoutSec 180
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Continue'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataDir = Join-Path $RepoRoot 'data'
$LockFile = Join-Path $DataDir 'jarvis-instance.lock'
$SupervisorPidFile = Join-Path $DataDir 'jarvis-supervisor.pid'

function Get-BridgePid {
  if (-not (Test-Path $LockFile)) { return $null }
  try {
    $lock = (Get-Content $LockFile -Raw -ErrorAction SilentlyContinue) | ConvertFrom-Json
    if (-not $lock -or -not $lock.pid) { return $null }
    $value = 0
    if (-not [int]::TryParse("$($lock.pid)", [ref]$value)) { return $null }
    $p = Get-Process -Id $value -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { return $value }
  } catch {}
  return $null
}

function Get-SupervisorPid {
  if (-not (Test-Path $SupervisorPidFile)) { return $null }
  try {
    $raw = (Get-Content $SupervisorPidFile -Raw -ErrorAction SilentlyContinue)
    $value = 0
    if ($raw -and [int]::TryParse($raw.Trim(), [ref]$value)) {
      $p = Get-Process -Id $value -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'powershell') { return $value }
    }
  } catch {}
  try {
    $rows = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { "$($_.CommandLine)" -match 'start-supervisor\.ps1' }
    $first = @($rows) | Select-Object -First 1
    if ($first) { return [int]$first.ProcessId }
  } catch {}
  return $null
}

function Count-Bridges {
  try {
    $rows = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*src\index.mjs*' }
    return @($rows).Count
  } catch { return 0 }
}

function Test-BridgeBusy {
  # Conservative liveness hint from the bridge log: a RUNNING Work turn that
  # has not reached a terminal state. This is advisory only; the supervisor
  # owns the real restart and the instance lock owns single-instance.
  $bridgeLog = Join-Path $RepoRoot 'logs\bridge.log'
  if (-not (Test-Path $bridgeLog)) { return $false }
  try {
    $tail = Get-Content $bridgeLog -Tail 40 -ErrorAction SilentlyContinue
    if (-not $tail) { return $false }
    $joined = $tail -join "`n"
    # A recent task start without a subsequent done/stop line suggests activity.
    # Keep it deliberately narrow: only refuse when the evidence is fresh.
    if ($joined -match '\[task\] start' -and $joined -notmatch '\[task\] (done|stopped|failed)') { return $true }
  } catch {}
  return $false
}

$supervisor = Get-SupervisorPid
if (-not $supervisor) {
  Write-Host '[restart] no live supervisor found. Start production via: Start-ScheduledTask -TaskName "Jarvis Discord Agent Control"'
  exit 1
}
Write-Host "[restart] supervisor pid=$supervisor"

$bridgeBefore = Get-BridgePid
if (-not $bridgeBefore) {
  Write-Host '[restart] no live bridge found; the supervisor will launch one shortly. Waiting...'
} else {
  Write-Host "[restart] bridge pid=$bridgeBefore"
  if ((Test-BridgeBusy) -and (-not $Force)) {
    Write-Host '[restart] REFUSED: the bridge log suggests an active Work turn. Re-run with -Force to interrupt it, or stop it from Discord with !stop first.'
    exit 2
  }
  Write-Host "[restart] stopping bridge pid=$bridgeBefore only (supervisor survives)..."
  taskkill /PID $bridgeBefore /T /F 2>$null | Out-Null
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$newPid = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $candidate = Get-BridgePid
  if ($candidate -and $candidate -ne $bridgeBefore) { $newPid = $candidate; break }
  # Supervisor itself must survive the restart.
  if (-not (Get-SupervisorPid)) {
    Write-Host '[restart] FAIL: the supervisor is gone; it should have survived a bridge-only restart.'
    exit 1
  }
}

if (-not $newPid) {
  Write-Host "[restart] FAIL: no new bridge pid within ${TimeoutSec}s (old=$bridgeBefore)."
  exit 1
}
$count = Count-Bridges
Write-Host "[restart] OK: old=$bridgeBefore new=$newPid bridges=$count supervisor=$supervisor"
if ($count -ne 1) {
  Write-Host "[restart] WARNING: expected exactly 1 bridge, observed $count."
  exit 1
}
exit 0
