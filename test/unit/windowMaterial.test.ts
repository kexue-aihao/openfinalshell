import { describe, expect, it } from 'vitest'
import {
  applyWindowBackgroundMaterial,
  resolveWindowBackgroundMaterial,
  resolveWindowControlsOverlayColor
} from '../../src/main/windowMaterial'

describe('resolveWindowBackgroundMaterial', () => {
  it('uses Mica on Windows 11 22H2 and later', () => {
    expect(
      resolveWindowBackgroundMaterial({
        platform: 'win32',
        systemVersion: '10.0.22621',
        reduceTransparency: false
      })
    ).toBe('mica')
    expect(
      resolveWindowBackgroundMaterial({
        platform: 'win32',
        systemVersion: '10.0.26100',
        reduceTransparency: false
      })
    ).toBe('mica')
  })

  it('falls back before Windows 11 22H2 and for malformed versions', () => {
    expect(
      resolveWindowBackgroundMaterial({
        platform: 'win32',
        systemVersion: '10.0.22000',
        reduceTransparency: false
      })
    ).toBe('none')
    expect(
      resolveWindowBackgroundMaterial({
        platform: 'win32',
        systemVersion: 'not-a-version',
        reduceTransparency: false
      })
    ).toBe('none')
  })

  it('never uses Mica outside Windows or when transparency is reduced', () => {
    expect(
      resolveWindowBackgroundMaterial({
        platform: 'darwin',
        systemVersion: '24.0.0',
        reduceTransparency: false
      })
    ).toBe('none')
    expect(
      resolveWindowBackgroundMaterial({
        platform: 'win32',
        systemVersion: '10.0.22621',
        reduceTransparency: true
      })
    ).toBe('none')
  })
})

describe('applyWindowBackgroundMaterial', () => {
  it('applies the resolved material when Electron supports it', () => {
    const calls: Array<'mica' | 'none'> = []
    const setBackgroundMaterial = (material: 'mica' | 'none'): void => {
      calls.push(material)
    }
    expect(applyWindowBackgroundMaterial({ setBackgroundMaterial }, 'mica')).toBe('mica')
    expect(calls).toEqual(['mica'])
  })

  it('falls back to none when Electron rejects Mica', () => {
    const calls: Array<'mica' | 'none'> = []
    const setBackgroundMaterial = (material: 'mica' | 'none'): void => {
      calls.push(material)
      if (material === 'mica') throw new Error('unsupported')
    }

    expect(applyWindowBackgroundMaterial({ setBackgroundMaterial }, 'mica')).toBe('none')
    expect(calls).toEqual(['mica', 'none'])
  })
})

describe('resolveWindowControlsOverlayColor', () => {
  it('keeps native controls transparent only while Mica is active', () => {
    expect(resolveWindowControlsOverlayColor('mica', '#1d2026')).toBe('transparent')
    expect(resolveWindowControlsOverlayColor('none', '#1d2026')).toBe('#1d2026')
  })
})
