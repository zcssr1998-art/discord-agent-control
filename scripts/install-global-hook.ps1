# Installs (or removes) the Discord approval PreToolUse hook in the user-level
# agent settings. The hook is inert for ordinary sessions: it exits immediately
# unless the Discord bridge launched the session (DISCORD_BRIDGE_ACTIVE=1).
#
# Two agent shells are supported because they are the same Claude Code style
# protocol but read different settings files:
#   claude    -> ~/.claude/settings.json    (Anthropic Claude Code)
#   codebuddy -> ~/.codebuddy/settings.json (WorkBuddy agent CLI)
#
#   .\scripts\install-global-hook.ps1                    # both
#   .\scripts\install-global-hook.ps1 -Target codebuddy  # WorkBuddy only
#   .\scripts\install-global-hook.ps1 -Uninstall         # remove from both
param(
  [ValidateSet('claude', 'codebuddy', 'both')]
  [string]$Target = 'both',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$BridgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HookScript = Join-Path $BridgeRoot 'scripts\approval-hook.mjs'

if (-not (Test-Path $HookScript)) { throw "Hook script not found: $HookScript" }

# Absolute node path so the hook does not depend on how the agent was launched.
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

  Write-Warning 'Could not locate node.exe; falling back to the bare `node` command. The hook will work as long as node is on PATH when the agent runs.'
  return 'node'
}

function Get-SettingsPath($name) {
  if ($name -eq 'codebuddy') { return (Join-Path $HOME '.codebuddy\settings.json') }
  return (Join-Path $HOME '.claude\settings.json')
}

function Read-Settings($path) {
  if (-not (Test-Path $path)) { return [pscustomobject]@{} }
  $raw = Get-Content $path -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{} }
  return ($raw | ConvertFrom-Json)
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

# Write WITHOUT a BOM. PowerShell 5.1's `Set-Content -Encoding UTF8` prepends a
# UTF-8 BOM, and a BOM makes the file invalid JSON for strict parsers, which
# would silently stop the agent from ever loading the hook.
function Write-Settings($path, $settings) {
  $dir = Split-Path $path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $json = $settings | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$targets = if ($Target -eq 'both') { @('claude', 'codebuddy') } else { @($Target) }
$NodeExe = $null
if (-not $Uninstall) { $NodeExe = Resolve-NodeExe }

foreach ($name in $targets) {
  $path = Get-SettingsPath $name
  $settings = Read-Settings $path
  $settings = Remove-OurHook $settings

  if (-not $Uninstall) {
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

  Write-Settings $path $settings

  if ($Uninstall) {
    Write-Host "Removed the Discord approval hook from: $path"
  } else {
    Write-Host "Installed Discord approval hook into: $path"
  }
}

if (-not $Uninstall) {
  Write-Host "  command: `"$NodeExe`" `"$HookScript`""
  Write-Host 'Ordinary sessions are unaffected: the hook only activates when the bridge sets DISCORD_BRIDGE_ACTIVE=1.'
}
