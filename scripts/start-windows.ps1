$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))

if (-not (Test-Path '.env')) {
  throw 'Missing .env. Copy .env.example to .env and fill DISCORD_TOKEN + DISCORD_OWNER_ID.'
}

if (-not (Test-Path 'node_modules')) {
  Write-Host 'Installing dependencies...'
  npm install
}

# Sanity-check the bot token / owner ID before starting the bridge.
Write-Host 'Checking Discord credentials...'
node scripts\discord-doctor.mjs
if ($LASTEXITCODE -ne 0) { throw 'Discord credential check failed; fix .env and re-run.' }

Write-Host 'Starting the bridge (Ctrl+C to stop)...'
node src\index.mjs
