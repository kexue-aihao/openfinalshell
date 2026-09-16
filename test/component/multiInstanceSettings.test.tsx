// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import '@/i18n'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { SettingsModal } from '@/features/settings/SettingsModal'
import { TitleBar } from '@/features/layout/TitleBar'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { deferred, fakeOfs } from './fakeOfs'

let stored = structuredClone(DEFAULT_SETTINGS)
beforeEach(() => {
  fakeOfs.reset()
  stored = structuredClone(DEFAULT_SETTINGS)
  useSettingsStore.setState({ settings: stored })
  useUiStore.setState({ settingsOpen: true, settingsSection: 'general' })
  useSessionStore.setState({ tabs: [] })
  fakeOfs.handle('settings:get', () => stored)
  fakeOfs.handle('settings:set', (patch) => {
    stored = { ...stored, ...patch as Partial<typeof stored> }
    fakeOfs.emit('settings:changed', stored)
    return stored
  })
  fakeOfs.handle('app:instanceInfo', () => ({ multiInstanceSupported: true, canOpenNewWindow: stored.multiInstanceEnabled }))
})
afterEach(cleanup)

describe('multi-instance settings and menu', () => {
  it('saves both switch states and refreshes the new-window menu without restarting', async () => {
    render(<AntdApp><SettingsModal /><TitleBar /></AntdApp>)
    const toggle = await screen.findByRole('switch', { name: '允许多实例窗口' })
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('button', { name: 'OpenFinalShell' })).toBeNull()
    fireEvent.click(toggle)
    await screen.findByRole('button', { name: 'OpenFinalShell' })
    expect(stored.multiInstanceEnabled).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => expect(stored.multiInstanceEnabled).toBe(false))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'OpenFinalShell' })).toBeNull())
    expect(fakeOfs.invokes.filter((call) => call.channel === 'settings:set').map((call) => call.payload))
      .toEqual([{ multiInstanceEnabled: true }, { multiInstanceEnabled: false }])
  })

  it('disables the switch on unsupported platforms', async () => {
    fakeOfs.handle('app:instanceInfo', () => ({ multiInstanceSupported: false, canOpenNewWindow: false }))
    render(<AntdApp><SettingsModal /></AntdApp>)
    await screen.findByText('当前平台暂不支持')
    const toggle = screen.getByRole('switch', { name: '允许多实例窗口' })
    expect(toggle.hasAttribute('disabled')).toBe(true)
    fireEvent.click(toggle)
    expect(fakeOfs.invokes.some((call) => call.channel === 'settings:set')).toBe(false)
  })

  it('discards an older enabled capability response after another window disables the setting', async () => {
    const old = deferred<{ canOpenNewWindow: boolean }>()
    fakeOfs.handle('app:instanceInfo', () => old.promise)
    render(<AntdApp><TitleBar /></AntdApp>)
    await act(async () => {})
    fakeOfs.handle('app:instanceInfo', () => ({ canOpenNewWindow: false }))
    await act(async () => { fakeOfs.emit('settings:changed', stored) })
    await act(async () => { old.resolve({ canOpenNewWindow: true }) })
    expect(screen.queryByRole('button', { name: 'OpenFinalShell' })).toBeNull()
  })

  it('restores the stored switch state after a failed save', async () => {
    fakeOfs.handle('settings:set', () => Promise.reject(new Error('DATABASE_BUSY')))
    render(<AntdApp><SettingsModal /><TitleBar /></AntdApp>)
    const toggle = await screen.findByRole('switch', { name: '允许多实例窗口' })
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    expect(stored.multiInstanceEnabled).toBe(false)
  })
})
