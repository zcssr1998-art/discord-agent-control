#Requires -Version 5.1
<#
.SYNOPSIS
  Install the pinned LiteLLM proxy into an isolated venv under data/litellm.

.DESCRIPTION
  No uv/Docker required: uses the local Python and a repo-local virtualenv.
  The installed version comes from scripts/litellm/VERSION so the gateway is
  reproducible. Nothing here is committed (.gitignore excludes data/).

  Usage:
    .\scripts\install-litellm.ps1
    .\scripts\install-litellm.ps1 -Version 1.101.0
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$VenvDir = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $VenvDir) { $VenvDir = Join-Path $repo 'data\litellm\venv' }
if (-not $Version) {
  $Version = (Get-Content (Join-Path $PSScriptRoot 'litellm\VERSION') -Raw).Trim()
}

function Find-Python {
  foreach ($candidate in @('python', 'py')) {
    try {
      $cmd = Get-Command $candidate -ErrorAction Stop
      & $cmd.Source --version *> $null
      if ($LASTEXITCODE -eq 0) { return $cmd.Source }
    } catch { }
  }
  throw 'Python was not found on PATH. Install Python 3.10+ and retry.'
}

$python = Find-Python
Write-Host "Using python: $python"

if ($Force -and (Test-Path $VenvDir)) {
  Write-Host "Removing existing venv at $VenvDir"
  Remove-Item -Recurse -Force $VenvDir
}
if (-not (Test-Path $VenvDir)) {
  Write-Host "Creating venv at $VenvDir"
  & $python -m venv $VenvDir
}

$venvPython = Join-Path $VenvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPython)) { throw "venv python not found at $venvPython" }

Write-Host "Installing litellm[proxy]==$Version (this can take a while)..."
& $venvPython -m pip install --no-input --disable-pip-version-check "litellm[proxy]==$Version"
if ($LASTEXITCODE -ne 0) { throw "pip install failed with exit code $LASTEXITCODE" }

$installed = (& $venvPython -m pip show litellm | Select-String '^Version:').ToString().Split(':')[1].Trim()
Set-Content -Path (Join-Path $repo 'data\litellm\installed-version.txt') -Value $installed -Encoding ascii
Write-Host "LiteLLM $installed installed."
Write-Host 'Next: scripts\start-litellm.ps1'
