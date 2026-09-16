#Requires -Version 5.1
<#
.SYNOPSIS
  Persistent supervisor for the discord-agent-control Jarvis bridge.

.DESCRIPTION
  Level 1 recovery. This process owns the LiteLLM gateway and the Jarvis bridge
  and keeps both alive for as long as the interactive Windows session is alive.

  Production mode (-MaxRestarts 0, the default) never gives up. Restarts use a
  bounded backoff ladder (2s -> 5s -> 10s -> 30s -> 60s -> 120s, capped) and a
  stable run (>= SuccessWindowSec) resets the counter, so a network / proxy /
  Discord outage lasting hours cannot permanently strand the service.

  The bridge runs in its own hidden console with its output redirected to
  logs\bridge.log and logs\bridge.err.log. A bridge crash or a console/control
  event aimed at the bridge therefore cannot terminate this supervisor; the
  Windows Task Scheduler task (Level 2) restarts the supervisor if it still
  exits unexpectedly.

  LiteLLM is probed on a low-frequency interval while the bridge runs and is
  restarted through the existing scripts\start-litellm.ps1 when it goes down.

  Usage:
    .\scripts\start-supervisor.ps1                     # production (unlimited)
    .\scripts\start-supervisor.ps1 -MaxRestarts 5      # finite test mode
    .\scripts\start-supervisor.ps1 -InitialDelaySec 1 -MaxDelaySec 2
#>
[CmdletBinding()]
param(
  # 0 = unlimited (production). A positive value is a deterministic finite mode
  # for tests only; production autostart must never pass it.
  [int]$MaxRestarts = 0,
  [int]$InitialDelaySec = 2,
  [int]$MaxDelaySec = 120,
  [int]$SuccessWindowSec = 60,
  [int]$GatewayProbeSec = 30,
  [int]$HeartbeatSec = 300,
  [string]$LogDir = '',
  [string]$Node = 'node',
  [string]$Entry = '',
  [string]$RunDirectory = '',
  [int]$GatewayPort = 4000,
  [switch]$NoGateway,
  [string]$RuntimeDir = '',
  [switch]$NoOrphanReclaim
)

$ErrorActionPreference = 'Continue'
# $PSScriptRoot can be empty in some Task Scheduler contexts; resolve the
# script location from $MyInvocation so absolute paths survive.
if (-not $PSScriptRoot) {
  $myScript = $MyInvocation.MyCommand.Definition
  if (-not $myScript) { $myScript = $env:JARVIS_SUPERVISOR_SCRIPT }
  if ($myScript) { $PSScriptRoot = Split-Path -Parent $myScript }
}

$repoRoot = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { (Get-Location).Path }
if (-not $LogDir -and $PSScriptRoot) { $LogDir = Join-Path $repoRoot 'logs' }
if (-not $Entry -and $PSScriptRoot) { $Entry = Join-Path $repoRoot 'src\index.mjs' }
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $repoRoot 'data' }
if (-not $RunDirectory) { $RunDirectory = $repoRoot }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

$logFile = Join-Path $LogDir 'supervisor.log'
$bridgeOut = Join-Path $LogDir 'bridge.log'
$bridgeErr = Join-Path $LogDir 'bridge.err.log'
$supervisorPidFile = Join-Path $RuntimeDir 'jarvis-supervisor.pid'
$instanceLockFile = Join-Path $RuntimeDir 'jarvis-instance.lock'
$gatewayExe = Join-Path $repoRoot 'data\litellm\venv\Scripts\litellm.exe'
$gatewayPidFile = Join-Path $repoRoot 'data\litellm\gateway.pid'
$gatewayScript = Join-Path $repoRoot 'scripts\start-litellm.ps1'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-Log {
  param([string]$Message)
  $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
  Write-Host $line
  try { $line | Out-File -FilePath $logFile -Append -Encoding utf8 -ErrorAction SilentlyContinue } catch {}
}

