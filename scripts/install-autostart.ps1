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
$LogDirWrapper = Join-Path $RepoRoot 'logs\wrapper.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogDirWrapper) | Out-Null
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
  Write-Output ("TaskName: {0}" -f $existing.TaskName)
  Write-Output ("State:    {0}" -f $existing.State)
  Write-Output ("Action:   {0} {1}" -f $action.Execute, $action.Arguments)
  return
}

# Action: a cmd root bootstrap (scripts\start-supervisor-autostart.cmd) so
# path-with-spaces + output redirection are handled by Windows cmd ntlookup
# reliably; hidden output is not suppressed in console-based scheduled tasks.
$Bootstrap = Join-Path $RepoRoot 'scripts\start-supervisor-autostart.cmd'
Test-SupervisorExists
$Action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument ('/c ""{0}""' -f $Bootstrap) `
  -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
try { $Trigger.Delay = "PT$DelaySeconds" + 'S' } catch { Write-Verbose "Trigger delay unsupported: $($_.Exception.Message)" }

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit 0 `
  -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if ($DryRun) {
  Write-Output "[dryrun] TaskName: $TaskName"
  Write-Output "[dryrun] Trigger:  at logon for $($env:USERNAME), delay ${DelaySeconds}s"
  Write-Output "[dryrun] Action:   $($Action.Execute)"
  Write-Output "[dryrun] Args:     $($Action.Arguments)"
  Write-Output "[dryrun] WorkingDir: $RepoRoot"
  Write-Output "[dryrun] Principal: user=$($env:USERNAME) logon=Interactive runLevel=Limited"
  return
}

# Idempotent: re-running replaces the canonical task by name (update in place).
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
Start-Sleep -Milliseconds 500
Register-ScheduledTask -TaskName $TaskName -Force `
  -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
  -Description 'Jarvis Discord Agent Control bridge + LiteLLM supervisor (logon auto-start).' | Out-Null

Write-Output "[autostart] installed: task='$TaskName'"
Write-Output "[autostart] args:      $($Action.Execute) $($Action.Arguments)"
Write-Output "[autostart] supervisor log: $RepoRoot\logs\supervisor.log"
