import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EventMap, InvokeChannel } from '@shared/ipc'
import type { RemoteEditEntry } from '@shared/types'
import {
  applyEditEvent,
  createEditUiBook,
  onEditState,
  rememberEdits,
  savedIsNew
} from '@/features/sftp/editUiState'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'

/**
 * 远端编辑在界面侧那几处"错了不抛异常、只静默走偏"的判断。
 *
 * 渲染进程的测试跑在 node 环境（没有 jsdom），组件挂不起来 —— 所以这几条逻辑住在
 * src/renderer/src/features/sftp/editUiState.ts 这个纯模块里，这里对着它跑时序。
 * 剩下两条只能从源文本上守（SftpPane / SettingsModal 用的是哪条 channel），
 * 沿用 sftpEditWiring.test.ts 里同样的做法。
 */

const SESSION = 's1'
const ID = 'edit-1'

function ev(
  state: EventMap['sftp:editState']['state'],
  extra: Partial<EventMap['sftp:editState']> = {}
): EventMap['sftp:editState'] {
  return {
    editId: ID,
    sessionId: SESSION,
    remotePath: '/etc/app.conf',
    state,
    ...extra
  }
}

function row(over: Partial<RemoteEditEntry> = {}): RemoteEditEntry {
  return {
    id: ID,
    sessionId: SESSION,
    remotePath: '/etc/app.conf',
    resolvedPath: '/etc/app.conf',
    localPath: 'C:\\Temp\\ofs-edit-aaaaaa\\0123456789abcdef\\app.conf',
    state: 'editing',
    size: 1024,
    createdAt: 1_000,
    ...over
  }
}

describe('缺陷 1：「已写回远端」只在真的写过时才说', () => {
  /**
   * 这一条就是那个实证时序。旧写法在 conflict 分支直接 return、**没**把 editId 从
   * "在等写回结果"的集合里删掉，于是紧接着那条"内容没变"的短路 editing 被当成
   * "存盘成功"，弹出一条远端根本没发生的「已写回远端：app.conf」。
   */
  it('conflict 之后的短路 editing 不再被当成存盘成功', () => {
    const book = createEditUiBook()
    expect(onEditState(book, ev('uploading'))).toEqual({ kind: 'none' })
    expect(book.awaiting.has(ID)).toBe(true)

    expect(onEditState(book, ev('conflict', { error: '远端文件已被改动' }))).toEqual({
      kind: 'askOverwrite',
      blocked: false
    })
    // 远端此刻一个字节都没写 —— 不许再留在"等结果"里
    expect(book.awaiting.has(ID)).toBe(false)

    // 用户 Ctrl+Z 撤销后再存一次：main 走"内容没变"的短路分支，只发一条 editing
    expect(onEditState(book, ev('editing'))).toEqual({ kind: 'none' })
  })

  it('blocked / error 同样要从"等结果"里清掉', () => {
    for (const state of ['blocked', 'error'] as const) {
      const book = createEditUiBook()
      onEditState(book, ev('uploading'))
      onEditState(book, ev(state, { error: 'x' }))
      expect(book.awaiting.has(ID)).toBe(false)
      expect(onEditState(book, ev('editing'))).toEqual({ kind: 'none' })
    }
  })

  it('正常 uploading → editing 才去查 savedAt', () => {
    const book = createEditUiBook()
    onEditState(book, ev('uploading'))
    expect(onEditState(book, ev('editing'))).toEqual({ kind: 'verifySaved' })
    // 查完就消耗掉：同一趟不会问第二次
    expect(onEditState(book, ev('editing'))).toEqual({ kind: 'none' })
  })

  it('打开时的 downloading → editing 不算存盘', () => {
    const book = createEditUiBook()
    expect(onEditState(book, ev('downloading'))).toEqual({ kind: 'none' })
    expect(onEditState(book, ev('editing'))).toEqual({ kind: 'none' })
  })

  /**
   * 第二道闸：即便真的走到了 verifySaved，实据也得是 savedAt 变新。
   * 光凭"我在等一个结果"就报成功，正是缺陷 1 的形状。
   */
  it('savedAt 没变就不算写过；变了只报一次', () => {
    const book = createEditUiBook()
    rememberEdits(book, [row({ savedAt: 100 })])

    expect(savedIsNew(book, ID, 100)).toBe(false)
    expect(savedIsNew(book, ID, 200)).toBe(true)
    expect(savedIsNew(book, ID, 200)).toBe(false)
    // main 一次都没存成过时 savedAt 是 undefined —— 那更不能报
    expect(savedIsNew(book, 'edit-2', undefined)).toBe(false)
  })

  it('从没存过 → 第一次有了 savedAt，算写过', () => {
    const book = createEditUiBook()
    rememberEdits(book, [row({ savedAt: undefined })])
    expect(savedIsNew(book, ID, 555)).toBe(true)
  })

  it('全量对齐不许覆盖已经报过的 savedAt（否则实据被抹掉，会重复报）', () => {
    const book = createEditUiBook()
    rememberEdits(book, [row({ savedAt: 100 })])
    expect(savedIsNew(book, ID, 200)).toBe(true)
    // 列表里那份可能还是旧快照（editList 与事件之间没有顺序保证）
    rememberEdits(book, [row({ savedAt: 100 })])
    expect(savedIsNew(book, ID, 200)).toBe(false)
  })

  it('编辑结束后账本不留渣', () => {
    const book = createEditUiBook()
    onEditState(book, ev('uploading'))
    rememberEdits(book, [row({ savedAt: 100 })])
    expect(onEditState(book, ev('closed'))).toEqual({ kind: 'forget' })
    expect(book.awaiting.size).toBe(0)
    expect(book.reported.size).toBe(0)
  })

  it('全量对齐会把列表里已经没有的编辑清掉', () => {
    const book = createEditUiBook()
    onEditState(book, ev('uploading'))
    rememberEdits(book, [row()])
    rememberEdits(book, [])
    expect(book.awaiting.size).toBe(0)
    expect(book.reported.size).toBe(0)
  })
})

