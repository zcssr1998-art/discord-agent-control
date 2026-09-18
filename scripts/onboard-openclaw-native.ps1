[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$cmd = Get-Command openclaw -CommandType Application -ErrorAction Stop |
    Select-Object -First 1

Write-Host "[openclaw] launching official onboarding."
Write-Host "[openclaw] this is the first step that may create runtime configuration or a managed Gateway."
& $cmd.Source onboard --install-daemon
if ($LASTEXITCODE -ne 0) {
    throw "OpenClaw onboarding failed with exit code $LASTEXITCODE."
}
