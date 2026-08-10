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

  /**
   * error 语义分两半，两半的方向相反 —— 这条护栏原先只写了前一半，
   * 结果把后一半的缺陷（成功也不清错）一起钉死了。
   */
  it('load：报错只在非静默时占住面板，但成功一定无条件清错', () => {
    const loadBody = blockAfter(sftp, 'const load = useCallback(')
    /*
     * 前一半：静默分支里**绝不许**把错误写进面板 state（那会把表格换成错误空态）——
     * cd 跟随打错一个目录不该劫持面板。
     * 断言写成"对这段分支的要求"而不是钉某个字面量：上一版钉的是 `!silentErrors`
     * 这几个字，于是把 if/else 换个写法就红，反倒挡着正经改动。
     */
    const silentBranch = blockAfter(loadBody, 'if (silentErrors)')
    expect(silentBranch, '静默分支不许写面板的 error 状态').not.toContain('setError(')
    // 但静默 ≠ 无声：必须仍然把原因告诉用户，否则失败时界面只闪一下，
    // 用户描述不出、日志里也没痕迹（IPC 层不记 handler 异常），排查只能靠猜
    expect(silentBranch, '静默分支必须仍然告知失败原因').toContain('message.warning')
    // 非静默才把错误文案交给面板
    expect(loadBody).toContain('setError(reason)')
    // 后一半：成功路径上的 setError(null) 必须**无条件**。它曾经也被 !silentErrors 包着，
    // 于是一次失败留下错误空态之后，cd 跟随（静默）再成功也不清 —— 表格被错误空态
    // 永久顶掉，表现成"跟随彻底坏了"，只能手动点一次刷新才回来。
    const clearing = [...loadBody.matchAll(/setError\(null\)/g)]
    expect(clearing.length).toBeGreaterThan(0)
    const hasUnconditional = clearing.some(
      (m) => !loadBody.slice(Math.max(0, m.index - 60), m.index).includes('!silentErrors')
    )
    expect(hasUnconditional, '成功后清错必须无条件，否则错误空态会永久顶掉表格').toBe(true)
  })

  /**
   * 过期回包守卫。`cd /a` 紧接着 `cd /b` 时两个 readdir 并发在飞，回来的顺序没有保证；
   * 少了代号比对，/a 的后到回包会把面板压回 /a，而面包屑显示的是 /b。
   */
  it('load 领代号并在回包时比对，过期回包直接丢弃', () => {
    const loadBody = blockAfter(sftp, 'const load = useCallback(')
    expect(loadBody).toContain('++loadSeqRef.current')
    // 成功与失败两条路径都要比对，否则失败的过期回包仍会弹错误框
    const checks = [...loadBody.matchAll(/seq !== loadSeqRef\.current/g)]
    expect(checks.length).toBeGreaterThanOrEqual(2)
  })

  /** 乐观切路径不许动 entries —— 置空会唤醒整面板的 "等待会话" early return */
  it('乐观导航只设 pendingDir，绝不清空 entries', () => {
    const loadBody = blockAfter(sftp, 'const load = useCallback(')
    expect(loadBody).toContain('setPendingDir(dir)')
    expect(loadBody).not.toContain('setEntries([])')
  })

  it('home 在 realpath 成功时记录（~ 解析的唯一来源）', () => {
    expect(sftp).toContain('homeRef.current = home')
  })
})
