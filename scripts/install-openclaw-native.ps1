[CmdletBinding()]
param(
    [switch]$Onboard
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $repoRoot "openclaw\version.json"

if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
    throw "Missing OpenClaw version file: $versionFile"
}

$meta = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
$targetVersion = [string]$meta.version
if ([string]::IsNullOrWhiteSpace($targetVersion)) {
    throw "OpenClaw version.json does not contain a version."
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @($machinePath, $userPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    if ($parts.Count -gt 0) {
        $env:Path = ($parts -join ";")
    }
}

function Resolve-OpenClawCommand {
    Refresh-ProcessPath
    $cmd = Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $cmd) {
        throw "OpenClaw installation returned, but 'openclaw' is not available on PATH. Open a new PowerShell session and run npm run openclaw:verify."
    }
    return $cmd.Source
}

Write-Host "[openclaw] target upstream version: $targetVersion"

$tempInstaller = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-install-{0}.ps1" -f $PID)
try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://openclaw.ai/install.ps1" -OutFile $tempInstaller
    if (-not (Test-Path -LiteralPath $tempInstaller -PathType Leaf)) {
        throw "Failed to download the official OpenClaw installer."
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempInstaller -Tag $targetVersion -NoOnboard
    if ($LASTEXITCODE -ne 0) {
        throw "Official OpenClaw installer failed with exit code $LASTEXITCODE."
    }
}
finally {
    Remove-Item -LiteralPath $tempInstaller -Force -ErrorAction SilentlyContinue
}

$openclaw = Resolve-OpenClawCommand
$installedVersion = (& $openclaw --version | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($installedVersion) -or $installedVersion -notmatch [regex]::Escape($targetVersion)) {
    throw "Version verification failed. Expected $targetVersion, got '$installedVersion'."
}

Write-Host "[openclaw] installed: $installedVersion"
Write-Host "[openclaw] legacy Jarvis was not modified or stopped."

if ($Onboard) {
    Write-Host "[openclaw] starting official onboarding..."
    & $openclaw onboard --install-daemon
    if ($LASTEXITCODE -ne 0) {
        throw "OpenClaw onboarding failed with exit code $LASTEXITCODE."
    }
} else {
    Write-Host "[openclaw] onboarding intentionally skipped."
    Write-Host "[openclaw] next: npm run openclaw:onboard"
}
