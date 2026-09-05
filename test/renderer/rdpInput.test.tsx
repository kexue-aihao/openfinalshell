// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import '@/i18n'
import { RdpPane } from '@/features/sessions/RdpPane'
import type { SessionTab } from '@/stores/useSessionStore'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined)
}))

vi.mock('@/ipc/api', () => ({
  ofs: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: vi.fn(),
    on: vi.fn(() => () => {}),
    connectRdpPort: vi.fn(() => () => {})
  }
}))

const tab: SessionTab = {
  id: 'tab-1',
  kind: 'rdp',
  profileId: 'profile-1',
  sessionId: 'rdp-1',
  termId: null,
  title: 'RDP',
  state: 'ready',
  sftpOpen: false,
  monitorOpen: false,
  shellEpoch: 0
}

function renderPane(overrides: Partial<SessionTab> = {}, active = true): HTMLCanvasElement {
  render(
    <AntdApp>
      <RdpPane tab={{ ...tab, ...overrides }} active={active} />
    </AntdApp>
  )
  return document.querySelector('canvas')!
}

beforeEach(() => {
  invoke.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind: string) => {
    if (kind === 'webgl2') return null
    if (kind === '2d') {
      return {
        createImageData: (width: number, height: number) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4)
        }),
        putImageData: vi.fn()
      } as unknown as CanvasRenderingContext2D
    }
    return null
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RdpPane input gating', () => {
  it('sends physical key input only for the active ready tab and releases held keys on blur', () => {
    const canvas = renderPane()

    fireEvent.keyDown(canvas, { code: 'KeyA', key: 'a' })
    fireEvent.blur(canvas)

    expect(invoke).toHaveBeenNthCalledWith(1, 'rdp:input', {
      sessionId: 'rdp-1',
      input: { kind: 'key', scanCode: 0x1e, pressed: true, unicode: 97 }
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'rdp:input', {
      sessionId: 'rdp-1',
      input: { kind: 'key', scanCode: 0x1e, pressed: false }
    })
  })

  it('does not send input from inactive mounted tabs', () => {
    const canvas = renderPane({}, false)

    fireEvent.keyDown(canvas, { code: 'KeyA', key: 'a' })
    fireEvent.paste(canvas, { clipboardData: { getData: () => 'secret' } })

    expect(invoke).not.toHaveBeenCalled()
  })

  it('bridges text paste and copy requests through the typed RDP clipboard IPC', () => {
    const canvas = renderPane()

    fireEvent.paste(canvas, { clipboardData: { getData: () => 'hello' } })
    fireEvent.copy(canvas)

    expect(invoke).toHaveBeenCalledWith('rdp:clipboardSet', { sessionId: 'rdp-1', text: 'hello' })
    expect(invoke).toHaveBeenCalledWith('rdp:clipboardGet', 'rdp-1')
  })

  it('shows an explicit system-client fallback label on failed RDP tabs', () => {
    render(
      <AntdApp>
        <RdpPane tab={{ ...tab, state: 'closed', error: 'Worker missing' }} active />
      </AntdApp>
    )

    expect(screen.getByRole('button', { name: /使用系统远程桌面/ })).toBeTruthy()
  })
})
