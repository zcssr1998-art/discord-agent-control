[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$meta = Get-Content -LiteralPath (Join-Path $repoRoot "openclaw\version.json") -Raw | ConvertFrom-Json
$targetVersion = [string]$meta.version

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($machinePath, $userPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
if ($parts.Count -gt 0) {
    $env:Path = ($parts -join ";")
}

$cmd = Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $cmd) {
    throw "OpenClaw is not installed or is not available on PATH."
}

$version = (& $cmd.Source --version | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($version) -or $version -notmatch [regex]::Escape($targetVersion)) {
    throw "Expected OpenClaw $targetVersion, got '$version'."
}

& $cmd.Source --help *> $null
if ($LASTEXITCODE -ne 0) {
    throw "OpenClaw CLI help probe failed with exit code $LASTEXITCODE."
}

Write-Host "PASS"
Write-Host "openclaw: $version"
Write-Host "binary: $($cmd.Source)"
Write-Host "customized: false"
