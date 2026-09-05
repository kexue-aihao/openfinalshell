import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const builder = readFileSync('electron-builder.yml', 'utf8')
const releaseWorkflow = readFileSync('.github/workflows/build-windows.yml', 'utf8')
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const packageJson = readFileSync('package.json', 'utf8')

describe('RDP worker packaging', () => {
  it('copies the staged worker outside asar into resources/rdp-worker', () => {
    expect(builder).toContain('extraResources:')
    expect(builder).toContain('from: build/rdp-worker')
    expect(builder).toContain('to: rdp-worker')
    expect(builder).toContain("- '**/*'")
  })

  it('ships a required FreeRDP worker only for Windows x64 before NATIVE-03', () => {
    expect(releaseWorkflow).toContain('vcpkg.exe" install freerdp:x64-windows')
    expect(releaseWorkflow).toContain('CMAKE_TOOLCHAIN_FILE=$vcpkgRoot\\scripts\\buildsystems\\vcpkg.cmake')
    expect(releaseWorkflow).toContain('npm run build:rdp-worker -- --platform win --arch x64 --require-freerdp')
    expect(releaseWorkflow).toContain('npm run check:rdp-worker -- --platform win --arch x64 --require-freerdp')
    expect(releaseWorkflow).toContain('npm run check:rdp-worker -- --platform win --arch x64 --app-dir $unpacked --require-freerdp')
    expect(releaseWorkflow).toContain('npm run smoke:rdp-worker -- build/rdp-worker/ofs-rdp-worker.exe')
    expect(releaseWorkflow).toContain('OFS_TEST_RDP_HOST: ${{ secrets.OFS_TEST_RDP_HOST }}')
    expect(releaseWorkflow).toContain('--platform win --arch ${{ matrix.arch }} --package-disabled')
    expect(releaseWorkflow).toContain('--platform win --arch ${{ matrix.arch }} --app-dir $unpacked --expect-absent')
    expect(releaseWorkflow).toContain('--platform mac --arch ${{ matrix.arch }} --package-disabled')
    expect(releaseWorkflow).toContain('--platform mac --arch ${{ matrix.arch }} --app-dir "$unpacked" --expect-absent')
    expect(releaseWorkflow).toContain('--platform linux --arch ${{ matrix.arch }} --package-disabled')
    expect(releaseWorkflow).toContain('--platform linux --arch ${{ matrix.arch }} --app-dir "$unpacked" --expect-absent')
    expect(releaseWorkflow).toContain('--platform linux --arch x64 --app-dir release/linux-unpacked --expect-absent')
    expect(releaseWorkflow).toContain('gcc-arm-linux-gnueabihf')
    expect(releaseWorkflow).toContain("'release/win-unpacked'")
    expect(releaseWorkflow).toContain('unpacked="release/mac-${{ matrix.arch }}/OpenFinalShell.app"')
    expect(releaseWorkflow).toContain('unpacked="release/mac/OpenFinalShell.app"')
    expect(releaseWorkflow).toContain('unpacked="release/linux-${{ matrix.arch }}-unpacked"')
    expect(releaseWorkflow).toContain('unpacked="release/linux-unpacked"')
    expect(ciWorkflow).toContain('--platform linux --arch ${{ matrix.arch }} --package-disabled')
    expect(ciWorkflow).toContain('unpacked="release/linux-${{ matrix.arch }}-unpacked"')
    expect(ciWorkflow).toContain('--app-dir "$unpacked" --expect-absent')
  })

  it('checks Windows x64 staging and packaged output with the required backend gate', () => {
    const scripts = JSON.parse(packageJson).scripts
    for (const name of ['package', 'package:dir']) {
      expect(scripts[name]).toContain('check:rdp-worker -- --platform win --arch x64 --require-freerdp')
      expect(scripts[name]).toContain('--app-dir release/win-unpacked --require-freerdp')
    }
  })
})
