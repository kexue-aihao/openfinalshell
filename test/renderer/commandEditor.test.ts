import { beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'
import {
  buildSendText,
  historyEntryFor,
  resolveTargets,
  type TargetTab
} from '@/features/snippets/commandEditorSend'
import { useCommandEditorStore } from '@/stores/useCommandEditorStore'

/**
 * 命令编辑器的三条判断。它们错了都不会抛异常、界面照常工作，只是
 * **发到了别的会话** / **多执行了一次** / **往历史里塞了一整段脚本**。
 */

const tab = (id: string, termId: string | null, profileId = 'p1'): TargetTab => ({
  id,
  termId,
  profileId
})

describe('发送目标', () => {
  const tabs = [tab('t1', 'term-1'), tab('t2', null), tab('t3', 'term-3')]

  it('当前会话：只认活动那一条', () => {
    expect(resolveTargets(tabs, 't3', 'current').map((t) => t.id)).toEqual(['t3'])
  })

  it('当前会话还没开终端 → 一个都不发（而不是退而求其次发给别人）', () => {
    expect(resolveTargets(tabs, 't2', 'current')).toEqual([])
    expect(resolveTargets(tabs, null, 'current')).toEqual([])
    expect(resolveTargets(tabs, '不存在的', 'current')).toEqual([])
  })

  it('所有会话：跳过没开终端的，顺序与标签顺序一致', () => {
    expect(resolveTargets(tabs, 't1', 'all').map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('一个终端都没有时是空数组，调用方据此提示"请先连接"', () => {
    expect(resolveTargets([tab('t1', null)], 't1', 'all')).toEqual([])
  })
})

describe('发送的正文', () => {
  it('autoEnter 补一个换行（= 真的执行），关掉则不补', () => {
    expect(buildSendText('uptime', true)).toBe('uptime\n')
    expect(buildSendText('uptime', false)).toBe('uptime')
  })

  /**
   * CRLF 发给行编辑器等于**一行按两次回车**，中间那个空行会让 here-doc（`<<EOF`）当场错位。
   */
  it('CRLF 一律归一成 LF', () => {
    expect(buildSendText('a\r\nb\r\nc', true)).toBe('a\nb\nc\n')
    expect(buildSendText('a\rb', false)).toBe('a\nb')
  })

  it('末尾多敲的空行丢掉（否则就是一次多余的执行）', () => {
    expect(buildSendText('df -h\n\n\n', true)).toBe('df -h\n')
    expect(buildSendText('df -h\r\n\r\n', false)).toBe('df -h')
  })

  it('中间的空行留着 —— 脚本里的空行是有意义的', () => {
    expect(buildSendText('a\n\nb', true)).toBe('a\n\nb\n')
  })

  it('全是空白 → 空串，调用方据此拒绝发送', () => {
    expect(buildSendText('', true)).toBe('')
    expect(buildSendText('\n\n', true)).toBe('')
    // 只有空格的一行不算空：那可能是故意发一个空格给某个交互式程序
    expect(buildSendText('   ', true)).toBe('   \n')
  })
})

describe('每次打开都是空白（openBlank）', () => {
  beforeEach(() => {
    useCommandEditorStore.setState({ open: false, text: '', target: 'current', autoEnter: true, expandVars: true })
  })

  it('openBlank：清空上次的正文并打开', () => {
    useCommandEditorStore.setState({ text: '上次没发完的命令', open: false })
    useCommandEditorStore.getState().openBlank()
    expect(useCommandEditorStore.getState().text).toBe('')
    expect(useCommandEditorStore.getState().open).toBe(true)
  })

  it('openBlank 只清正文，不动 autoEnter/expandVars/target 这些偏好', () => {
    useCommandEditorStore.setState({ autoEnter: false, expandVars: false, target: 'all', text: 'x' })
    useCommandEditorStore.getState().openBlank()
    const s = useCommandEditorStore.getState()
    expect(s.text).toBe('')
    expect(s.autoEnter).toBe(false)
    expect(s.expandVars).toBe(false)
    expect(s.target).toBe('all')
  })
})

describe('要不要进历史', () => {
  it('没 autoEnter 就不记（还没执行，那一下由终端采集负责）', () => {
    expect(historyEntryFor('systemctl restart nginx', false)).toBeNull()
  })

  it('记的是整段（去掉末尾换行），不逐行拆', () => {
    expect(historyEntryFor('cd /tmp\nls -al\n', true)).toBe('cd /tmp\nls -al')
  })

  it('空白不记', () => {
    expect(historyEntryFor('  \n \n', true)).toBeNull()
  })

  /**
   * 与 main 侧那道 zod 上限**必须同一个数**：渲染进程是乐观更新（先本地加一条再发 IPC），
   * 判据不一致就会出现"列表里有、库里没有、重启后凭空消失"的记录。
   */
  it('超过 COMMAND_HISTORY_MAX_CHARS 不记', () => {
    expect(historyEntryFor('a'.repeat(COMMAND_HISTORY_MAX_CHARS), true)).toHaveLength(
      COMMAND_HISTORY_MAX_CHARS
    )
    expect(historyEntryFor('a'.repeat(COMMAND_HISTORY_MAX_CHARS + 1), true)).toBeNull()
  })
})
