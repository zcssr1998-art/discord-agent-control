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
  [string]$LogDir = "$PSScriptRoot\..\logs",
  [string]$Node = 'node',
  [string]$Entry = "$PSScriptRoot\..\src\index.mjs"
)

$ErrorActionPreference = 'Continue'
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

$consecutiveCrashes = 0
$bridgePid = $null
$shuttingDown = $false

# Ctrl+C handler
$null = [Console]::TreatControlCAsInput = $true

Write-Log "Supervisor starting. Entry=$Entry MaxRestarts=$MaxRestarts"

try {
  while ($consecutiveCrashes -lt $MaxRestarts) {
    $runStart = Get-Date
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
      if ([Console]::KeyAvailable) {
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
  Write-Log "Supervisor exited."
}
