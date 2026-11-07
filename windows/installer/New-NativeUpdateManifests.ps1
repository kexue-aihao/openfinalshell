param(
    [Parameter(Mandatory)][string]$InstallerDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Repository,
    [ValidateSet('preview','stable')][string]$Channel = 'preview',
    [string]$TagPrefix = 'v',
    [ValidateSet('x64','x86','arm64')][string[]]$Architectures = @('x64','x86','arm64')
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid native update version: $Version" }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Invalid GitHub repository: $Repository" }
$encodedKey = $env:OFS_NATIVE_UPDATE_PRIVATE_KEY_B64
if ([string]::IsNullOrWhiteSpace($encodedKey)) { throw 'OFS_NATIVE_UPDATE_PRIVATE_KEY_B64 is required.' }
$InstallerDirectory = [IO.Path]::GetFullPath($InstallerDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$publicKeyPath = Join-Path $PSScriptRoot '../OpenFinalShell.Core/UpdatePublicKey.pem'
if (!(Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) { throw 'Pinned native update public key is missing.' }

try { $privateKeyPem = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedKey)) }
catch { throw 'NATIVE_UPDATE_PRIVATE_KEY_B64 is not valid base64.' }
$privateRsa = [Security.Cryptography.RSA]::Create()
$publicRsa = [Security.Cryptography.RSA]::Create()
try {
    try { $privateRsa.ImportFromPem($privateKeyPem) } catch { throw 'The native update private key is not a valid PEM key.' }
    try { $privateRsa.ExportParameters($true) | Out-Null } catch { throw 'The supplied native update key does not contain a private key.' }
    $publicRsa.ImportFromPem([IO.File]::ReadAllText($publicKeyPath))
    $privatePublic = $privateRsa.ExportSubjectPublicKeyInfo()
    $pinnedPublic = $publicRsa.ExportSubjectPublicKeyInfo()
    if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($privatePublic, $pinnedPublic)) {
        throw 'The native update private key does not match UpdatePublicKey.pem.'
    }

    $tag = "$TagPrefix$Version"
    foreach ($architecture in $Architectures) {
        $displayArchitecture = if ($architecture -eq 'arm64') { 'ARM64' } else { $architecture }
        $fileName = "OpenFinalShell-NativePreview-$Version-$displayArchitecture-Setup.exe"
        $installerPath = Join-Path $InstallerDirectory $fileName
        if (!(Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "Native installer is missing: $installerPath" }
        $stream = [IO.File]::OpenRead($installerPath)
        try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
        finally { $stream.Dispose() }
        $signedText = "$Version`n$Channel`n$hash`n"
        $signature = $privateRsa.SignData(
            [Text.Encoding]::UTF8.GetBytes($signedText),
            [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $entry = [ordered]@{
            schemaVersion = 1
            version = $Version
            channel = $Channel
            architecture = $architecture
            fileName = $fileName
            downloadUrl = "https://github.com/$Repository/releases/download/$tag/$fileName"
            sha256 = $hash
            signature = [Convert]::ToBase64String($signature)
            bytes = (Get-Item -LiteralPath $installerPath).Length
            publishedAt = [DateTimeOffset]::UtcNow.ToString('O')
            notesUrl = "https://github.com/$Repository/releases/tag/$tag"
        }
        $outputPath = Join-Path $OutputDirectory "native-update-$architecture.json"
        $inventoryName = "native-files-$architecture.json"
        $inventoryPath = Join-Path $InstallerDirectory $inventoryName
        if (!(Test-Path -LiteralPath $inventoryPath)) { throw "Signed file inventory missing: $inventoryName" }
        $inventoryHash = (Get-FileHash -LiteralPath $inventoryPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $inventorySignature = $privateRsa.SignData([Text.Encoding]::UTF8.GetBytes("$Version`n$Channel`n$inventoryHash`n"), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $entry.incremental = [ordered]@{
            schemaVersion = 1; version = $Version; channel = $Channel; architecture = $architecture
            fileName = $inventoryName; downloadUrl = "https://github.com/$Repository/releases/download/$tag/$inventoryName"
            sha256 = $inventoryHash; signature = [Convert]::ToBase64String($inventorySignature)
            bytes = (Get-Item -LiteralPath $inventoryPath).Length
        }
        $json = $entry | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText($outputPath, "$json`n", [Text.UTF8Encoding]::new($false))
        Write-Output "Signed native update manifest: $outputPath"
    }
}
finally {
    $privateKeyPem = $null
    $encodedKey = $null
    $privateRsa.Dispose()
    $publicRsa.Dispose()
}
