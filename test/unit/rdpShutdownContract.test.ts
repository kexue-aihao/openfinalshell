import { describe, expect, it } from 'vitest'
import { blockAfter, flat, read, stripComments } from '../sourceGuard'

describe('RDP shutdown ordering', () => {
  it('blocks ordinary quit until RDP workers close, then quits through a re-entry guard', () => {
    const body = flat(blockAfter(stripComments(read('src/main/index.ts')), "app.on('before-quit'"))
    const prevent = body.indexOf('event.preventDefault()')
    const awaitRdp = body.indexOf('await rdpSessionManager.closeAll()')
    const closeDb = body.indexOf('closeDatabase()')
    const finalQuit = body.lastIndexOf('app.quit()')

    expect(prevent).toBeGreaterThanOrEqual(0)
    expect(body).toContain('quitCleanupStarted')
    expect(body).toContain('quitCleanupComplete')
    expect(prevent).toBeLessThan(awaitRdp)
    expect(awaitRdp).toBeLessThan(closeDb)
    expect(closeDb).toBeLessThan(finalQuit)
  })

  it('waits for RDP workers before update install closes the database', () => {
    const body = flat(blockAfter(stripComments(read('src/main/services/updater.ts')), 'export function installUpdate'))
    const awaitRdp = body.indexOf('await rdpSessionManager.closeAll()')
    const closeDb = body.indexOf('closeDatabase()')
    const install = body.indexOf('quitAndInstall(')

    expect(awaitRdp).toBeGreaterThanOrEqual(0)
    expect(awaitRdp).toBeLessThan(closeDb)
    expect(closeDb).toBeLessThan(install)
  })

  it('includes live RDP workers in the update interruption count', () => {
    const body = flat(blockAfter(stripComments(read('src/main/services/updater.ts')), 'export function updateActivity'))

    expect(body).toContain('sshManager.liveCount() + rdpSessionManager.liveCount()')
  })

  it('keeps renderer RDP state mapping exclusively in the session store', () => {
    const pane = stripComments(read('src/renderer/src/features/sessions/RdpPane.tsx'))
    const store = stripComments(read('src/renderer/src/stores/useSessionStore.ts'))

    expect(pane).not.toContain("ofs.on('rdp:state'")
    expect(store).toContain("ofs.on('rdp:state'")
  })
})
