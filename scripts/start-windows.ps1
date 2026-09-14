$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
if (-not (Test-Path '.env')) { throw 'Missing .env. Copy .env.example to .env and fill Discord token + owner ID.' }
npm install
node src\index.mjs
