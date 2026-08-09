import { describe, expect, it } from 'vitest'
import { blockAfter, read, stripComments } from '../sourceGuard'

/**
 * 终端 cd → SFTP 跟随的接线护栏。
 * 每一条护的都是"编译得过、跑起来不抛，只是静默走偏"的改法。
 */

const pane = stripComments(read('src/renderer/src/features/terminal/TerminalPane.tsx'))
const sftp = stripComments(read('src/renderer/src/features/sftp/SftpPane.tsx'))

describe('cd 跟随：TerminalPane 侧', () => {
  /**
   * Enter 采集块里，emitShellCommand 必须在 saveCommandHistory 的 if 之外。
   * 塞进去的话，关掉「记录命令历史」的用户会连目录跟随一起失去 ——
   * 这正是接线时被点名要避开的坑（captureCommand 曾整段包在那个开关里）。
   */
  it('emitShellCommand 不许被 saveCommandHistory 开关包住', () => {
    const gate = blockAfter(pane, 'if (useSettingsStore.getState().settings?.terminal.saveCommandHistory)')
    expect(gate).not.toContain('emitShellCommand')
    expect(gate).toContain('useHistoryStore')
  })

  it('采集只做一次，两个消费方共用同一份 command', () => {
    // captureCommand 在 TerminalPane 里只许出现一个调用点（import 行不算调用）
    expect(pane.match(/captureCommand\(/g)).toHaveLength(1)
    expect(pane).toContain('emitShellCommand(tab.id, command)')
  })
})

describe('cd 跟随：SftpPane 侧', () => {
  it('跟随受 followTerminalCd 开关管，且解析用 pathSync 的两个纯函数', () => {
    const idx = sftp.indexOf('onShellCommand(')
    expect(idx).toBeGreaterThan(0)
    // 开关判断必须在订阅之前（effect 开头 early return）
    const guard = sftp.lastIndexOf('settings.sftp.followTerminalCd', idx)
    expect(guard).toBeGreaterThan(0)
    expect(sftp).toContain('parseCdTarget(')
    expect(sftp).toContain('applyCd(cwdRef.current, target, homeRef.current)')
  })

  it('跟随的加载必须走静默模式（第三参 true）——cd 打错不许弹错误框', () => {
    const handler = blockAfter(sftp, 'onShellCommand(tab.id,')
    expect(handler).toContain('load(next, true, true)')
  })

  it('load 的静默分支：silent 时不碰 error 状态', () => {
    const loadBody = blockAfter(sftp, 'const load = useCallback(')
    // setError 的每一次调用都必须带 silentErrors 守卫
    const calls = [...loadBody.matchAll(/setError\(/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const m of calls) {
      const before = loadBody.slice(Math.max(0, m.index - 40), m.index)
      expect(before, `setError 调用点缺 silentErrors 守卫：…${before}`).toContain('!silentErrors')
    }
  })

  it('home 在 realpath 成功时记录（~ 解析的唯一来源）', () => {
    expect(sftp).toContain('homeRef.current = home')
  })
})
