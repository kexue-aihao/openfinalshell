param(
    [Parameter(Mandatory)][string]$InputDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Repository,
    [ValidateSet('x64','x86','arm64')][string]$Architecture,
    [ValidateSet('preview','stable')][string]$Channel = 'preview'
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$' -or $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid release identity.' }
$InputDirectory = (Resolve-Path -LiteralPath $InputDirectory).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$rsa = [Security.Cryptography.RSA]::Create()
$pinned = [Security.Cryptography.RSA]::Create()
try {
    $rsa.ImportFromPem([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OFS_NATIVE_UPDATE_PRIVATE_KEY_B64)))
    $pinned.ImportFromPem([IO.File]::ReadAllText((Join-Path $PSScriptRoot '../OpenFinalShell.Core/UpdatePublicKey.pem')))
    if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($rsa.ExportSubjectPublicKeyInfo(), $pinned.ExportSubjectPublicKeyInfo())) { throw 'Update signing key does not match the pinned public key.' }
    $dataName = "native-files-$Version-$Architecture.ofsdata"
    $dataPath = Join-Path $OutputDirectory $dataName
    $data = [IO.File]::Create($dataPath)
    $files = [Collections.Generic.List[object]]::new()
    try {
        foreach ($file in (Get-ChildItem -LiteralPath $InputDirectory -Recurse -File | Sort-Object FullName)) {
            $relative = [IO.Path]::GetRelativePath($InputDirectory, $file.FullName).Replace('\', '/')
            if ($relative -in @('native-files.json','native-files.signature.json')) { continue }
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot publish a symbolic link: $relative" }
            $offset = $data.Position
            $gzip = [IO.Compression.GZipStream]::new($data, [IO.Compression.CompressionLevel]::SmallestSize, $true)
            $input = [IO.File]::OpenRead($file.FullName)
            try { $input.CopyTo($gzip) } finally { $input.Dispose(); $gzip.Dispose() }
            $files.Add([ordered]@{ path=$relative; size=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); offset=$offset; length=$data.Position-$offset })
        }
    } finally { $data.Dispose() }
    if ($files.Count -eq 0 -or 'UpdateHost/OpenFinalShell.UpdateHost.exe' -notin $files.path) { throw 'Native updater is missing from the published application.' }
    $inventory = [ordered]@{ schemaVersion=1; version=$Version; channel=$Channel; architecture=$Architecture; dataUrl="https://github.com/$Repository/releases/download/v$Version/$dataName"; files=@($files.ToArray()) }
    $inventoryPath = Join-Path $OutputDirectory "native-files-$Architecture.json"
    [IO.File]::WriteAllText($inventoryPath, ($inventory | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $hash = (Get-FileHash -LiteralPath $inventoryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $signed = $rsa.SignData([Text.Encoding]::UTF8.GetBytes("$Version`n$Channel`n$hash`n"), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    Copy-Item -LiteralPath $inventoryPath -Destination (Join-Path $InputDirectory 'native-files.json') -Force
    $signature = [ordered]@{ Version=$Version; Channel=$Channel; Sha256=$hash; SignatureBase64=[Convert]::ToBase64String($signed) }
    [IO.File]::WriteAllText((Join-Path $InputDirectory 'native-files.signature.json'), ($signature | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Write-Output "Built signed file payload: $Architecture, $($files.Count) files, $((Get-Item -LiteralPath $dataPath).Length) bytes. Clients request only changed file ranges."
} finally { $rsa.Dispose(); $pinned.Dispose() }
