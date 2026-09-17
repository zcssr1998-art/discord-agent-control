#Requires -Version 5.1
<#
.DESCRIPTION
  P2.2B: remove ONLY the Jarvis-owned logon auto-start scheduled task.
  Never touches unrelated scheduled tasks.

  Usage:
    .\scripts\uninstall-autostart.ps1
    .\scripts\uninstall-autostart.ps1 -TaskName 'Jarvis Discord Agent Control'
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Jarvis Discord Agent Control'
)

$ErrorActionPreference = 'Stop'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Output "[autostart] task '$TaskName' is not installed; nothing to remove."
  return
}
# Tight namespace guard: the folder "\Jarvis Discord Agent Control" must be our
# own task name; refuse anything that does not match the canonical prefix.
if ($existing.TaskName -ne $TaskName) {
  throw "Refusing to remove task '$($existing.TaskName)': not the Jarvis-owned task."
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "[autostart] removed task '$TaskName'."