# --- restart backoff ladder -------------------------------------------------
# 2s -> 5s -> 10s -> 30s -> 60s -> 120s (capped). Test mode can tighten it.
$script:delayLadder = @()
foreach ($candidate in @($InitialDelaySec, 5, 10, 30, 60, $MaxDelaySec)) {
  if ($candidate -gt 0 -and $candidate -le $MaxDelaySec) {
    if ($script:delayLadder.Count -eq 0 -or $candidate -gt $script:delayLadder[$script:delayLadder.Count - 1]) {
      $script:delayLadder += $candidate
    }
  }
}
if ($script:delayLadder.Count -eq 0) { $script:delayLadder = @([Math]::Max(1, $InitialDelaySec)) }

function Get-Delay {
  param([int]$Attempt)
  if ($Attempt -le 1) { return $script:delayLadder[0] }
  $idx = [Math]::Min($Attempt - 1, $script:delayLadder.Count - 1)
  return $script:delayLadder[$idx]
}

# --- LiteLLM gateway lifecycle ---------------------------------------------
function Get-GatewayPid {
  if (-not (Test-Path $gatewayPidFile)) { return $null }
  try {
    $raw = (Get-Content $gatewayPidFile -Raw -ErrorAction SilentlyContinue)
    if ($raw) { return $raw.Trim() }
  } catch {}
  return $null
}

function Test-Gateway {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/health/liveliness" -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Get-GatewayState {
  if ($NoGateway) { return 'n/a' }
  if (-not (Test-Path $gatewayExe)) { return 'not-installed' }
  if (Test-Gateway) { return 'UP' }
  return 'DOWN'
}

$script:gatewayMissingLogged = $false
function Ensure-Gateway {
  if ($NoGateway) { return }
  if (-not (Test-Path $gatewayExe)) {
    if (-not $script:gatewayMissingLogged) {
      Write-Log 'LiteLLM not installed; bridge runs without the gateway.'
      $script:gatewayMissingLogged = $true
    }
    return
  }
  if (Test-Gateway) {
    $gpid = Get-GatewayPid
    Write-Log "LiteLLM UP on 127.0.0.1:$GatewayPort pid=$(if ($gpid) { $gpid } else { '?' })"
    return
  }
  Write-Log "LiteLLM DOWN on 127.0.0.1:$GatewayPort; recovering via start-litellm.ps1"
  # Launch the recovery in its own process WITHOUT piping its output. Piping a
  # native command whose grandchild (litellm) inherits the stdout handle leaves
  # the pipe open forever and would hang the supervisor here.
  try {
    $starter = Start-Process -FilePath $powershellExe `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$gatewayScript`"", '-Port', "$GatewayPort") `
      -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $LogDir 'litellm-start.log') `
      -RedirectStandardError (Join-Path $LogDir 'litellm-start.err.log')
    try { $null = $starter.WaitForExit(90000) } catch {}
  } catch {
    Write-Log "LiteLLM start failed: $_"
  }
  if (Test-Gateway) {
    $gpid = Get-GatewayPid
    Write-Log "LiteLLM recovered pid=$(if ($gpid) { $gpid } else { '?' })"
  } else {
    Write-Log 'LiteLLM still unhealthy; will retry on the next probe'
  }
}

function Stop-Gateway {
  if ($NoGateway) { return }
  $gpid = Get-GatewayPid
  if (-not $gpid) { return }
  $alive = $null
  try { $alive = Get-Process -Id ([int]$gpid) -ErrorAction SilentlyContinue } catch { $alive = $null }
  if ($alive) {
    Write-Log "Stopping LiteLLM pid=$gpid"
    taskkill /PID $gpid /T /F 2>$null | Out-Null
  }
}

# --- single-instance + orphan handling --------------------------------------
function Test-ProcessName {
  param([int]$ProcessId, [string]$Name)
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq $Name) { return $true }
  } catch {}
  return $false
}

