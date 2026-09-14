# Installs (or removes) the Discord approval PreToolUse hook in the user-level
# Claude Code settings. The hook is inert for ordinary Claude Code: it exits
# immediately unless the Discord bridge launched the session
# (DISCORD_BRIDGE_ACTIVE=1).
#
#   .\scripts\install-global-hook.ps1
#   .\scripts\install-global-hook.ps1 -Uninstall
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$BridgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HookScript = Join-Path $BridgeRoot 'scripts\approval-hook.mjs'
$ClaudeDir = Join-Path $HOME '.claude'
$SettingsPath = Join-Path $ClaudeDir 'settings.json'

if (-not (Test-Path $HookScript)) { throw "Hook script not found: $HookScript" }
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null

if (Test-Path $SettingsPath) {
  $raw = Get-Content $SettingsPath -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) { $settings = [pscustomobject]@{} }
  else { $settings = $raw | ConvertFrom-Json }
} else {
  $settings = [pscustomobject]@{}
}

# Absolute node path so the hook does not depend on how Claude Code was launched.
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$command = '"' + $NodeExe + '" "' + $HookScript + '"'

function Get-HookCommands($settings) {
  $found = @()
  if ($settings.PSObject.Properties['hooks'] -and $settings.hooks.PSObject.Properties['PreToolUse']) {
    foreach ($group in @($settings.hooks.PreToolUse)) {
      foreach ($hook in @($group.hooks)) { if ($hook.command) { $found += [string]$hook.command } }
    }
  }
  return $found
}

function Remove-OurHook($settings) {
  if (-not ($settings.PSObject.Properties['hooks'] -and $settings.hooks.PSObject.Properties['PreToolUse'])) { return $settings }
  $kept = @()
  foreach ($group in @($settings.hooks.PreToolUse)) {
    $hooks = @()
    foreach ($hook in @($group.hooks)) {
      $cmd = [string]$hook.command
      if ($cmd -notlike "*approval-hook.mjs*") { $hooks += $hook }
    }
    if ($hooks.Count -gt 0) {
      $group.hooks = $hooks
      $kept += $group
    }
  }
  $settings.hooks.PreToolUse = $kept
  return $settings
}

$settings = Remove-OurHook $settings

if (-not $Uninstall) {
  if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $settings.hooks.PSObject.Properties['PreToolUse']) {
    $settings.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @()
  }
  $entry = [pscustomobject]@{
    hooks = @(
      [pscustomobject]@{
        type          = 'command'
        command       = $command
        timeout       = 600
        statusMessage = 'Waiting for Discord approval when required'
      }
    )
  }
  $settings.hooks.PreToolUse = @($settings.hooks.PreToolUse) + @($entry)
}

$settings | ConvertTo-Json -Depth 20 | Set-Content -Path $SettingsPath -Encoding UTF8

if ($Uninstall) {
  Write-Host "Removed the Discord approval hook from: $SettingsPath"
} else {
  Write-Host "Installed Discord approval hook into: $SettingsPath"
  Write-Host "  command: $command"
  Write-Host 'Normal local Claude Code and the WebUI are unaffected: the hook only activates when the bridge sets DISCORD_BRIDGE_ACTIVE=1.'
}
