import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { bindMainWindow, bindEditorWindow, emit, emitEditor, handle, instanceForSender } from '../../src/main/ipc/registry'
import { currentInstance } from '../../src/main/instance'

let nextId = 100
function fakeWindow() {
  const events = new EventEmitter()
  const mainFrame = { url: pathToFileURL(resolve('src/main/renderer/index.html')).href }
  const webContents = { id: nextId++, mainFrame, send: vi.fn() }
  const win = Object.assign(events, { webContents, isDestroyed: () => false })
  return { win: win as unknown as BrowserWindow, event: { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent, events, webContents }
}
afterEach(() => { currentInstance.closing = false; vi.restoreAllMocks() })

describe('registered instance IPC boundaries', () => {
  it('accepts its registered main frame and rejects unknown windows and child frames', () => {
    const a = fakeWindow(), b = fakeWindow()
    bindMainWindow(a.win)
    expect(instanceForSender(a.event)).toBe(currentInstance)
    expect(() => instanceForSender(b.event)).toThrow()
    expect(() => instanceForSender({ ...a.event, senderFrame: b.event.senderFrame })).toThrow()
    a.events.emit('closed')
    expect(() => instanceForSender(a.event)).toThrow()
  })

  it('routes terminal events only to main and editor events only to editor, dropping events during exit', () => {
    const a = fakeWindow(), b = fakeWindow()
    bindMainWindow(a.win); bindEditorWindow(b.win)
    emit('term:data', { termId: 'a', data: new Uint8Array([1]) })
    expect(a.webContents.send).toHaveBeenCalledOnce()
    expect(b.webContents.send).not.toHaveBeenCalled()
    emitEditor('editor:closeRequest', null)
    expect(b.webContents.send).toHaveBeenCalledOnce()
    currentInstance.closing = true
    emit('term:data', { termId: 'a', data: new Uint8Array([2]) })
    expect(a.webContents.send).toHaveBeenCalledOnce()
    expect(() => instanceForSender(a.event)).toThrow()
    a.events.emit('closed'); b.events.emit('closed')
  })

  it('rejects unrelated file pages even when they reuse a registered webContents', async () => {
    let listener: (...args: any[]) => Promise<unknown> = async () => undefined
    vi.spyOn(ipcMain, 'handle').mockImplementation((_channel, fn) => { listener = fn as typeof listener })
    handle('app:instanceInfo', () => ({ instanceId: currentInstance.instanceId, pid: 1, multiInstanceSupported: true, canOpenNewWindow: true }))
    const a = fakeWindow(); bindMainWindow(a.win)
    await expect(listener(a.event)).resolves.toMatchObject({ instanceId: currentInstance.instanceId })
    Object.assign(a.event.senderFrame!, { url: 'file:///untrusted.html' })
    await expect(listener(a.event)).rejects.toThrow('not trusted')
    a.events.emit('closed')
  })
})
