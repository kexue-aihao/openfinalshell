param([int]$Seconds=600,[int]$Port=22349,[string]$OutputDirectory='build/terminal-responsiveness-20261116', [switch]$SkipBuild)
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repository
$resultDirectory=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null
if (-not $SkipBuild) {
    & dotnet build windows/OpenFinalShell.App -c Release -p:Platform=x64
    if ($LASTEXITCODE) { throw 'WinUI build failed' }
}
$appDirectory=Join-Path $repository 'windows/OpenFinalShell.App/bin/x64/Release/net10.0-windows10.0.26100.0/win-x64'
$runtimeDirectory=Join-Path $resultDirectory 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Copy-Item -Path (Join-Path $appDirectory '*') -Destination $runtimeDirectory -Recurse -Force
$server=Start-Process node -ArgumentList @('test/fixtures/testSshServer.mjs',$Port,$resultDirectory) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $resultDirectory 'ssh-server.log') -RedirectStandardError (Join-Path $resultDirectory 'ssh-server-error.log')
try {
    $env:OFS_NATIVE_TEST_MODE='1'
    $env:OFS_NATIVE_TEST_DATA_DIR=Join-Path $resultDirectory 'native-data'
    $env:OFS_NATIVE_TERMINAL_STRESS_FIXTURE='1'
    $env:OFS_TERMINAL_STRESS_PORT="$Port"
    $env:OFS_TERMINAL_STRESS_SECONDS="$Seconds"
    $app=Start-Process -FilePath (Join-Path $runtimeDirectory 'OpenFinalShell.App.exe') -WindowStyle Hidden -PassThru
    @{fixturePid=$server.Id;appPid=$app.Id;started=[DateTimeOffset]::UtcNow.ToString('O')} | ConvertTo-Json | Set-Content (Join-Path $resultDirectory 'run.json')
    if (-not $app.WaitForExit(($Seconds+60)*1000)) { Stop-Process -Id $app.Id; throw 'Fixture exceeded duration plus cleanup budget' }
    $report=Join-Path $env:OFS_NATIVE_TEST_DATA_DIR 'terminal-stress.json'
    if (-not (Test-Path -LiteralPath $report)) { throw 'Fixture exited without report; inspect startup-error.log' }
    Get-Content -LiteralPath $report
    $result=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if ($result.failures.Count) { throw ('Fixture failures: ' + ($result.failures -join '; ')) }
    if ($result.closeMs -gt 3000) { throw "Background cleanup exceeded 3 seconds: $($result.closeMs) ms" }
    $heartbeat=Join-Path $env:OFS_NATIVE_TEST_DATA_DIR 'ui-responsiveness.log'
    $summary=if (Test-Path -LiteralPath $heartbeat) { Get-Content -LiteralPath $heartbeat | Select-String 'summary samples=.*p99=([\d.]+)ms max=([\d.]+)ms' | Select-Object -Last 1 }
    if (-not $summary) { throw 'UI heartbeat summary missing' }
    $p99=[double]::Parse($summary.Matches[0].Groups[1].Value,[Globalization.CultureInfo]::InvariantCulture)
    $maximum=[double]::Parse($summary.Matches[0].Groups[2].Value,[Globalization.CultureInfo]::InvariantCulture)
    if ($p99 -gt 100 -or $maximum -gt 1000) { throw "UI latency exceeded threshold: p99=$p99 ms max=$maximum ms" }
    Write-Output "PASS: UI p99=$p99 ms max=$maximum ms cleanup=$($result.closeMs) ms"
} finally { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
