param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dependencyRoot = Join-Path $root '.local/native-deps'
New-Item -ItemType Directory -Force -Path $dependencyRoot | Out-Null

$downloads = @(
    @{ Name = 'llvm-mingw.zip'; Sha256 = 'FD5462B7F5D93B2FF981FCD3F9C7E427E47F3203C64EA91C27BCC444EEBD74CD'; Uri = 'https://github.com/mstorsjo/llvm-mingw/releases/download/20261020/llvm-mingw-20261020-ucrt-x86_64.zip' },
    @{ Name = 'libvterm-0.3.3.tar.gz'; Sha256 = '09156F43DD2128BD347CBEEBE50D9A571D32C64E0CF18D211197946AFF7226E0'; Uri = 'https://www.leonerd.org.uk/code/libvterm/libvterm-0.3.3.tar.gz' },
    @{ Name = 'scintilla557.zip'; Sha256 = '801FAEF6A2404EC4CBE6F22C853D9BB63FC5E18F169F302A9C69B9D6F93349DD'; Uri = 'https://www.scintilla.org/scintilla557.zip' },
    @{ Name = 'lexilla554.zip'; Sha256 = '5E0A21356E4E2F19D6A38ECD1C8172D5A2B7B4542940568B023386080DB90FE0'; Uri = 'https://www.scintilla.org/lexilla554.zip' }
)

foreach ($download in $downloads) {
    $path = Join-Path $dependencyRoot $download.Name
    $valid = $false
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $valid = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $download.Sha256
    }
    if (-not $valid) {
        Invoke-WebRequest -Uri $download.Uri -OutFile $path -MaximumRedirection 10
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        if ($actual -ne $download.Sha256) { throw "Checksum mismatch for $($download.Name): $actual" }
    }
}

$llvmRoot = Join-Path $dependencyRoot 'llvm/llvm-mingw-20261020-ucrt-x86_64'
if (!(Test-Path -LiteralPath (Join-Path $llvmRoot 'bin/clang.exe'))) {
    $llvmExtract = Join-Path $dependencyRoot 'llvm'
    New-Item -ItemType Directory -Force -Path $llvmExtract | Out-Null
    Expand-Archive -LiteralPath (Join-Path $dependencyRoot 'llvm-mingw.zip') -DestinationPath $llvmExtract -Force
}
$libvtermRoot = Join-Path $dependencyRoot 'libvterm-0.3.3'
if (!(Test-Path -LiteralPath (Join-Path $libvtermRoot 'src'))) {
    & tar.exe -xzf (Join-Path $dependencyRoot 'libvterm-0.3.3.tar.gz') -C $dependencyRoot
    if ($LASTEXITCODE) { throw 'libvterm extraction failed.' }
}
if (!(Test-Path -LiteralPath (Join-Path $llvmRoot 'bin/clang.exe'))) { throw 'Pinned LLVM toolchain is incomplete.' }
if (!(Test-Path -LiteralPath (Join-Path $libvtermRoot 'src'))) { throw 'Pinned libvterm source is incomplete.' }
Write-Output "Native build dependencies are ready: $dependencyRoot"
