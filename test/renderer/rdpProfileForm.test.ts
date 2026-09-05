// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import { createElement } from 'react'
import type { ConnectionProfile, ProfileDraft } from '../../src/shared/types'
import '@/i18n'
import { ProfileEditDrawer } from '@/features/connections/ProfileEditDrawer'

const mocks = vi.hoisted(() => {
  const savedRdp: ConnectionProfile = {
    id: 'rdp-1',
    name: 'RDP server',
    protocol: 'rdp',
    groupId: null,
    host: 'rdp.example.test',
    port: 3389,
    username: 'alice',
    rdp: {
      domain: 'OLD',
      passwordRef: 'rdp-secret',
      clipboard: false,
      certificatePolicy: 'strict'
    },
    auth: { method: 'password' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 20000,
      legacyAlgorithms: false,
      autoReconnect: true,
      monitorEnabled: true,
      compress: false
    },
    createdAt: 1,
    updatedAt: 1
  }
  const legacyRdp: ConnectionProfile = {
    ...savedRdp,
    id: 'legacy-rdp',
    name: 'Legacy RDP',
    rdp: undefined
  }
  const ui = {
    editingProfileId: 'rdp-1' as string | 'new' | null,
    setEditingProfile: vi.fn()
  }
  const connection = {
    profiles: [savedRdp] as ConnectionProfile[],
    groups: [],
    save: vi.fn(async (_draft: ProfileDraft) => savedRdp)
  }
  const savedRefs = {
    proxies: [],
    keys: [],
    loaded: true,
    load: vi.fn(async () => undefined)
  }
  const settings = { settings: null }
  return { savedRdp, legacyRdp, ui, connection, savedRefs, settings }
})

vi.mock('@/stores/useUiStore', () => ({
  useUiStore: (selector: (state: typeof mocks.ui) => unknown) => selector(mocks.ui)
}))

vi.mock('@/stores/useConnectionStore', () => ({
  useConnectionStore: (selector?: (state: typeof mocks.connection) => unknown) =>
    selector ? selector(mocks.connection) : mocks.connection
}))

vi.mock('@/stores/useSavedRefStore', () => ({
  useSavedRefStore: (selector: (state: typeof mocks.savedRefs) => unknown) => selector(mocks.savedRefs)
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: (selector: (state: typeof mocks.settings) => unknown) => selector(mocks.settings)
}))

vi.mock('@/features/settings/SavedRefModals', () => ({
  PrivateKeyEditModal: () => null,
  ProxyEditModal: () => null
}))

vi.mock('@/features/connections/RegionMarker', () => ({
  REGIONS: [],
  RegionMarker: () => null
}))

function renderDrawer(): void {
  render(createElement(AntdApp, null, createElement(ProfileEditDrawer)))
}

beforeEach(() => {
  mocks.ui.editingProfileId = 'rdp-1'
  mocks.connection.profiles = [mocks.savedRdp]
  mocks.connection.save.mockClear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RDP profile editor', () => {
  it('preserves existing settings and can explicitly clear the saved password', async () => {
    renderDrawer()

    expect(screen.getByDisplayValue('OLD')).toBeTruthy()
    const switches = screen.getAllByRole('switch')
    expect(switches[0].getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('拒绝不受信任的证书')).toBeTruthy()

    fireEvent.change(screen.getByDisplayValue('OLD'), { target: { value: 'NEW' } })
    fireEvent.click(switches[0])
    fireEvent.click(switches[1])
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))

    await waitFor(() => expect(mocks.connection.save).toHaveBeenCalledTimes(1))
    expect(mocks.connection.save).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: 'rdp',
        rdp: expect.objectContaining({
          domain: 'NEW',
          clipboard: true,
          certificatePolicy: 'strict',
          clearPassword: true,
          password: undefined
        })
      })
    )
  })

  it('uses frozen defaults for a legacy RDP profile without an rdp block', async () => {
    mocks.ui.editingProfileId = 'legacy-rdp'
    mocks.connection.profiles = [mocks.legacyRdp]
    renderDrawer()

    expect((screen.getByLabelText('域') as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('switch')[0].getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText('清除已保存密码')).toBeNull()
    expect(screen.getByText('接受前询问')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(mocks.connection.save).toHaveBeenCalledTimes(1))
    expect(mocks.connection.save).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: 'rdp',
        rdp: expect.objectContaining({
          domain: undefined,
          clipboard: true,
          certificatePolicy: 'prompt',
          clearPassword: undefined,
          password: undefined
        })
      })
    )
  })

  it('rejects a domain longer than the backend contract allows', async () => {
    renderDrawer()

    fireEvent.change(screen.getByDisplayValue('OLD'), { target: { value: 'x'.repeat(121) } })
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))

    expect(await screen.findByText('域不能超过 120 个字符')).toBeTruthy()
    expect(mocks.connection.save).not.toHaveBeenCalled()
  })

  it('cancels an untouched RDP edit without saving', () => {
    renderDrawer()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(mocks.connection.save).not.toHaveBeenCalled()
    expect(mocks.ui.setEditingProfile).toHaveBeenCalledWith(null)
  })
})
