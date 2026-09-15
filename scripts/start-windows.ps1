$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))

if (-not (Test-Path '.env')) {
  throw 'Missing .env. Copy .env.example to .env and fill DISCORD_TOKEN + DISCORD_OWNER_ID.'
}

if (-not (Test-Path 'node_modules')) {
  Write-Host 'Installing dependencies...'
  npm install
}

# Sanity-check credentials, proxy and intents before starting the bridge.
Write-Host 'Checking Discord credentials...'
node scripts\discord-doctor.mjs
if ($LASTEXITCODE -ne 0) { throw 'Discord credential check failed; fix .env and re-run.' }

# Primary model gateway. Best-effort: the bridge still serves Chat on direct
# providers if the gateway is absent or fails to start.
$litellmExe = Join-Path (Resolve-Path '.').Path 'data\litellm\venv\Scripts\litellm.exe'
if (Test-Path $litellmExe) {
  Write-Host 'Starting LiteLLM gateway...'
  try { & (Join-Path $PSScriptRoot 'start-litellm.ps1') | Out-Null }
  catch { Write-Host "LiteLLM start failed: $($_.Exception.Message). Continuing with direct providers." }
} else {
  Write-Host 'LiteLLM not installed. Run scripts\install-litellm.ps1 to enable the gateway.'
}

New-Item -ItemType Directory -Force -Path 'logs' | Out-Null
$LogFile = Join-Path (Resolve-Path 'logs').Path ('bridge-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')

Write-Host "Starting the bridge (Ctrl+C to stop). Console is also written to:"
Write-Host "  $LogFile"
Write-Host ''

node src\index.mjs 2>&1 | Tee-Object -FilePath $LogFile -Append
