param(
    [ValidateSet('x64')][string]$Architecture = 'x64',
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dependencyRoot = Join-Path $root '.local/native-deps'
$llvmRoot = Join-Path $dependencyRoot 'llvm/llvm-mingw-20261020-ucrt-x86_64'
$scintillaArchive = Join-Path $dependencyRoot 'scintilla557.zip'
$lexillaArchive = Join-Path $dependencyRoot 'lexilla554.zip'
$toolBin = Join-Path $llvmRoot 'bin'
$compiler = Join-Path $toolBin 'x86_64-w64-mingw32-g++.exe'
$make = Join-Path $toolBin 'mingw32-make.exe'
$windres = Join-Path $toolBin 'windres.exe'

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $root "build/native-editor/$Architecture"
} elseif (-not [IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path $root $OutputDirectory
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$sources = Join-Path $OutputDirectory 'sources'
$logPath = Join-Path $OutputDirectory 'build.log'

foreach ($required in @($scintillaArchive, $lexillaArchive, $compiler, $make, $windres)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required pinned native editor dependency is missing: $required"
    }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory, $sources | Out-Null
Expand-Archive -LiteralPath $scintillaArchive -DestinationPath $sources -Force
Expand-Archive -LiteralPath $lexillaArchive -DestinationPath $sources -Force

# The pinned source omits this direct include; libc++ no longer provides it
# transitively through string_view. Apply the compatibility fix only to the
# isolated build copy, never to the downloaded archive or checked-out sources.
foreach ($name in @('ListBox.cxx', 'SurfaceD2D.cxx')) {
    $path = Join-Path $sources "scintilla/win32/$name"
    $source = [IO.File]::ReadAllText($path)
    if ($source -notmatch '#include <string>') {
        $source = $source.Replace('#include <string_view>', "#include <string_view>`n#include <string>")
        [IO.File]::WriteAllText($path, $source, [Text.UTF8Encoding]::new($false))
    }
}

$env:PATH = "$toolBin;$env:PATH"
Push-Location (Join-Path $sources 'scintilla/win32')
try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $make "CXX=$compiler" "WINDRES=$windres" "DIR_BIN=$OutputDirectory" -j4 2>&1 | Tee-Object -FilePath $logPath
    $makeExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($makeExitCode -ne 0) { throw "Scintilla build failed with exit code $makeExitCode" }
} finally { Pop-Location }

Push-Location (Join-Path $sources 'lexilla/src')
try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $make "CXX=$compiler" "WINDRES=$windres" "DIR_BIN=$OutputDirectory" 'LDFLAGS=-shared -mwindows -static' -j4 2>&1 | Tee-Object -FilePath $logPath -Append
    $makeExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($makeExitCode -ne 0) { throw "Lexilla build failed with exit code $makeExitCode" }
} finally { Pop-Location }

$scintillaLicense = Get-Content -LiteralPath (Join-Path $sources 'scintilla/License.txt') -Raw
$lexillaLicense = Get-Content -LiteralPath (Join-Path $sources 'lexilla/License.txt') -Raw
$notices = "Scintilla 5.57 license`n`n$scintillaLicense`n`nLexilla 5.54 license`n`n$lexillaLicense"
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'THIRD-PARTY-LICENSES.txt'), $notices, [Text.UTF8Encoding]::new($false))

Get-FileHash (Join-Path $OutputDirectory 'Scintilla.dll'), (Join-Path $OutputDirectory 'Lexilla.dll') -Algorithm SHA256
