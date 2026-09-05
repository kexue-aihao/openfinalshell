import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporary: string[] = []

function makeStage() {
  const path = mkdtempSync(join(tmpdir(), 'ofs-rdp-package-gate-'))
  temporary.push(path)
  return path
}

function check(stageDir: string, ...args: string[]) {
  return spawnSync(process.execPath, [
    resolve('scripts/checkRdpWorkerPackage.mjs'),
    '--platform', 'win', '--arch', 'x64', '--stage-dir', stageDir,
    ...args
  ], { encoding: 'utf8' })
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('RDP worker release package gate', () => {
  it('rejects a runtime manifest with no redistributed dependency licenses', () => {
    const stage = makeStage()
    writeFileSync(join(stage, 'ofs-rdp-worker.exe'), 'worker')
    writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.rdp-worker.txt'), 'notice')
    writeFileSync(join(stage, 'rdp-worker-runtime.json'), JSON.stringify({
      schema: 1,
      platform: 'win',
      arch: 'x64',
      backend: 'freerdp',
      executable: 'ofs-rdp-worker.exe',
      runtimeFiles: [],
      noticeFile: 'THIRD-PARTY-NOTICES.rdp-worker.txt',
      licenseFiles: []
    }))
    const result = check(stage)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('at least one redistributed dependency license')
  })

  it('accepts an intentionally empty unsupported-platform stage and rejects any executable', () => {
    const stage = makeStage()
    writeFileSync(join(stage, 'RDP-WORKER-UNAVAILABLE.txt'), 'not shipped')
    expect(check(stage, '--expect-absent').status).toBe(0)
    mkdirSync(join(stage, 'nested'), { recursive: true })
    writeFileSync(join(stage, 'nested', 'ofs-rdp-worker.exe'), 'mock')
    const result = check(stage, '--expect-absent')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('must not stage an RDP worker')
  })

  it('checks the packaged resources directory is also worker-free', () => {
    const stage = makeStage()
    const app = makeStage()
    mkdirSync(join(app, 'resources', 'rdp-worker'), { recursive: true })
    writeFileSync(join(app, 'resources', 'rdp-worker', 'ofs-rdp-worker.exe'), 'mock')
    const result = check(stage, '--expect-absent', '--app-dir', app)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('packaged an RDP worker')
  })
})
