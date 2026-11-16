param([switch]$SkipNativeBuild,[switch]$IncludeSshBurst)
$ErrorActionPreference='Stop'
Set-Location ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
if (-not $SkipNativeBuild) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/buildNativeTerminal.ps1
    if ($LASTEXITCODE) { throw 'Native terminal probe failed' }
}
& dotnet run --project windows/OpenFinalShell.Core.Tests -c Release
if ($LASTEXITCODE) { throw 'Core regression failed' }
& dotnet run --project windows/OpenFinalShell.Terminal.Tests -c Release -- --stress
if ($LASTEXITCODE) { throw 'Terminal processor regression failed' }
$previousBurst=$env:OFS_SSH_BURST_STRESS
try {
    if ($IncludeSshBurst) { $env:OFS_SSH_BURST_STRESS='1' }
    & dotnet run --project windows/OpenFinalShell.NativeSsh.Tests -c Release
    if ($LASTEXITCODE) { throw 'SSH transport regression failed' }
} finally { $env:OFS_SSH_BURST_STRESS=$previousBurst }
