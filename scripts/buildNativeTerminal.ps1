param([ValidateSet('x64','x86','ARM64')][string]$Architecture='x64',[switch]$SkipProbe,[string]$OutputDirectory='')
$ErrorActionPreference='Stop'
$root=Resolve-Path (Join-Path $PSScriptRoot '..')
$llvm=Join-Path $root '.local/native-deps/llvm/llvm-mingw-20261020-ucrt-x86_64'
$src=Join-Path $root '.local/native-deps/libvterm-0.3.3'
$out=if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $root "build/native-terminal/$Architecture" }
New-Item -ItemType Directory -Force $out | Out-Null
$target=@{x64='x86_64-w64-windows-gnu';x86='i686-w64-windows-gnu';ARM64='aarch64-w64-windows-gnu'}[$Architecture]
$clang=Join-Path $llvm 'bin/clang.exe'; $include=Join-Path $src 'include'; $internal=Join-Path $src 'src'
$files=Get-ChildItem (Join-Path $src 'src') -Filter '*.c' | ForEach-Object FullName
& $clang --target=$target -shared -O2 -DNDEBUG -I $include -I $internal (Join-Path $root 'native/terminal/ofs_terminal.c') $files -o (Join-Path $out 'ofs-terminal.dll')
if ($LASTEXITCODE) { throw "libvterm build failed" }
& $clang --target=$target -O2 -I (Join-Path $root 'native/terminal') -c (Join-Path $root 'native/terminal/terminal_probe.c') -o (Join-Path $out 'terminal_probe.o')
& $clang --target=$target (Join-Path $out 'terminal_probe.o') -L $out -lofs-terminal -o (Join-Path $out 'terminal_probe.exe')
if ($LASTEXITCODE) { throw "terminal probe build failed" }
if (-not $SkipProbe) {
  & (Join-Path $out 'terminal_probe.exe')
  if ($LASTEXITCODE) { throw "terminal probe failed" }
}
Get-FileHash (Join-Path $out 'ofs-terminal.dll') -Algorithm SHA256
