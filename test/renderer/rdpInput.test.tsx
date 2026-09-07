// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import React from 'react'
import '@/i18n'
import { RdpPane } from '@/features/sessions/RdpPane'
import type { SessionTab } from '@/stores/useSessionStore'

const { invoke, send, clipboardFilePaths, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
  clipboardFilePaths: vi.fn(() => [] as string[]),
  listeners: new Map<string, Set<(payload: unknown) => void>>()
}))

vi.mock('@/ipc/api', () => ({
  ofs: {
    invoke: (...args: unknown[]) => invoke(...args),
    send,
    on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set<(payload: unknown) => void>()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    }),
    connectRdpPort: vi.fn(() => () => {}),
    getClipboardFilePaths: () => clipboardFilePaths(),
    getPathForFile: () => ''
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
  send.mockClear()
  clipboardFilePaths.mockReset()
  clipboardFilePaths.mockReturnValue([])
  listeners.clear()
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

    expect(send).toHaveBeenNthCalledWith(1, 'rdp:input', {
      sessionId: 'rdp-1',
      input: { kind: 'key', scanCode: 0x1e, pressed: true, unicode: 97 }
    })
    expect(send).toHaveBeenNthCalledWith(2, 'rdp:input', {
      sessionId: 'rdp-1',
      input: { kind: 'key', scanCode: 0x1e, pressed: false }
    })
  })

  it('does not send input from inactive mounted tabs', () => {
    const canvas = renderPane({}, false)

    fireEvent.keyDown(canvas, { code: 'KeyA', key: 'a' })
    fireEvent.paste(canvas, { clipboardData: { getData: () => 'secret' } })

    expect(invoke).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('bridges text paste and copy requests through the typed RDP clipboard IPC', () => {
    const canvas = renderPane()

    fireEvent.paste(canvas, { clipboardData: { getData: () => 'hello' } })
    fireEvent.copy(canvas)

    expect(invoke).toHaveBeenCalledWith('rdp:clipboardSet', { sessionId: 'rdp-1', text: 'hello' })
    expect(invoke).toHaveBeenCalledWith('rdp:clipboardGet', 'rdp-1')
  })

  it('maps pointer coordinates inside contain letterboxing to the remote canvas', () => {
    const canvas = renderPane()
    canvas.width = 1920
    canvas.height = 1080
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700,
      width: 1000, height: 700, toJSON: () => ({})
    })

    fireEvent.pointerDown(canvas, { clientX: 500, clientY: 350, button: 0, pointerId: 1 })
    expect(send).toHaveBeenCalledWith('rdp:input', {
      sessionId: 'rdp-1',
      input: { kind: 'pointer', x: 960, y: 540, buttons: 1 }
    })
  })

  it('preserves pressed buttons while scrolling and releases them on pointer up', () => {
    const canvas = renderPane()
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 150,
      width: 300, height: 150, toJSON: () => ({})
    })

    fireEvent.pointerDown(canvas, { clientX: 80, clientY: 40, button: 0, pointerId: 2 })
    fireEvent.wheel(canvas, { clientX: 80, clientY: 40, deltaY: 3, deltaMode: 1 })
    fireEvent.pointerUp(canvas, { clientX: 80, clientY: 40, button: 0, pointerId: 2 })

    expect(send).toHaveBeenCalledWith('rdp:input', expect.objectContaining({
      sessionId: 'rdp-1',
      input: expect.objectContaining({ kind: 'pointer', buttons: 1, wheelY: 120 })
    }))
    expect(send).toHaveBeenLastCalledWith('rdp:input', {
      sessionId: 'rdp-1',
      input: { kind: 'pointer', x: 80, y: 40, buttons: 0 }
    })
  })

  it('uses physical scan codes for modifier shortcuts instead of Unicode input', () => {
    const canvas = renderPane()

    fireEvent.keyDown(canvas, { code: 'ControlLeft', key: 'Control' })
    fireEvent.keyDown(canvas, { code: 'KeyA', key: 'a', ctrlKey: true })

    expect(send).toHaveBeenLastCalledWith('rdp:input', {
      sessionId: 'rdp-1',
      input: { kind: 'key', scanCode: 0x1e, pressed: true }
    })
  })

  it('executes Ctrl+C remotely before requesting the updated remote clipboard', async () => {
    const canvas = renderPane()

    fireEvent.keyDown(canvas, { code: 'ControlLeft', key: 'Control' })
    fireEvent.keyDown(canvas, { code: 'KeyC', key: 'c', ctrlKey: true })
    fireEvent.keyUp(canvas, { code: 'KeyC', key: 'c', ctrlKey: true })
    fireEvent.keyUp(canvas, { code: 'ControlLeft', key: 'Control' })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('rdp:clipboardGet', 'rdp-1'))
    const remoteInputs = [...send.mock.calls, ...invoke.mock.calls]
      .filter(([channel]) => channel === 'rdp:input')
      .map(([, value]) => value.input)
    expect(remoteInputs).toEqual(expect.arrayContaining([
      { kind: 'key', scanCode: 0x1d, pressed: true },
      { kind: 'key', scanCode: 0x2e, pressed: true },
      { kind: 'key', scanCode: 0x2e, pressed: false },
      { kind: 'key', scanCode: 0x1d, pressed: false }
    ]))
  })

  it('uploads local text before executing Ctrl+V remotely', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn(async () => 'local text') }
    })
    const canvas = renderPane()

    fireEvent.keyDown(canvas, { code: 'ControlLeft', key: 'Control' })
    fireEvent.keyDown(canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
    fireEvent.keyUp(canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
    fireEvent.keyUp(canvas, { code: 'ControlLeft', key: 'Control' })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('rdp:clipboardSet', {
      sessionId: 'rdp-1', text: 'local text'
    }))
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('rdp:input', {
      sessionId: 'rdp-1', input: { kind: 'key', scanCode: 0x2f, pressed: true }
    }))
    const setIndex = invoke.mock.calls.findIndex(([channel]) => channel === 'rdp:clipboardSet')
    const pasteIndex = send.mock.calls.findIndex(([channel, value]) =>
      channel === 'rdp:input' && value.input.scanCode === 0x2f && value.input.pressed === true
    )
    expect(setIndex).toBeGreaterThanOrEqual(0)
    expect(pasteIndex).toBeGreaterThanOrEqual(0)
    expect(send.mock.invocationCallOrder[pasteIndex]).toBeGreaterThan(invoke.mock.invocationCallOrder[setIndex])
  })

  it('announces copied local files before executing Ctrl+V remotely', async () => {
    clipboardFilePaths.mockReturnValue(['C:\\Users\\alice\\Desktop\\report.pdf'])
    const canvas = renderPane()

    fireEvent.keyDown(canvas, { code: 'ControlLeft', key: 'Control' })
    fireEvent.keyDown(canvas, { code: 'KeyV', key: 'v', ctrlKey: true })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('rdp:clipboardFilesSet', {
      sessionId: 'rdp-1', files: ['C:\\Users\\alice\\Desktop\\report.pdf']
    }))
    expect(invoke).not.toHaveBeenCalledWith('rdp:clipboardSet', expect.anything())
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('rdp:input', {
      sessionId: 'rdp-1', input: { kind: 'key', scanCode: 0x2f, pressed: true }
    }))
    const announceIndex = invoke.mock.calls.findIndex(([channel]) => channel === 'rdp:clipboardFilesSet')
    const pasteIndex = send.mock.calls.findIndex(([channel, value]) =>
      channel === 'rdp:input' && value.input.scanCode === 0x2f && value.input.pressed === true
    )
    expect(send.mock.invocationCallOrder[pasteIndex]).toBeGreaterThan(invoke.mock.invocationCallOrder[announceIndex])
  })

  it('shows file clipboard upload progress inside the RDP pane', async () => {
    renderPane()
    await act(async () => {
      for (const listener of listeners.get('rdp:clipboardProgress') ?? []) {
        listener({
          sessionId: 'rdp-1', state: 'transferring', fileIndex: 1, fileCount: 2,
          fileName: 'report.pdf', transferred: 1024, total: 2048, speedBps: 1024
        })
      }
    })

    expect(screen.getByRole('status').textContent).toContain('report.pdf')
    expect(screen.getByRole('status').textContent).toContain('1.00 KB / 2.00 KB')
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