# True only when ProcessId is a live PowerShell that is actually running THIS
# supervisor script. A recycled PID belonging to an unrelated PowerShell must
# never make a restarted supervisor refuse to start (that would strand Jarvis).
function Test-SupervisorAlive {
  param([int]$ProcessId)
  if (-not $ProcessId) { return $false }
  if (-not (Test-ProcessName -ProcessId $ProcessId -Name 'powershell')) { return $false }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($proc -and "$($proc.CommandLine)" -match 'start-supervisor\.ps1') { return $true }
  } catch {}
  return $false
}

# A bridge orphaned by a previous (dead) supervisor still holds the instance
# lock and would block a fresh bridge. Reclaim it so exactly one supervised
# bridge owns the instance.
function Stop-OrphanBridge {
  if ($NoOrphanReclaim) { return }
  if (-not (Test-Path $instanceLockFile)) { return }
  $lock = $null
  try { $lock = (Get-Content $instanceLockFile -Raw -ErrorAction SilentlyContinue) | ConvertFrom-Json } catch { return }
  if (-not $lock -or -not $lock.pid) { return }
  $bridgePidValue = 0
  if (-not [int]::TryParse("$($lock.pid)", [ref]$bridgePidValue) -or $bridgePidValue -le 0) { return }
  if (-not (Test-ProcessName -ProcessId $bridgePidValue -Name 'node')) { return }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePidValue" -ErrorAction SilentlyContinue
  if (-not $proc) { return }
  $cmdline = "$($proc.CommandLine)"
  if (-not $cmdline) { return }
  if ($cmdline -like "*$Entry*") {
    Write-Log "Reclaiming orphan bridge pid=$bridgePidValue (previous supervisor is gone)"
    taskkill /PID $bridgePidValue /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
  }
}

function Stop-Bridge {
  param([int]$ProcessId)
  if (-not $ProcessId) { return }
  try { taskkill /PID $ProcessId /T /F 2>$null | Out-Null } catch {}
}

# --- resolve the node executable -------------------------------------------
$nodeExe = if ($Node) { $Node } else { 'node' }
if ($nodeExe -eq 'node') {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found -and $found.Source) { $nodeExe = $found.Source }
}

# --- single-instance supervisor guard ---------------------------------------
$myPid = $PID
$otherSupervisor = $null
if (Test-Path $supervisorPidFile) {
  $existingPid = 0
  try {
    $raw = (Get-Content $supervisorPidFile -Raw -ErrorAction SilentlyContinue)
    if ($raw) { [void][int]::TryParse($raw.Trim(), [ref]$existingPid) }
  } catch { $existingPid = 0 }
  if ($existingPid -gt 0 -and $existingPid -ne $myPid -and (Test-SupervisorAlive -ProcessId $existingPid)) {
    $otherSupervisor = $existingPid
  }
}
if ($otherSupervisor) {
  Write-Log "Another Jarvis supervisor is already running (pid=$otherSupervisor). Refusing to start a second one."
  exit 0
}
try { Set-Content -Path $supervisorPidFile -Value $myPid -Encoding ascii -ErrorAction SilentlyContinue } catch {}

# --- interactive console (Ctrl+C is only meaningful on a real console) ------
$script:interactive = $false
try {
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    $null = [Console]::TreatControlCAsInput = $true
    $script:interactive = $true
  }
} catch { $script:interactive = $false }

$mode = if ($MaxRestarts -gt 0) { "finite(max=$MaxRestarts)" } else { 'production(unlimited)' }
$consecutiveCrashes = 0
$bridgePid = $null
$bridgeProc = $null
$shuttingDown = $false

Write-Log "Supervisor starting. pid=$myPid mode=$mode entry=$Entry node=$nodeExe runtime=$RuntimeDir interactive=$($script:interactive)"

$lastGatewayProbe = (Get-Date).AddSeconds(-$GatewayProbeSec)
$lastHeartbeat = Get-Date

