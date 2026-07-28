import { describe, expect, it } from 'vitest'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { blockAfter, flat, read, stripComments } from '../sourceGuard'

/**
 * 命令编辑器的接线护栏。四条各自守一个"改错了看不出来"的地方：
 *
 *  1. 判断只有一份（commandEditorSend），组件不另写一遍归一化/上限；
 *  2. 发送经 `term:exec`，并且**发送前标记那一行**（不标记的话，用户在发过去的内容
 *     后面补几个字符再回车，命令历史只会记下他补的那几个字符）；
 *  3. 多行 + 真执行时按设置弹一次确认 —— 与终端粘贴同一条规矩、同一份文案；
 *  4. 翻译串里不许出现 `{{host}}` 这类字面量：i18next 会把它当插值变量替换成空串，
 *     于是提示语当场少掉三个占位符名（这个坑已经踩过一次）。
 */

const MODAL = 'src/renderer/src/features/snippets/CommandEditorModal.tsx'
const SEND = 'src/renderer/src/features/snippets/commandEditorSend.ts'

describe('判断只有一份', () => {
  const modal = stripComments(read(MODAL))

  it('组件用 buildSendText / historyEntryFor / resolveTargets，不自己归一化行尾', () => {
    expect(modal).toContain('buildSendText(')
    expect(modal).toContain('historyEntryFor(')
    expect(modal).toContain('resolveTargets(')
    // 「保存为快捷命令」也走同一份归一化，而不是自己再 replace 一遍 ——
    // 三条路（发送 / 进历史 / 存快捷命令）各写一遍的话，存下来的与发出去的迟早不是同一段
    expect(modal).toContain('normalizeBody(text)')
    expect(modal).not.toContain("replace(/\\r\\n?/g, '\\n')")
  })

  it('归一化只有一份实现（全项目只此一处 CRLF 替换）', () => {
    const sendSrc = stripComments(read(SEND))
    expect(sendSrc.match(/replace\(\/\\r\\n\?\/g/g) ?? []).toHaveLength(1)
    expect(flat(blockAfter(sendSrc, 'export function buildSendText'))).toContain('normalizeBody(raw)')
    expect(flat(blockAfter(sendSrc, 'export function historyEntryFor'))).toContain('normalizeBody(raw)')
  })

  it('上限只在 commandEditorSend 里判（组件里不该再出现那个常量）', () => {
    expect(stripComments(read(SEND))).toContain('COMMAND_HISTORY_MAX_CHARS')
    expect(modal).not.toContain('COMMAND_HISTORY_MAX_CHARS')
  })
})

describe('发送这条路', () => {
  const send = flat(blockAfter(stripComments(read(MODAL)), 'const doSend ='))

  it('经 term:exec 发出去', () => {
    expect(send).toContain("ofs.invoke('term:exec'")
  })

  it('发送前标记那一行（命令历史的提示符列不再可信）', () => {
    expect(send).toContain('noteProgrammaticWrite(tab.termId!)')
  })

  it('多行 + 真执行时按设置弹确认，且复用终端粘贴那份文案', () => {
    expect(send).toContain('confirmMultilinePaste')
    expect(send).toContain("t('terminal.multilinePasteTitle')")
    expect(send).toContain('autoEnter && lines > 1')
  })

  it('目标为空时提示"请先连接"，而不是静默什么都不做', () => {
    expect(send).toContain("t('snippet.noActiveTerminal')")
  })
})

describe('文案', () => {
  const keys = [
    'title',
    'openHint',
    'placeholder',
    'empty',
    'send',
    'sendHint',
    'sendTo',
    'targetCurrent',
    'targetAll',
    'sent',
    'autoEnter',
    'autoEnterHint',
    'expandVars',
    'expandVarsHint',
    'saveAsSnippet',
    'saveAsSnippetName'
  ] as const

  it('两边都齐', () => {
    for (const key of keys) {
      expect(zh.translation.commandEditor[key], `zh 缺 commandEditor.${key}`).toBeTruthy()
      expect(en.translation.commandEditor[key], `en 缺 commandEditor.${key}`).toBeTruthy()
    }
  })

  /**
   * i18next 会把 `{{x}}` 当插值变量替换掉。占位符名字要展示给用户就只能在 JSX 里拼
   * （snippet.placeholderHint 就是这么做的）——
   * 写进翻译串的话，提示语里那三个占位符名会当场消失，而没人会因此报 bug。
   */
  it('commandEditor 的文案里没有 {{…}} 字面量（只有 sent 用真插值 count）', () => {
    for (const [key, value] of Object.entries(zh.translation.commandEditor)) {
      if (key === 'sent') continue
      expect(String(value), `zh commandEditor.${key} 里有插值花括号`).not.toMatch(/\{\{/)
    }
    for (const [key, value] of Object.entries(en.translation.commandEditor)) {
      if (key === 'sent') continue
      expect(String(value), `en commandEditor.${key} 里有插值花括号`).not.toMatch(/\{\{/)
    }
  })

  it('占位符名字由 JSX 拼出来', () => {
    const modal = read(MODAL)
    expect(modal).toContain("{'{{host}}'}")
    expect(modal).toContain("{'{{user}}'}")
    expect(modal).toContain("{'{{port}}'}")
  })
})

describe('挂载点', () => {
  /**
   * 挂在 App 而不是快捷命令面板里：侧栏切到别的视图时那个面板会卸载，
   * 而 destroyOnHidden=false 的弹窗跟着卸载 = 草稿没了。
   */
  it('由 App 挂载', () => {
    const app = stripComments(read('src/renderer/src/App.tsx'))
    expect(app).toContain('<CommandEditorModal />')
    expect(stripComments(read('src/renderer/src/features/snippets/SnippetPanel.tsx'))).not.toContain(
      '<CommandEditorModal'
    )
  })
})
