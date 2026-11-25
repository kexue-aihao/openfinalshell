// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import type { ConnectionProfile } from '@shared/types'
import '@/i18n'
import i18n from '@/i18n'
import { QuickSwitcher } from '@/features/palette/QuickSwitcher'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUiStore } from '@/stores/useUiStore'
import { fakeOfs } from './fakeOfs'

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Production',
  groupId: null,
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  auth: { method: 'password' },
  terminal: { charset: 'utf-8', termType: 'xterm-256color' },
  options: {
    keepaliveInterval: 15000,
    readyTimeout: 15000,
    legacyAlgorithms: false,
    autoReconnect: false,
    monitorEnabled: false,
    compress: false
  },
  createdAt: 1,
  updatedAt: 1
}

const initialUi = useUiStore.getState()
const initialSessions = useSessionStore.getState()
const initialConnections = useConnectionStore.getState()

function Harness(): React.JSX.Element {
  useGlobalShortcuts()
  return <QuickSwitcher />
}

function renderSwitcher(open = true): void {
  render(
    <AntdApp>
      <Harness />
    </AntdApp>
  )
  if (open) act(() => useUiStore.setState({ quickSwitcherOpen: true }))
}

beforeEach(async () => {
  fakeOfs.reset()
  await i18n.changeLanguage('en-US')
  useUiStore.setState({ ...initialUi, quickSwitcherOpen: false })
  useConnectionStore.setState({ ...initialConnections, profiles: [profile], groups: [], loaded: true })
  useSessionStore.setState({
    ...initialSessions,
    activeTabId: 'a',
    tabs: [
      {
        id: 'a',
        profileId: 'p1',
        sessionId: null,
        termId: null,
        title: 'alpha',
        state: 'ready',
        sftpOpen: false,
        monitorOpen: false,
        shellEpoch: 0
      },
      {
        id: 'b',
        profileId: 'p1',
        sessionId: null,
        termId: null,
        title: 'beta',
        state: 'ready',
        sftpOpen: false,
        monitorOpen: false,
        shellEpoch: 0
      }
    ]
  })
})

afterEach(cleanup)

describe('quick switcher', () => {
  it('opens from Ctrl+K, lists sessions before connections, and activates a tab with Enter', () => {
    renderSwitcher(false)
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(useUiStore.getState().quickSwitcherOpen).toBe(true)

    const input = screen.getByPlaceholderText('Search sessions and connections')
    const options = screen.getAllByRole('option')
    expect(options.map((node) => node.textContent)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
      expect.stringContaining('Production')
    ])

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useSessionStore.getState().activeTabId).toBe('b')
    expect(useUiStore.getState().quickSwitcherOpen).toBe(false)
  })

  it('filters by host and launches the selected connection, closing on Escape', () => {
    const launch = vi.fn(async () => 'ssh' as const)
    useSessionStore.setState({ launchProfile: launch })
    renderSwitcher()

    const input = screen.getByPlaceholderText('Search sessions and connections')
    fireEvent.change(input, { target: { value: 'production' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('Production')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(launch).toHaveBeenCalledWith(profile)

    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(useUiStore.getState().quickSwitcherOpen).toBe(true)
    fireEvent.keyDown(screen.getByPlaceholderText('Search sessions and connections'), { key: 'Escape' })
    expect(useUiStore.getState().quickSwitcherOpen).toBe(false)
  })
})