describe('缺陷 2：error 态的出口是「重试」，不是「仍然覆盖」', () => {
  it('error 走 askRetry；conflict / blocked 才走 askOverwrite', () => {
    const book = createEditUiBook()
    expect(onEditState(book, ev('error', { error: '会话未就绪' }))).toEqual({ kind: 'askRetry' })
    expect(onEditState(book, ev('conflict'))).toEqual({ kind: 'askOverwrite', blocked: false })
    expect(onEditState(book, ev('blocked'))).toEqual({ kind: 'askOverwrite', blocked: true })
  })

  it('契约里有一条独立的重试 channel（重试保留冲突检测，不是 editSave force）', () => {
    const retry: InvokeChannel = 'sftp:editRetry'
    expect(retry).toBe('sftp:editRetry')
  })

  /**
   * 界面确实把 error 接到了那条 channel 上。
   * 只有这一处能守住"别把 error 的出口做成仍然覆盖"—— 那会跳过冲突检测，
   * 一次网络抖动就把用户推上无条件覆盖别人改动的路。
   */
  it('SftpPane 的重试框调 sftp:editRetry，force:true 只出现在"仍然覆盖"那一处', () => {
    const src = readFileSync('src/renderer/src/features/sftp/SftpPane.tsx', 'utf8')
    expect(src).toContain("ofs.invoke('sftp:editRetry'")
    expect(src.match(/force: true/g) ?? []).toHaveLength(1)
  })
})

