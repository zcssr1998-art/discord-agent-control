$ErrorActionPreference = 'Stop'
$BridgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HookScript = Join-Path $BridgeRoot 'scripts\approval-hook.mjs'
$ClaudeDir = Join-Path $HOME '.claude'
$SettingsPath = Join-Path $ClaudeDir 'settings.json'
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null

if (Test-Path $SettingsPath) {
  $settings = Get-Content $SettingsPath -Raw | ConvertFrom-Json
} else {
  $settings = [pscustomobject]@{}
}

if (-not $settings.PSObject.Properties['hooks']) {
  $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}
if (-not $settings.hooks.PSObject.Properties['PreToolUse']) {
  $settings.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @()
}

$command = 'node "' + $HookScript + '"'
$exists = $false
foreach ($group in @($settings.hooks.PreToolUse)) {
  foreach ($hook in @($group.hooks)) {
    if ($hook.command -eq $command) { $exists = $true }
  }
}

if (-not $exists) {
  $entry = [pscustomobject]@{
    hooks = @(
      [pscustomobject]@{
        type = 'command'
        command = $command
        timeout = 600
        statusMessage = 'Waiting for Discord approval when required'
      }
    )
  }
  $settings.hooks.PreToolUse = @($settings.hooks.PreToolUse) + @($entry)
}

$settings | ConvertTo-Json -Depth 20 | Set-Content -Path $SettingsPath -Encoding UTF8
Write-Host "Installed Discord approval hook: $SettingsPath"
Write-Host 'Normal Claude Code is unaffected unless DISCORD_BRIDGE_ACTIVE=1.'
