$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture = Join-Path $root ('build/file-payload-' + [Guid]::NewGuid().ToString('N'))
$inputDirectory = Join-Path $fixture 'input'
$outputDirectory = Join-Path $fixture 'output'
$scriptDirectory = Join-Path $fixture 'installer'
foreach ($directory in @($inputDirectory, $outputDirectory, $scriptDirectory, (Join-Path $inputDirectory 'UpdateHost'), (Join-Path $fixture 'OpenFinalShell.Core'))) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
foreach ($name in @('New-NativeFilePayload.ps1','New-NativeUpdateManifests.ps1')) { Copy-Item -LiteralPath (Join-Path $root "windows/installer/$name") -Destination $scriptDirectory }
$rsa = [Security.Cryptography.RSA]::Create(2048)
try {
    [IO.File]::WriteAllText((Join-Path $fixture 'OpenFinalShell.Core/UpdatePublicKey.pem'), $rsa.ExportSubjectPublicKeyInfoPem())
    $env:OFS_NATIVE_UPDATE_PRIVATE_KEY_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rsa.ExportPkcs8PrivateKeyPem()))
    [IO.File]::WriteAllText((Join-Path $inputDirectory 'OpenFinalShell.App.exe'), 'fixture executable')
    [IO.File]::WriteAllText((Join-Path $inputDirectory 'UpdateHost/OpenFinalShell.UpdateHost.exe'), 'fixture helper')
    & (Join-Path $scriptDirectory 'New-NativeFilePayload.ps1') -InputDirectory $inputDirectory -OutputDirectory $outputDirectory -Version '1.2.3' -Repository 'fixture/project' -Architecture x64
    [IO.File]::WriteAllText((Join-Path $outputDirectory 'OpenFinalShell-Native-1.2.3-x64-Setup.exe'), 'fixture installer')
    & (Join-Path $scriptDirectory 'New-NativeUpdateManifests.ps1') -InstallerDirectory $outputDirectory -OutputDirectory $outputDirectory -Version '1.2.3' -Repository 'fixture/project' -Architectures x64
    $feed = Get-Content (Join-Path $outputDirectory 'native-update-x64.json') -Raw | ConvertFrom-Json
    $inventory = Get-Content (Join-Path $outputDirectory 'native-files-x64.json') -Raw | ConvertFrom-Json
    foreach ($descriptor in @($feed, $feed.incremental)) {
        $hash = (Get-FileHash -LiteralPath (Join-Path $outputDirectory $descriptor.fileName) -Algorithm SHA256).Hash.ToLowerInvariant()
        $valid = $rsa.VerifyData([Text.Encoding]::UTF8.GetBytes("$($descriptor.version)`n$($descriptor.channel)`n$hash`n"), [Convert]::FromBase64String($descriptor.signature), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        if (!$valid -or $hash -ne $descriptor.sha256) { throw 'Generated feed signature did not verify.' }
    }
    $data = [IO.File]::ReadAllBytes((Join-Path $outputDirectory 'native-files-1.2.3-x64.ofsdata'))
    foreach ($entry in $inventory.files) {
        $segment = [IO.MemoryStream]::new($data, [int]$entry.offset, [int]$entry.length, $false)
        $gzip = [IO.Compression.GZipStream]::new($segment, [IO.Compression.CompressionMode]::Decompress)
        $decoded = [IO.MemoryStream]::new()
        try {
            $gzip.CopyTo($decoded)
            $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($decoded.ToArray())).ToLowerInvariant()
            if ($decoded.Length -ne $entry.size -or $hash -ne $entry.sha256) { throw 'Generated file range did not decode to the signed file.' }
        } finally { $decoded.Dispose(); $gzip.Dispose(); $segment.Dispose() }
    }
    if ($feed.channel -ne 'stable' -or $inventory.channel -ne 'stable') { throw 'Native release channel must be stable.' }
    & (Join-Path $scriptDirectory 'New-NativeFilePayload.ps1') -InputDirectory $inputDirectory -OutputDirectory $outputDirectory -Version '0.30.52' -Repository 'fixture/project' -Architecture x64
    [IO.File]::WriteAllText((Join-Path $outputDirectory 'OpenFinalShell-Native-0.30.52-x64-Setup.exe'), 'stable installer')
    & (Join-Path $scriptDirectory 'New-NativeUpdateManifests.ps1') -InstallerDirectory $outputDirectory -OutputDirectory $outputDirectory -Version '0.30.52' -Repository 'fixture/project' -Architectures x64
    $promotionFeed = Get-Content (Join-Path $outputDirectory 'native-update-x64.json') -Raw | ConvertFrom-Json
    if ($promotionFeed.incremental -or $promotionFeed.channel -ne 'stable' -or $promotionFeed.fileName -ne 'OpenFinalShell-Native-0.30.52-x64-Setup.exe') { throw 'Stable promotion must use the renamed full installer.' }
    if (!$rsa.VerifyData([Text.Encoding]::UTF8.GetBytes("$($promotionFeed.version)`n$($promotionFeed.channel)`n$($promotionFeed.sha256)`n"), [Convert]::FromBase64String($promotionFeed.signature), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)) { throw 'Promotion feed signature did not verify.' }
    Write-Output "PASS: signed legacy/incremental feeds and all $($inventory.files.Count) gzip file ranges verified."
} finally { $rsa.Dispose(); Remove-Item Env:OFS_NATIVE_UPDATE_PRIVATE_KEY_B64 -ErrorAction SilentlyContinue }
