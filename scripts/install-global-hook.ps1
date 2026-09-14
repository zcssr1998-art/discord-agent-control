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
# `node` is not always on PATH (a sandboxed or freshly opened shell may not have
# it), so probe the usual install locations before falling back to the bare name.
function Resolve-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  # Join-Path throws when the root is null, and ProgramFiles(x86) is absent on
  # 32-bit-only or trimmed environments, so every root is guarded.
  function Join-IfRoot($root, $leaf) {
    if ([string]::IsNullOrWhiteSpace($root)) { return $null }
    return (Join-Path $root $leaf)
  }

  $candidates = @(
    (Join-IfRoot $env:ProgramFiles 'nodejs\node.exe'),
    (Join-IfRoot ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-IfRoot $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-IfRoot $env:APPDATA 'npm\node.exe'),
    (Join-IfRoot $env:ProgramData 'chocolatey\bin\node.exe'),
    # Literal fallbacks: the environment roots above can be empty (sandboxed or
    # service-spawned shells), which would otherwise make this silently give up.
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  ) | Where-Object { $_ }

  foreach ($c in $candidates) {
    if (Test-Path $c) { return (Resolve-Path $c).Path }
  }

  # Last resort: node.exe next to the `claude` shim that Claude Code uses.
  $shim = Get-Command claude -ErrorAction SilentlyContinue
  if ($shim) {
    $sibling = Join-Path (Split-Path $shim.Source -Parent) 'node.exe'
    if (Test-Path $sibling) { return (Resolve-Path $sibling).Path }
  }

  Write-Warning 'Could not locate node.exe; falling back to the bare `node` command. The hook will work as long as node is on PATH when Claude Code runs.'
  return 'node'
}

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
  $NodeExe = Resolve-NodeExe
  $command = '"' + $NodeExe + '" "' + $HookScript + '"'

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

# Write WITHOUT a BOM. PowerShell 5.1's `Set-Content -Encoding UTF8` prepends a
# UTF-8 BOM, and a BOM makes the file invalid JSON for strict parsers, which
# would silently stop Claude Code from ever loading the hook.
$json = $settings | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($SettingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))

if ($Uninstall) {
  Write-Host "Removed the Discord approval hook from: $SettingsPath"
} else {
  Write-Host "Installed Discord approval hook into: $SettingsPath"
  Write-Host "  command: $command"
  Write-Host 'Normal local Claude Code and the WebUI are unaffected: the hook only activates when the bridge sets DISCORD_BRIDGE_ACTIVE=1.'
}
