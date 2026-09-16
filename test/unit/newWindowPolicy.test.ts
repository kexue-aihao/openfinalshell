import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'

const mocks = vi.hoisted(() => ({
  settings: { multiInstanceEnabled: false as unknown },
  app: { isPackaged: true, setJumpList: vi.fn(() => 'ok') }
}))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('../../src/main/services/settings', () => ({ getSettings: () => mocks.settings }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
function platform(value: string): void { Object.defineProperty(process, 'platform', { configurable: true, value }) }
beforeEach(() => {
  vi.resetModules()
  mocks.app.setJumpList.mockReset().mockReturnValue('ok')
  mocks.settings.multiInstanceEnabled = false
  mocks.app.isPackaged = true
  platform('win32')
})
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.unstubAllEnvs() })

describe('multi-instance preference', () => {
  it('is opt-in and the old environment override cannot bypass a disabled setting', async () => {
    expect(DEFAULT_SETTINGS.multiInstanceEnabled).toBe(false)
    vi.stubEnv('OFS_MULTI_INSTANCE_PREVIEW', '1')
    const policy = await import('../../src/main/instances/newWindowPolicy')
    for (const value of [false, undefined, 'true', 1]) {
      mocks.settings.multiInstanceEnabled = value
      expect(policy.multiInstanceAvailable()).toBe(false)
    }
    mocks.settings.multiInstanceEnabled = true
    expect(policy.multiInstanceAvailable()).toBe(true)
    mocks.settings.multiInstanceEnabled = false
    expect(policy.multiInstanceAvailable()).toBe(false)
  })

  it('keeps unsupported platforms disabled even with a stored enabled preference', async () => {
    const policy = await import('../../src/main/instances/newWindowPolicy')
    mocks.settings.multiInstanceEnabled = true
    for (const value of ['darwin', 'linux']) {
      platform(value)
      expect(policy.multiInstanceSupported()).toBe(false)
      expect(policy.multiInstanceAvailable()).toBe(false)
      policy.refreshNewWindowTask()
    }
    expect(mocks.app.setJumpList).not.toHaveBeenCalled()
  })

  it('adds and removes only the new-window task when the shared preference changes', async () => {
    const policy = await import('../../src/main/instances/newWindowPolicy')
    policy.refreshNewWindowTask()
    expect(mocks.app.setJumpList).toHaveBeenLastCalledWith([])
    mocks.settings.multiInstanceEnabled = true
    policy.refreshNewWindowTask()
    expect(mocks.app.setJumpList).toHaveBeenLastCalledWith([expect.objectContaining({
      type: 'tasks', items: [expect.objectContaining({ args: '--new-instance' })]
    })])
    policy.refreshNewWindowTask()
    expect(mocks.app.setJumpList).toHaveBeenCalledTimes(2)
    mocks.settings.multiInstanceEnabled = false
    policy.refreshNewWindowTask()
    expect(mocks.app.setJumpList).toHaveBeenLastCalledWith([])
  })

  it('retries failed taskbar registration without failing the preference save', async () => {
    mocks.app.setJumpList.mockImplementationOnce(() => { throw new Error('taskbar unavailable') })
    const policy = await import('../../src/main/instances/newWindowPolicy')
    expect(() => policy.refreshNewWindowTask()).not.toThrow()
    policy.refreshNewWindowTask()
    expect(mocks.app.setJumpList).toHaveBeenCalledTimes(2)
  })
})
