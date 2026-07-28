import { describe, expect, it } from 'vitest'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { blockAfter, channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * 命令历史这一片的护栏。挑的每一处都有同一个特征：**改错了不抛异常、编译照过、
 * 界面看着还在工作**，只是这个功能悄悄退化回"等于没做"，或者悄悄变得不安全。
 *
 *  1. 采集必须走 commandCapture 那一份（三道守卫都长在里面）。谁在面板里另写一段
 *     "取当前行、切掉提示符"，守卫就绕过去了。
 *  2. 回车永不被吞：采集在 try 里，且那条分支恒 return true。
 *  3. 列表里的命令**只回填、不执行**。一个单击就执行的历史列表，误点的代价是生产事故。
 *  4. 历史只有**一份**（main 侧那张表）。上一版那份纯内存的 history 已经删掉，
 *     再加一份就意味着面板与浮层显示的东西迟早不一样。
 *  5. 历史**不进导出文件**：命令行上偶尔真的带口令，而导出文件是拿来传给别人的。
 */

const CAPTURE = 'src/renderer/src/features/terminal/commandCapture.ts'
const PANE = 'src/renderer/src/features/terminal/TerminalPane.tsx'
const OVERLAY = 'src/renderer/src/features/terminal/HistoryOverlay.tsx'
const SNIPPET_PANEL = 'src/renderer/src/features/snippets/SnippetPanel.tsx'
const STORE = 'src/main/store/commandHistory.ts'
const HISTORY_IPC = 'src/main/ipc/history.ipc.ts'

describe('契约', () => {
  it('三条 channel 都在 InvokeMap 里', () => {
    const invoke = channelsOf('InvokeMap')
    expect(invoke).toContain('history:list')
    expect(invoke).toContain('history:push')
    expect(invoke).toContain('history:clear')
  })

  /**
   * push **不许**搬去 SendMap。那条路按设计不过 zod（registry.onSend 的注释写着
   * "高频热路径"），而这条 channel 的入参恰好是用户敲进生产服务器的原话 ——
   * 没有长度校验就等于渲染进程的一个 bug 能往库里写任意大的字符串。
   */
  it('push 走 invoke 而不是 SendMap（SendMap 那条路不过 zod）', () => {
    expect(channelsOf('SendMap')).not.toContain('history:push')
  })

  it("'history:' 在 preload 的前缀白名单里，否则三条全被拦在门外", () => {
    // 它是个数组字面量，不能用 blockAfter（那个找的是花括号，会一路找到后面的 interface）
    const src = stripComments(read('src/shared/ipc.ts'))
    const at = src.indexOf('export const CHANNEL_PREFIXES')
    const list = src.slice(at, src.indexOf('] as const', at))
    expect(list).toContain("'history:'")
  })

  it('push 的 zod 卡了非空与长度上限', () => {
    const ipc = flat(stripComments(read(HISTORY_IPC)))
    expect(ipc).toContain('COMMAND_HISTORY_MAX_CHARS')
    expect(ipc).toMatch(/z\.string\(\)\.min\(1\)\.max\(COMMAND_HISTORY_MAX_CHARS\)/)
  })
})

describe('存储语义', () => {
  const src = stripComments(read(STORE))

  it('表在 SCHEMA 里，命令原文就是主键（去重的根据）', () => {
    const schema = read('src/main/store/Database.ts')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS command_history')
    expect(flat(schema)).toContain('command TEXT PRIMARY KEY')
  })

  it('push 是 upsert 而不是每次插一行', () => {
    const push = flat(blockAfter(src, 'export function pushCommandHistory'))
    expect(push).toContain('ON CONFLICT(command) DO UPDATE')
    expect(push).toContain('use_count = use_count + 1')
  })

  it('淘汰与写入在同一个事务里（挪出去就等于崩溃时不淘汰）', () => {
    const push = flat(blockAfter(src, 'export function pushCommandHistory'))
    const tx = flat(blockAfter(blockAfter(src, 'export function pushCommandHistory'), 'tx('))
    expect(push).toContain('tx(')
    expect(tx).toContain('DELETE FROM command_history WHERE command NOT IN')
    expect(tx).toContain('COMMAND_HISTORY_MAX_ROWS')
  })

  it('入库前再过一遍规范化（IPC 那道 zod 不是唯一入口）', () => {
    expect(flat(blockAfter(src, 'export function pushCommandHistory'))).toContain(
      'normalizeCommand(command)'
    )
  })
})

describe('采集：三道守卫都在 commandCapture 里，面板不另写一份', () => {
  const capture = stripComments(read(CAPTURE))
  const pane = stripComments(read(PANE))

  it('全屏程序（alternate buffer）不采集', () => {
    expect(flat(blockAfter(capture, 'export function captureCommand'))).toContain(
      "buf.type === 'alternate'"
    )
  })

  it('提示符启发式不认 `> `（认了就把 echo a > b 切成 b）', () => {
    const pattern = capture.slice(capture.indexOf('const PROMPT_END'))
    expect(pattern.slice(0, 60)).toContain('[$#%] ')
    expect(pattern.slice(0, 60)).not.toContain('>')
  })

  it('终端面板经 captureCommand 采集，自己不切提示符', () => {
    expect(pane).toContain('captureCommand(')
    // 第二份切法的特征：面板里出现取行/切提示符的动作
    expect(pane).not.toContain('translateToString')
    expect(pane).not.toContain('PROMPT_END')
  })

  it('回车那条分支恒 return true，且采集包在 try 里 —— 永不吞掉一次回车', () => {
    const branch = flat(blockAfter(pane, "if (ev.key === 'Enter'"))
    expect(branch).toContain('try {')
    expect(branch).toContain('catch')
    expect(branch).toContain('return true')
  })

  it('受设置开关约束', () => {
    expect(flat(blockAfter(pane, "if (ev.key === 'Enter'"))).toContain(
      "useSettingsStore.getState().settings?.terminal.saveCommandHistory"
    )
    expect(DEFAULT_SETTINGS.terminal.saveCommandHistory).toBe(true)
  })

  it('输入（含输入法上屏）经 onData 记提示符列', () => {
    expect(flat(blockAfter(pane, 'bundle.term.onData('))).toContain('noteKeystroke(')
  })
})

describe('程序往终端里写字的三处都标记了那一行', () => {
  it('终端面板的粘贴/回填走同一个 writeToTerm，里面标记', () => {
    const pane = stripComments(read(PANE))
    expect(flat(blockAfter(pane, 'const writeToTerm ='))).toContain('noteProgrammaticWrite(termId)')
    // 粘贴不许绕过它自己发 term:input（doPaste 是个无花括号的箭头函数，按行取）
    const doPaste = pane.slice(pane.indexOf('const doPaste ='))
    expect(doPaste.slice(0, doPaste.indexOf('\n'))).toContain('writeToTerm(text)')
    // 面板里发 term:input 的地方只有 writeToTerm 与 onData 两处，粘贴/回填不许再开第三处
    expect(pane.match(/ofs\.send\('term:input'/g) ?? []).toHaveLength(2)
  })

  it('侧栏快捷命令发送前也标记', () => {
    expect(flat(stripComments(read(SNIPPET_PANEL)))).toContain('noteProgrammaticWrite(tab.termId!)')
  })
})

describe('列表里的命令只回填、不执行', () => {
  it('浮层：onPick 不追加换行', () => {
    const pick = blockAfter(stripComments(read(OVERLAY)), 'const onPick =')
    expect(pick).toContain('onInsert(command)')
    expect(pick).not.toContain('\\n')
  })

  it('侧栏历史项：单击回填，不追加换行', () => {
    const refill = blockAfter(stripComments(read(SNIPPET_PANEL)), 'const refill =')
    expect(refill).toContain("ofs.send('term:input'")
    expect(refill).not.toContain('\\n')
  })

  it('快捷命令那条路只在真的执行了（autoEnter）时记历史', () => {
    const send = flat(blockAfter(stripComments(read(SNIPPET_PANEL)), 'const send ='))
    expect(send).toContain('if (autoEnter) pushHistory(text)')
  })
})

describe('历史只有一份', () => {
  it('useSnippetStore 里那份纯内存历史已经删掉', () => {
    const src = stripComments(read('src/renderer/src/stores/useSnippetStore.ts'))
    expect(src).not.toContain('pushHistory')
    expect(src).not.toContain('HISTORY_LIMIT')
    expect(src).not.toMatch(/history\s*:/)
  })

  it('侧栏面板读的是 useHistoryStore', () => {
    expect(stripComments(read(SNIPPET_PANEL))).toContain('useHistoryStore')
  })

  it('侧栏历史那一块恒常渲染（上一版空的时候整块不存在，功能等于藏起来了）', () => {
    const src = flat(stripComments(read(SNIPPET_PANEL)))
    expect(src).not.toContain('history.length > 0 &&')
    expect(src).toContain('snippet.historyEmpty')
  })
})

describe('历史不进导出文件', () => {
  /**
   * 导出文件是拿来换机、发给同事的。命令行上偶尔真的带口令
   * （`mysql -pxxx`、`curl -u a:b`），把历史塞进去等于让那些口令跟着文件走。
   */
  it('exportData / importData 都不碰命令历史', () => {
    for (const path of ['src/main/services/exportData.ts', 'src/main/services/importData.ts']) {
      const src = stripComments(read(path))
      expect(src).not.toContain('command_history')
      expect(src).not.toContain('commandHistory')
    }
  })
})

describe('文案两边都有', () => {
  const keys = [
    'history',
    'historyTip',
    'historyHint',
    'historyFilter',
    'historyEmpty',
    'historyNoMatch',
    'historyClear',
    'historyClearConfirm'
  ] as const

  it('terminal.* 的浮层文案齐全', () => {
    for (const key of keys) {
      expect(zh.translation.terminal[key], `zh 缺 terminal.${key}`).toBeTruthy()
      expect(en.translation.terminal[key], `en 缺 terminal.${key}`).toBeTruthy()
    }
  })

  it('设置开关与快捷键说明齐全', () => {
    expect(zh.translation.settings.saveCommandHistory).toBeTruthy()
    expect(en.translation.settings.saveCommandHistory).toBeTruthy()
    expect(zh.translation.shortcut.history).toBeTruthy()
    expect(en.translation.shortcut.history).toBeTruthy()
  })

  it('文案里写明了"不会自动执行"—— 这是这个列表最重要的一句说明', () => {
    expect(zh.translation.terminal.historyHint).toContain('不会自动执行')
    expect(zh.translation.snippet.historyItemTip).toContain('不会自动执行')
  })
})
