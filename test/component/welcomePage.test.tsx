// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import type { ConnectionProfile } from '@shared/types'
import '@/i18n'
import { WelcomePage, parseQuickConnect } from '@/features/layout/WelcomePage'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUiStore } from '@/stores/useUiStore'

const profile = {
  id: 'profile-1',
  name: 'Production',
  groupId: null,
  host: '198.51.100.10',
  port: 2222,
  username: 'root',
  lastUsedAt: 1
} as ConnectionProfile

const connectionInitial = useConnectionStore.getState()
const sessionInitial = useSessionStore.getState()
const uiInitial = useUiStore.getState()

function renderWelcome(): void {
  render(
    <AntdApp>
      <WelcomePage />
    </AntdApp>
  )
}

beforeEach(() => {
  useConnectionStore.setState({ ...connectionInitial, profiles: [], groups: [], loaded: true, searchText: '' })
  useSessionStore.setState({ ...sessionInitial, tabs: [], activeTabId: null })
  useUiStore.setState({ ...uiInitial, editingProfileId: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('parseQuickConnect', () => {
  it('accepts supported SSH shorthand and rejects invalid ports', () => {
    expect(parseQuickConnect('ssh admin@example.com:2222')).toEqual({
      username: 'admin',
      host: 'example.com',
      port: 2222
    })
    expect(parseQuickConnect('example.com')).toEqual({ username: 'root', host: 'example.com', port: 22 })
    expect(parseQuickConnect('root@example.com:70000')).toBeNull()
  })
})

describe('WelcomePage', () => {
  it('disables the explicit quick-connect command until there is input', () => {
    renderWelcome()
    expect((screen.getByRole('button', { name: '快速连接' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves and opens a valid quick connection from the button', async () => {
    const save = vi.fn(async () => profile)
    const openForProfile = vi.fn(async () => undefined)
    useConnectionStore.setState({ save })
    useSessionStore.setState({ openForProfile })
    renderWelcome()

    fireEvent.change(screen.getByRole('textbox', { name: 'ssh user@host[:port]' }), {
      target: { value: 'admin@example.com:2222' }
    })
    fireEvent.click(screen.getByRole('button', { name: '快速连接' }))

    await act(async () => {})
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'example.com', port: 2222, username: 'admin' })
    )
    expect(openForProfile).toHaveBeenCalledWith(profile)
  })

  it('shows an inline error for malformed quick-connection input', () => {
    renderWelcome()
    const input = screen.getByRole('textbox', { name: 'ssh user@host[:port]' })
    fireEvent.change(input, { target: { value: 'root@example.com:70000' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByRole('alert').textContent).toContain('格式不正确')
  })

  it('opens a recent connection with a keyboard-accessible button', async () => {
    const launchProfile = vi.fn(async () => 'ssh' as const)
    useConnectionStore.setState({ profiles: [profile] })
    useSessionStore.setState({ launchProfile })
    renderWelcome()

    fireEvent.click(screen.getByRole('button', { name: 'Production (root@198.51.100.10)' }))
    await act(async () => {})
    expect(launchProfile).toHaveBeenCalledWith(profile)
  })
})
