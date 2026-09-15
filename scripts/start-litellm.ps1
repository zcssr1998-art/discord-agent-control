#Requires -Version 5.1
<#
.SYNOPSIS
  Start the pinned LiteLLM proxy on 127.0.0.1 only.

.DESCRIPTION
  Loads .env, resolves the OpenCode Go / DeepSeek keys from the environment or
  the local OpenCode auth store, ensures a local master key, then runs the
  gateway. Secrets are never written to this repository.

  Usage:
    .\scripts\start-litellm.ps1                 # detached, waits for health
    .\scripts\start-litellm.ps1 -Foreground     # for the supervisor
    .\scripts\start-litellm.ps1 -Port 4000
#>
[CmdletBinding()]
param(
  [int]$Port = 4000,
  [string]$HostName = '127.0.0.1',
  [switch]$Foreground,
  [int]$HealthTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$venvPython = Join-Path $repo 'data\litellm\venv\Scripts\python.exe'
$litellmExe = Join-Path $repo 'data\litellm\venv\Scripts\litellm.exe'
$config = Join-Path $PSScriptRoot 'litellm\config.yaml'
$dataDir = Join-Path $repo 'data\litellm'
$masterKeyFile = Join-Path $dataDir 'master-key'
$pidFile = Join-Path $dataDir 'gateway.pid'

if (-not (Test-Path $venvPython)) {
  throw 'LiteLLM is not installed. Run scripts\install-litellm.ps1 first.'
}

# --- load .env (does not overwrite already-set variables) -------------------
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $name = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim().Trim('"')
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

# --- resolve the OpenCode Go key from the local OpenCode auth store ---------
if (-not $env:OPENCODE_GO_API_KEY) {
  $authPath = Join-Path $env:USERPROFILE '.local\share\opencode\auth.json'
  if (Test-Path $authPath) {
    try {
      $auth = Get-Content $authPath -Raw | ConvertFrom-Json
      if ($auth.'opencode-go'.key) {
        $env:OPENCODE_GO_API_KEY = $auth.'opencode-go'.key
        Write-Host 'OPENCODE_GO_API_KEY resolved from the local OpenCode auth store.'
      }
    } catch { }
  }
}

# --- local master key --------------------------------------------------------
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
if (-not $env:LITELLM_MASTER_KEY) {
  if (-not (Test-Path $masterKeyFile)) {
    $bytes = New-Object 'System.Byte[]' 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [System.IO.File]::WriteAllText($masterKeyFile, $hex, (New-Object System.Text.UTF8Encoding($false)))
  }
  $env:LITELLM_MASTER_KEY = (Get-Content $masterKeyFile -Raw).Trim()
}
$env:LITELLM_MODE = 'PRODUCTION'
# raw.githubusercontent.com is blocked on some networks; the bundled cost map is
# enough for a local personal gateway.
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'

if (!(Test-Path $litellmExe)) { throw "litellm.exe not found at $litellmExe" }

$args = @('--config', $config, '--host', $HostName, '--port', $Port)
Write-Host "Starting LiteLLM $HostName`:$Port (config $config)"

if ($Foreground) {
  & $litellmExe @args
  exit $LASTEXITCODE
}

# Start-Process does not quote array elements, and this repository path contains
# a space, so quote the config path by hand.
$proc = Start-Process -FilePath $litellmExe -ArgumentList @('--config', "`"$config`"", '--host', $HostName, '--port', $Port) -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $dataDir 'gateway.out.log') `
  -RedirectStandardError (Join-Path $dataDir 'gateway.err.log')
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
Write-Host "LiteLLM pid=$($proc.Id)"

$health = "http://$HostName`:$Port/health/liveliness"
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { throw "LiteLLM exited early with code $($proc.ExitCode). See data\litellm\gateway.err.log" }
  try {
    $r = Invoke-WebRequest -Uri $health -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Write-Host "LiteLLM healthy at $health"; exit 0 }
  } catch { }
  Start-Sleep -Seconds 1
}
throw "LiteLLM did not become healthy within $HealthTimeoutSec s. See data\litellm\gateway.err.log"
