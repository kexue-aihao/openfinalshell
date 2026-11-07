param(
  [ValidateSet('x64','x86','ARM64')][string]$Architecture='x64',
  [switch]$Publish,
  [string]$Version,
  [string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '..')
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid native version: $Version" }
$rid=@{x64='win-x64';x86='win-x86';ARM64='win-arm64'}[$Architecture]
$platform=$Architecture
$project=Join-Path $PSScriptRoot 'OpenFinalShell.App/OpenFinalShell.App.csproj'
$output=if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { Join-Path $root "build/native-preview/$Architecture" } else { [IO.Path]::GetFullPath($OutputDirectory) }
New-Item -ItemType Directory -Force $output | Out-Null
$platformArg = "-p:Platform=$platform"
Push-Location $PSScriptRoot
try {
  dotnet restore $project -r $rid --disable-parallel
  if ($LASTEXITCODE) { throw "Native preview restore failed for $Architecture" }
  $configurationRoot = Join-Path (Split-Path $project) "bin/$platform/Release"
  if (Test-Path $configurationRoot) { Remove-Item $configurationRoot -Recurse -Force }
  $args=@($project,'-c','Release','-r',$rid,$platformArg,"-p:OpenFinalShellVersion=$Version",'--no-restore','--self-contained','true','-o',$output)
  if ($Publish) { dotnet publish @args } else { dotnet build @args }
  if ($LASTEXITCODE) { throw "Native preview build failed for $Architecture" }
  dotnet publish (Join-Path $PSScriptRoot 'OpenFinalShell.UpdateHost/OpenFinalShell.UpdateHost.csproj') -c Release -r $rid --self-contained true -o (Join-Path $output 'UpdateHost')
  if ($LASTEXITCODE) { throw "Native update helper build failed for $Architecture" }
} finally { Pop-Location }
if (!(Test-Path (Join-Path $output 'OpenFinalShell.App.exe'))) { throw "Native executable missing" }
Write-Output "Native preview $Architecture $Version ready: $output"
