// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import { NativePreviewPanel } from '@/features/settings/NativePreviewPanel'
import { fakeOfs } from './fakeOfs'
import i18n from '@/i18n'
import type { InvokeMap } from '@shared/ipc'

type UpgradeInfo = InvokeMap['nativePreview:getInfo']['result']

const upgradeInfo: UpgradeInfo = {
  architecture: 'x64' as const,
  availableVersion: '0.30.33',
  installed: false
}

const storage = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => storage.clear()
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageMock })

beforeEach(async () => {
  storage.clear()
  await i18n.changeLanguage('en-US')
})

function renderPanel(info = upgradeInfo): void {
  localStorage.clear()
  fakeOfs.handle('nativePreview:getInfo', () => info)
  fakeOfs.handle('app:getVersions', () => ({ app: '0.30.33', electron: '43', node: '24', chrome: '140' }))
  fakeOfs.handle('nativePreview:download', () => ({ path: 'native.exe', version: '0.30.33', architecture: 'x64', bytes: 12, sha256: 'a'.repeat(64) }))
  fakeOfs.handle('nativePreview:launchInstaller', () => undefined)
  fakeOfs.handle('nativePreview:openInstalled', () => undefined)
  fakeOfs.handle('app:exportData', () => ({ path: 'migration.json', profiles: 1, secrets: 1, bytes: 10 }))
  render(<AntdApp><NativePreviewPanel /></AntdApp>)
}

afterEach(() => {
  cleanup()
  fakeOfs.reset()
  localStorage.clear()
})

it('shows the current Electron version, native version, architecture and install state', async () => {
  renderPanel()
  expect(await screen.findByText(/Current Electron 0\.30\.33/)).toBeTruthy()
  expect(screen.getByText(/Latest 0\.30\.33 · x64/)).toBeTruthy()
  expect(screen.getByText('Not installed')).toBeTruthy()
})

it('does not start a download when the migration confirmation is canceled', async () => {
  renderPanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Download native installer' }))
  expect(await screen.findByText(/Electron app stays installed/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(fakeOfs.invokes.some((call) => call.channel === 'nativePreview:download')).toBe(false))
})

it('requires matching passphrases before requesting an encrypted export', async () => {
  renderPanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Encrypt and export data' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Understood, continue' }))
  const fields = await screen.findAllByPlaceholderText(/Migration passphrase|Enter the migration passphrase/)
  fireEvent.change(fields[0], { target: { value: 'first-passphrase' } })
  fireEvent.change(fields[1], { target: { value: 'different-passphrase' } })
  const exportButtons = screen.getAllByRole('button', { name: 'Encrypt and export data' })
  fireEvent.click(exportButtons[exportButtons.length - 1])
  expect(await screen.findByText('The passphrases do not match.')).toBeTruthy()
  expect(fakeOfs.invokes.some((call) => call.channel === 'app:exportData')).toBe(false)
})

it('shows and launches the installed app after the verified installer starts', async () => {
  renderPanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Download native installer' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Understood, continue' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Start installer' }))
  const startButtons = await screen.findAllByRole('button', { name: 'Start installer' })
  fireEvent.click(startButtons[startButtons.length - 1])
  const openButton = await screen.findByRole('button', { name: 'Open native app' })
  fireEvent.click(openButton)
  await waitFor(() => expect(fakeOfs.invokes.some((call) => call.channel === 'nativePreview:openInstalled')).toBe(true))
})

it('keeps the open action available when an installed app exists but the update feed is offline', async () => {
  renderPanel({ architecture: 'x64', installed: true, installedVersion: '0.30.32', manifestError: 'offline' })
  expect(await screen.findByText(/Native release feed is unavailable/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open native app' }))
  await waitFor(() => expect(fakeOfs.invokes.some((call) => call.channel === 'nativePreview:openInstalled')).toBe(true))
})