try {
  while ($true) {
    Stop-OrphanBridge
    Ensure-Gateway

    $runStart = Get-Date
    Write-Log "Bridge UP: starting entry=$Entry consecutive=$consecutiveCrashes"
    $bridgeProc = $null
    try {
      $bridgeProc = Start-Process -FilePath $nodeExe -ArgumentList @("`"$Entry`"") `
        -WorkingDirectory $RunDirectory -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $bridgeOut -RedirectStandardError $bridgeErr
      # Required for a reliable .ExitCode on Windows PowerShell 5.1 when output
      # is redirected (without this the property stays null).
      try { $bridgeProc.EnableRaisingEvents = $true } catch {}
      $bridgePid = $bridgeProc.Id
      Write-Log "Bridge UP pid=$bridgePid"
    } catch {
      $bridgePid = $null
      Write-Log "Bridge failed to start: $_"
    }

    if ($bridgeProc) {
      while ($true) {
        $alive = $false
        try { $alive = -not $bridgeProc.HasExited } catch { $alive = $false }
        if (-not $alive) { break }

        Start-Sleep -Milliseconds 500

        # LiteLLM must be recovered even while a healthy bridge is running.
        $now = Get-Date
        if (-not $NoGateway -and ($now - $lastGatewayProbe).TotalSeconds -ge $GatewayProbeSec) {
          $lastGatewayProbe = $now
          if (-not (Test-Gateway)) {
            Ensure-Gateway
          }
        }
        if (($now - $lastHeartbeat).TotalSeconds -ge $HeartbeatSec) {
          $lastHeartbeat = $now
          $uptime = ((Get-Date) - $runStart).TotalSeconds.ToString('F0')
          Write-Log "heartbeat supervisor=$myPid bridge=$bridgePid litellm=$(Get-GatewayState) run=${uptime}s crashes=$consecutiveCrashes"
        }
        if ($script:interactive) {
          $keyAvailable = $false
          try { $keyAvailable = [Console]::KeyAvailable } catch { $keyAvailable = $false }
          if ($keyAvailable) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq 'C' -and $key.Modifiers -eq 'Control') {
              Write-Log 'Ctrl+C pressed - stopping supervisor and bridge'
              $shuttingDown = $true
              break
            }
          }
        }
      }
    }

    $exitCode = $null
    if ($bridgeProc) {
      try { $exitCode = $bridgeProc.ExitCode } catch { $exitCode = $null }
    }
    $runDuration = (Get-Date) - $runStart
    $exitText = if ($null -eq $exitCode) { 'unknown' } else { "$exitCode" }
    Write-Log "Bridge DOWN: exited code=$exitText after $($runDuration.TotalSeconds.ToString('F1'))s pid=$bridgePid"

    if ($shuttingDown) {
      Stop-Bridge -ProcessId $bridgePid
      Write-Log 'Supervisor stopped by user.'
      break
    }

    # Any exit (including code 0) leaves Jarvis offline, so production recovers
    # from it too. A long stable run means the previous crash streak is over.
    if ($runDuration.TotalSeconds -ge $SuccessWindowSec) {
      if ($consecutiveCrashes -ne 0) { Write-Log "Run lasted >= ${SuccessWindowSec}s; crash counter reset" }
      $consecutiveCrashes = 0
    } else {
      $consecutiveCrashes++
    }

    if ($MaxRestarts -gt 0 -and $consecutiveCrashes -ge $MaxRestarts) {
      Write-Log "MAX RESTARTS ($MaxRestarts) reached (finite test mode). Giving up."
      break
    }

    $delay = Get-Delay -Attempt $consecutiveCrashes
    $limit = if ($MaxRestarts -gt 0) { "$MaxRestarts" } else { 'unlimited' }
    Write-Log "Bridge failed; retrying in ${delay}s (consecutive=$consecutiveCrashes/$limit)"
    Start-Sleep -Seconds $delay
  }
} catch {
  Write-Log "Supervisor fatal error: $_"
} finally {
  if ($bridgePid) { Stop-Bridge -ProcessId $bridgePid }
  Stop-Gateway
  try {
    if (Test-Path $supervisorPidFile) {
      $current = (Get-Content $supervisorPidFile -Raw -ErrorAction SilentlyContinue)
      if ($current -and $current.Trim() -eq "$myPid") { Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue }
    }
  } catch {}
  Write-Log 'Supervisor exited.'
}
