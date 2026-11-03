param([ValidateSet('x64','x86','ARM64')][string]$Architecture='x64', [string]$Version, [string]$InputDirectory, [string]$OutputDirectory)
$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '../..')
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid native installer version: $Version" }
$makensis=Get-Command makensis.exe -ErrorAction SilentlyContinue
if (!$makensis) {
  $knownPaths = @(
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
    (Join-Path $env:ProgramFiles 'NSIS\makensis.exe')
  )
  foreach ($candidate in $knownPaths) {
    if (!$makensis -and $candidate -and (Test-Path -LiteralPath $candidate)) {
      $makensis = Get-Item -LiteralPath $candidate
    }
  }
}
if (!$makensis) { throw 'NSIS (makensis.exe) is required to build the native preview installer.' }
$makensisPath = if ($makensis.PSObject.Properties.Name -contains 'Source') { $makensis.Source } else { $makensis.FullName }
$inputDir=if ([string]::IsNullOrWhiteSpace($InputDirectory)) { Join-Path $root "build/native-preview/$Architecture" } else { [IO.Path]::GetFullPath($InputDirectory) }
if (!(Test-Path (Join-Path $inputDir 'OpenFinalShell.App.exe'))) { throw "Build native preview first: $inputDir" }
$outDir=if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { Join-Path $root 'build/native-installer' } else { [IO.Path]::GetFullPath($OutputDirectory) }; New-Item -ItemType Directory -Force $outDir | Out-Null
& $makensisPath "/DINPUT_DIR=$inputDir" "/DARCH=$Architecture" "/DVERSION=$Version" "/DOUT_DIR=$outDir" (Join-Path $PSScriptRoot 'OpenFinalShell.NativePreview.nsi')
if ($LASTEXITCODE) { throw "NSIS failed for $Architecture" }
$setup = Join-Path $outDir "OpenFinalShell-NativePreview-$Version-$Architecture-Setup.exe"
if (!(Test-Path -LiteralPath $setup)) { throw "Expected installer was not created: $setup" }
Write-Output $setup
