#Requires -Version 5.1
<#
.DESCRIPTION
  P2.2B: install/update the CURRENT-USER logon auto-start scheduled task.

  One canonical task per Windows user: "Jarvis Discord Agent Control". Instead
  of starting node directly it starts THIS checkout's supervisor
  (scripts/start-supervisor.ps1), which owns bridge restart/backoff and the
  LiteLLM lifecycle. Re-running this installer UPDATES the existing task to the
  current checkout; it never creates duplicates and never touches unrelated
  tasks. No stored password, no administrator requirement.

  Usage:
    .\scripts\install-autostart.ps1            # install/update
    .\scripts\install-autostart.ps1 -DryRun    # preview only
    .\scripts\install-autostart.ps1 -Status    # show effective task state
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Status,
  [string]$TaskName = 'Jarvis Discord Agent Control',
  # Startup delay so network/proxy/user profile are ready after logon.
  [string]$DelaySeconds = '15'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot 'logs') | Out-Null
$Supervisor = Join-Path $RepoRoot 'scripts\start-supervisor.ps1'

function Test-SupervisorExists {
  if (-not (Test-Path -LiteralPath $Supervisor)) {
    throw "Supervisor script not found: $Supervisor"
  }
}

Test-SupervisorExists

if ($Status) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Output "TaskName: $TaskName"
    Write-Output "Present:  false"
    return
  }
  $action = ($existing.Actions | Select-Object -First 1)
  $settings = $existing.Settings
  Write-Output ("TaskName: {0}" -f $existing.TaskName)
  Write-Output ("State:    {0}" -f $existing.State)
  Write-Output ("Action:   {0} {1}" -f $action.Execute, $action.Arguments)
  Write-Output ("ExecutionTimeLimit: {0}" -f $(if (-not $settings.ExecutionTimeLimit) { 'PT0S (unlimited)' } else { $settings.ExecutionTimeLimit }))
  Write-Output ("StartWhenAvailable: {0}" -f $settings.StartWhenAvailable)
  Write-Output ("RestartCount:       {0}" -f $settings.RestartCount)
  Write-Output ("RestartInterval:    {0}" -f $settings.RestartInterval)
  Write-Output ("MultipleInstances:  {0}" -f $settings.MultipleInstances)
  $watchdog = $existing.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
  if ($watchdog) { Write-Output ("WatchdogRepetition: {0}" -f $watchdog.Repetition.Interval) }
  else { Write-Output "WatchdogRepetition: none" }
  return
}

# Action: native PowerShell launch of the supervisor. No cmd.exe hop means the
# supervisor owns its own console/process lifetime and its exit code reaches the
# Task Scheduler restart-on-failure policy directly.
Test-SupervisorExists
$SupervisorArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $Supervisor
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument $SupervisorArgs `
  -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
try { $Trigger.Delay = "PT$DelaySeconds" + 'S' } catch { Write-Verbose "Trigger delay unsupported: $($_.Exception.Message)" }

# Level 2 recovery. Windows-native and layered:
#  - "restart on failure" (kept requested by spec, but Windows does not honor it
#    for an externally terminated process on this machine);
#  - a 1-minute repeating watchdog trigger, which IS the reliable recovery path:
#    while the supervisor runs the repeat is a no-op (MultipleInstances
#    IgnoreNew); once the supervisor is gone the next repeat starts it again.
# The supervisor then restores LiteLLM + the bridge and Jarvis returns ONLINE.
$Watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit 0 `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if ($DryRun) {
  Write-Output "[dryrun] TaskName: $TaskName"
  Write-Output "[dryrun] Trigger:  at logon for $($env:USERNAME), delay ${DelaySeconds}s"
  Write-Output "[dryrun] Action:   $($Action.Execute)"
  Write-Output "[dryrun] Args:     $($Action.Arguments)"
  Write-Output "[dryrun] WorkingDir: $RepoRoot"
  Write-Output "[dryrun] Principal: user=$($env:USERNAME) logon=Interactive runLevel=Limited"
  Write-Output "[dryrun] Triggers:  AtLogOn(delay ${DelaySeconds}s) + watchdog repeat every 1 minute (IgnoreNew)"
  Write-Output "[dryrun] Restart:   count=$($Settings.RestartCount) interval=$($Settings.RestartInterval) (restart on failure)"
  Write-Output "[dryrun] Limits:    ExecutionTimeLimit=$($Settings.ExecutionTimeLimit) StartWhenAvailable=$($Settings.StartWhenAvailable)"
  return
}

# Idempotent: re-running replaces the canonical task by name (update in place).
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
Start-Sleep -Milliseconds 500
Register-ScheduledTask -TaskName $TaskName -Force `
  -Action $Action -Trigger @($Trigger, $Watchdog) -Settings $Settings -Principal $Principal `
  -Description 'Jarvis Discord Agent Control bridge + LiteLLM supervisor (logon auto-start + 1-min watchdog).' | Out-Null

Write-Output "[autostart] installed: task='$TaskName'"
Write-Output "[autostart] args:      $($Action.Execute) $($Action.Arguments)"
Write-Output "[autostart] triggers:  AtLogOn(delay ${DelaySeconds}s) + watchdog repeat every 1 minute (IgnoreNew)"
Write-Output "[autostart] restart:   on failure every $($Settings.RestartInterval) for up to $($Settings.RestartCount) attempts"
Write-Output "[autostart] limits:    ExecutionTimeLimit=unlimited StartWhenAvailable=$($Settings.StartWhenAvailable)"
Write-Output "[autostart] supervisor log: $RepoRoot\logs\supervisor.log"
