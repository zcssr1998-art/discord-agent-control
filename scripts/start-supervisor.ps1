#Requires -Version 5.1
<#
.DESCRIPTION
  Supervisor for discord-agent-control bridge.

  Keeps the bridge alive by restarting it after a crash. Normal shutdown
  (Ctrl+C) is honoured and does not trigger a restart.

  Restart policy:
    - Initial restart delay: 3 seconds
    - Backoff: doubles on each consecutive crash, capped at 30 seconds
    - Max consecutive restarts: 5 (then supervisor exits)
    - Successful run (>60s) resets the crash counter

  Usage:
    .\scripts\start-supervisor.ps1
    .\scripts\start-supervisor.ps1 -MaxRestarts 10 -InitialDelaySec 5
#>
[CmdletBinding()]
param(
  [int]$MaxRestarts = 5,
  [int]$InitialDelaySec = 3,
  [int]$MaxDelaySec = 30,
  [int]$SuccessWindowSec = 60,
  [string]$LogDir = '',
  [string]$Node = 'node',
[string]$Entry = '',
[int]$GatewayPort = 4000,
[switch]$NoGateway
)

$ErrorActionPreference = 'Continue'
# $PSScriptRoot can be empty in some Task Scheduler contexts; resolve the
# script location from $MyInvocation so absolute LogDir paths survive.
if (-not $PSScriptRoot) {
  $myScript = $MyInvocation.MyCommand.Definition
  if (-not $myScript) { $myScript = $env:JARVIS_SUPERVISOR_SCRIPT }
  if ($myScript) { $PSScriptRoot = Split-Path -Parent $myScript }
}
if (-not $LogDir -and $PSScriptRoot) { $LogDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs' }
if (-not $Entry -and $PSScriptRoot) { $Entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\index.mjs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir 'supervisor.log'

function Write-Log {
  param([string]$Message)
  $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
  Write-Host $line
  try { $line | Out-File -FilePath $logFile -Append -Encoding utf8 -ErrorAction SilentlyContinue } catch {}
}

function Get-Delay {
  param([int]$Attempt)
  $delay = $InitialDelaySec * [Math]::Pow(2, $Attempt - 1)
  return [Math]::Min([int]$delay, $MaxDelaySec)
}

# --- LiteLLM gateway lifecycle ---------------------------------------------
# LiteLLM is the primary standard model gateway. The supervisor keeps it alive
# alongside the bridge, so a gateway crash is repaired instead of silently
# downgrading Chat to direct providers. If LiteLLM is not installed the
# supervisor simply runs the bridge on its own.
$repoRoot = Split-Path $PSScriptRoot -Parent
$gatewayExe = Join-Path $repoRoot 'data\litellm\venv\Scripts\litellm.exe'
$gatewayPidFile = Join-Path $repoRoot 'data\litellm\gateway.pid'
$gatewayScript = Join-Path $PSScriptRoot 'start-litellm.ps1'

function Test-Gateway {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/health/liveliness" -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Ensure-Gateway {
  if ($NoGateway) { return }
  if (-not (Test-Path $gatewayExe)) { Write-Log 'LiteLLM not installed; bridge runs without the gateway.'; return }
  if (Test-Gateway) { Write-Log "LiteLLM healthy on 127.0.0.1:$GatewayPort"; return }
  Write-Log "Starting LiteLLM on 127.0.0.1:$GatewayPort ..."
  try {
    & $gatewayScript -Port $GatewayPort | Out-Null
    if (Test-Gateway) { Write-Log 'LiteLLM started and healthy' }
    else { Write-Log 'LiteLLM start returned but health is not up yet' }
  } catch {
    Write-Log "LiteLLM start failed: $_"
  }
}

function Stop-Gateway {
  if (-not (Test-Path $gatewayPidFile)) { return }
  $gpid = (Get-Content $gatewayPidFile -Raw).Trim()
  if ($gpid) {
    Write-Log "Stopping LiteLLM pid=$gpid"
    taskkill /PID $gpid /T /F 2>$null | Out-Null
  }
}

$consecutiveCrashes = 0
$bridgePid = $null
$shuttingDown = $false

# Ctrl+C handler (best effort: there may be no interactive console, e.g. when
# launched by a service or a test harness).
try { $null = [Console]::TreatControlCAsInput = $true } catch { }

Write-Log "Supervisor starting. Entry=$Entry MaxRestarts=$MaxRestarts"

try {
  while ($consecutiveCrashes -lt $MaxRestarts) {
    $runStart = Get-Date
    Ensure-Gateway
    Write-Log "Starting bridge (consecutive crashes=$consecutiveCrashes)"

    # Launch bridge directly so stdout/stderr flow straight to the console.
    # We capture the process object so we can inspect its exit code later.
    $proc = Start-Process -FilePath $Node -ArgumentList "`"$Entry`"" `
      -WorkingDirectory (Split-Path $Entry -Parent | Split-Path -Parent) `
      -PassThru -NoNewWindow
    $bridgePid = $proc.Id
    Write-Log "Bridge pid=$bridgePid"

    # Wait for exit, but also poll for Ctrl+C so the supervisor itself can be
    # stopped cleanly even when the child is wedged.
    while (!$proc.HasExited) {
      $keyAvailable = $false
      try { $keyAvailable = [Console]::KeyAvailable } catch { }
      if ($keyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'C' -and $key.Modifiers -eq 'Control') {
          Write-Log "Ctrl+C pressed — stopping bridge gracefully"
          $shuttingDown = $true
          # Try graceful window close first (sends WM_CLOSE)
          try { [void]$proc.CloseMainWindow() } catch {}
          # Give it a few seconds to shut down cleanly
          $grace = 0
          while (!$proc.HasExited -and $grace -lt 50) {
            Start-Sleep -Milliseconds 100
            $grace++
          }
          if (!$proc.HasExited) {
            Write-Log "Bridge did not exit gracefully, killing tree pid=$bridgePid"
            taskkill /PID $bridgePid /T /F 2>$null | Out-Null
          }
          break
        }
      }
      Start-Sleep -Milliseconds 200
    }

    # If we broke out because of Ctrl+C, the process may or may not have exited
    if (!$proc.HasExited) {
      try { taskkill /PID $bridgePid /T /F 2>$null | Out-Null } catch {}
      try { $proc.WaitForExit(3000) } catch {}
    }

    $exitCode = if ($proc.HasExited) { $proc.ExitCode } else { -1 }
    $runDuration = (Get-Date) - $runStart
    Write-Log "Bridge exited with code $exitCode after $($runDuration.TotalSeconds.ToString('F1'))s"

    if ($shuttingDown) {
      Write-Log "Supervisor shut down by user."
      break
    }

    # Exit code 0 = normal shutdown (SIGINT/SIGTERM handled inside bridge)
    if ($exitCode -eq 0) {
      Write-Log "Normal shutdown. Supervisor exiting."
      break
    }

    # Long run = success, reset counter
    if ($runDuration.TotalSeconds -ge $SuccessWindowSec) {
      Write-Log "Run lasted >= ${SuccessWindowSec}s, resetting crash counter"
      $consecutiveCrashes = 0
    } else {
      $consecutiveCrashes++
    }

    if ($consecutiveCrashes -ge $MaxRestarts) {
      Write-Log "MAX RESTARTS ($MaxRestarts) reached. Giving up."
      break
    }

    $delay = Get-Delay -Attempt $consecutiveCrashes
    Write-Log "Restarting in ${delay}s... ($consecutiveCrashes/$MaxRestarts)"
    Start-Sleep -Seconds $delay
  }
} catch {
  Write-Log "Supervisor fatal error: $_"
} finally {
  if ($bridgePid -and !$shuttingDown) {
    taskkill /PID $bridgePid /T /F 2>$null | Out-Null
  }
  Stop-Gateway
  Write-Log "Supervisor exited."
}