describe('缺陷 3：「正在编辑」列表的增量更新', () => {
  it('closed 把那一行摘掉', () => {
    const list = [row(), row({ id: 'edit-2' })]
    expect(applyEditEvent(list, ev('closed')).map((e) => e.id)).toEqual(['edit-2'])
  })

  it('事件只改 state / message / eolWarning，size 与 savedAt 留着等 editList', () => {
    const list = [row({ savedAt: 100 })]
    const [next] = applyEditEvent(list, ev('uploading', { warning: '快了' }))
    expect(next.state).toBe('uploading')
    expect(next.message).toBe('快了')
    // 事件里根本没有这两个字段（EventMap 刻意瘦身），不能凭空清成 0 / undefined
    expect(next.size).toBe(1024)
    expect(next.savedAt).toBe(100)
  })

  it('halted 状态的原因进 message（EventMap 那边拆成了 error / warning）', () => {
    const [next] = applyEditEvent([row()], ev('error', { error: '会话未就绪' }))
    expect(next.message).toBe('会话未就绪')
  })

  /**
   * 列表得真的接到界面上，否则 RemoteEditEntry 的 localPath/size/savedAt 在渲染进程
   * 依旧是零消费者，"20 槽耗尽后无路可走"原地复发。
   * 气泡那一条是 v0.1.3 修过的坑：工具条贴在窗口上沿时 placement=top 的气泡会钻到
   * Windows 原生的最小化/最大化/关闭按钮底下（那块矩形对 CSS 布局不可见）。
   */
  it('工具栏有入口、行上有两个动作、气泡用 TitlebarSafeTooltip', () => {
    const src = readFileSync('src/renderer/src/features/sftp/SftpPane.tsx', 'utf8')
    expect(src).toMatch(/edits\.length > 0/)
    // 断言的是"套在那颗按钮上"，不是"import 里出现过" —— 后者裸 Tooltip 也能过
    const beforeTip = src.slice(0, src.indexOf("t('sftp.editingCount'"))
    expect(beforeTip.slice(-40)).toContain('<TitlebarSafeTooltip')
    // "在文件夹中显示"复用现成的 app:openPath（localPath 是只出不进的展示值）
    expect(src).toMatch(/invoke\('app:openPath', entry\.localPath\)/)
    expect(src).toContain("ofs.invoke('sftp:editStop'")
  })

  it('没见过的 editId 不凭事件造行 —— 造出来的行没有 localPath', () => {
    const list = [row()]
    const same = applyEditEvent(list, ev('editing', { editId: 'ghost' }))
    // 同引用返回，顺带省掉一次白刷
    expect(same).toBe(list)
    expect(applyEditEvent([], ev('closed', { editId: 'ghost' }))).toEqual([])
  })
})

describe('缺陷 4：编辑器路径不再是自由文本输入', () => {
  const src = readFileSync('src/renderer/src/features/settings/SettingsModal.tsx', 'utf8')

  it('只经系统对话框写入：没有任何一处把 externalEditorPath 塞进 settings:set', () => {
    // 走 patch()/setSftp 的值会被 main 的 MAIN_ONLY_SETTINGS_PATHS 剥掉 —— 填了不生效
    expect(src).not.toMatch(/externalEditorPath:/)
    expect(src).toContain("ofs.invoke('sftp:pickEditor')")
    expect(src).toContain("ofs.invoke('sftp:clearEditor')")
    // 旧写法是拿通用的选路径 channel 自己塞设置，那条路现在不该再出现在这一片
    expect(src).not.toContain('pickExternalEditor: ')
  })

  it('两个语言都有只读展示与清除要用的文案，且不再留自由输入的占位提示', () => {
    for (const locale of [zh.translation.settings, en.translation.settings]) {
      const keys = locale as Record<string, string>
      expect(typeof keys.externalEditorNone).toBe('string')
      expect(typeof keys.externalEditorClear).toBe('string')
      expect(typeof keys.externalEditorPicked).toBe('string')
      expect(keys.externalEditorPathPlaceholder).toBeUndefined()
      expect(keys.pickExternalEditor).toBeUndefined()
    }
  })

  it('hint 要说清"只接受 exe / 必须从这里选"，否则用户还会去手填', () => {
    expect(zh.translation.settings.externalEditorPathHint).toMatch(/\.exe/)
    expect(zh.translation.settings.externalEditorPathHint).toMatch(/不会生效|必须从这里选择/)
    expect(en.translation.settings.externalEditorPathHint).toMatch(/\.exe/)
    expect(en.translation.settings.externalEditorPathHint).toMatch(/chosen here|not take effect/)
  })
})
