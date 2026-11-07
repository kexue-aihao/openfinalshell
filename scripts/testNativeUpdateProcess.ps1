param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root ('build/update-process-' + [Guid]::NewGuid().ToString('N')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$rsa = [Security.Cryptography.RSA]::Create(2048)
try {
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'test-private.pem'), $rsa.ExportPkcs8PrivateKeyPem())
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'test-public.pem'), $rsa.ExportSubjectPublicKeyInfoPem())
} finally { $rsa.Dispose() }
$helperOutput = Join-Path $OutputDirectory 'helper'
dotnet publish (Join-Path $root 'windows/OpenFinalShell.UpdateHost') -c Release -r win-x64 -o $helperOutput "-p:UpdatePublicKeyPath=$OutputDirectory/test-public.pem" --nologo -v quiet
if ($LASTEXITCODE) { throw 'Test updater build failed.' }
dotnet run --project (Join-Path $root 'windows/OpenFinalShell.Core.Tests') -c Release -- --prepare-update-process-fixture $OutputDirectory (Join-Path $helperOutput 'OpenFinalShell.UpdateHost.exe')
if ($LASTEXITCODE) { throw 'Test updater fixture preparation failed.' }
$env:OFS_UPDATE_PROCESS_FIXTURE = $OutputDirectory
try {
    $process = Start-Process -FilePath (Join-Path $OutputDirectory 'installed/OpenFinalShell.App.exe') -WorkingDirectory (Join-Path $OutputDirectory 'installed') -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline -and !(Test-Path (Join-Path $OutputDirectory 'restarted'))) {
        if (Test-Path (Join-Path $OutputDirectory 'parent-error.txt')) { throw [IO.File]::ReadAllText((Join-Path $OutputDirectory 'parent-error.txt')) }
        Start-Sleep -Milliseconds 300
    }
    $result = Join-Path $OutputDirectory 'restarted'
    if (!(Test-Path $result) -or [IO.File]::ReadAllText($result) -ne 'incremental-update-completed') { throw 'Update process did not exit, apply and restart successfully.' }
    Write-Output 'PASS: verified updater handshake, parent shutdown, file replacement and application restart.'
} finally { Remove-Item Env:OFS_UPDATE_PROCESS_FIXTURE -ErrorAction SilentlyContinue }
