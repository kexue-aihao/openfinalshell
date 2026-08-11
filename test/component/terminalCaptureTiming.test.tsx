// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import type { Terminal } from '@xterm/xterm'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { SessionId } from '@shared/types'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { onShellCommand } from '@/features/terminal/commandEvents'
import { useHistoryStore } from '@/stores/useHistoryStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { fakeOfs } from './fakeOfs'

/**
 * 命令采集的**回显赛跑**测试 —— 0.15.4 那次线上事故的组件级复现。
 *
 * 事故的形态：终端里的字全是服务器回显回来的，而采集发生在回车 keydown 那一刻，
 * 用户最后几个字符（尤其是 Tab 让服务器补全的部分）还没回来 —— `cd /etc/v2node`
 * 被读成 `cd /etc/v2n`，SFTP 跟随去读一个不存在的目录。修法是 keydown 只快照，
 * 等**换行到达**（服务器按序回显：先补齐命令行、再回车）才读屏。
 *
 * 这里用真 TerminalPane + 真 xterm 解析器（不 open()，jsdom 里没有渲染器要的度量，
 * 但解析器、缓冲、onData/onLineFeed 全是活的）把"回显晚于回车"摆出来。
 * 在旧实现（keydown 读屏）上，第一条用例的期望值就是被截断的命令 —— 会红。
 */

// vi.mock 会被提升到最顶上，工厂里不能引用文件作用域变量 —— 共享状态走 vi.hoisted
const created = vi.hoisted(() => ({
  bundles: [] as Array<{ term: Terminal; keyHandlers: Array<(ev: KeyboardEvent) => boolean> }>
}))

vi.mock('@/features/terminal/createTerminal', async () => {
  const { Terminal } = await import('@xterm/xterm')
  return {
    createTerminal: (): unknown => {
      const term = new Terminal({ allowProposedApi: true })
      const keyHandlers: Array<(ev: KeyboardEvent) => boolean> = []
      const patched = term as unknown as Record<string, unknown>
      // 不真的 open / focus：那两步要 DOM 渲染器；其余能力照旧
      patched.open = (): void => {}
      patched.focus = (): void => {}
      const origAttach = term.attachCustomKeyEventHandler.bind(term)
      patched.attachCustomKeyEventHandler = (h: (ev: KeyboardEvent) => boolean): void => {
        keyHandlers.push(h)
        origAttach(h)
      }
      created.bundles.push({ term, keyHandlers })
      return {
        term,
        fit: { fit: (): void => {} },
        search: {},
        attachWebgl: (): void => {},
        detachWebgl: (): void => {},
        dispose: (): void => term.dispose()
      }
    }
  }
})

const tab: SessionTab = {
  id: 'tab1',
  profileId: 'p1',
  sessionId: 's1' as SessionId,
  termId: null,
  title: 'srv',
  state: 'ready',
  sftpOpen: false,
  monitorOpen: false,
  shellEpoch: 0
}

function enterKey(): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false
  } as unknown as KeyboardEvent
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

interface Rig {
  term: Terminal
  /** 服务器回显：写入并等 xterm 解析完 */
  echo: (data: string) => Promise<void>
  /** 用户敲键（不本地回显，与真实终端一致）：触发 onData → 提示符列跟踪 */
  type: (data: string) => void
  /** 按下回车（走 TerminalPane 挂的 custom key handler） */
  pressEnter: () => void
  /** 到目前为止 emitShellCommand 发出的命令 */
  captured: string[]
}

async function mountPane(): Promise<Rig> {
  render(
    <AntdApp>
      <TerminalPane tab={tab} active uiMode="dark" />
    </AntdApp>
  )
  await flush() // term:open 回包 → registerTerm → tracker 就位
  const bundle = created.bundles.at(-1)
  expect(bundle, 'createTerminal 没有被调用').toBeTruthy()
  const { term, keyHandlers } = bundle!
  expect(keyHandlers.length, 'TerminalPane 没挂 custom key handler').toBeGreaterThan(0)
  const captured: string[] = []
  onShellCommand(tab.id, (c) => captured.push(c))
  return {
    term,
    echo: (data) => act(() => new Promise<void>((r) => term.write(data, r))),
    type: (data) => act(() => term.input(data, true)),
    pressEnter: () =>
      act(() => {
        for (const h of keyHandlers) h(enterKey())
      }),
    captured
  }
}

beforeEach(() => {
  fakeOfs.reset()
  fakeOfs.handle('term:open', () => ({ termId: `term-${Math.random().toString(36).slice(2)}` }))
  fakeOfs.handle('term:close', () => undefined)
  fakeOfs.handle('history:push', () => undefined)
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
  useHistoryStore.setState({ entries: [], loaded: false })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('采集与回显的赛跑', () => {
  it('回车时回显还差两个字符：采到的仍是完整命令（keydown 读屏会采成 /etc/v2n）', async () => {
    const rig = await mountPane()
    await rig.echo('user@host:~# ') // 提示符
    rig.type('cd /etc/v2node') // 用户敲完整命令（屏幕上还什么都没有）
    await rig.echo('cd /etc/v2no') // 回显陆续到达……还差 'de'
    rig.pressEnter() // 用户已经按下回车
    await rig.echo('de') // 尾巴此刻才到 —— 事故里被丢掉的就是它
    await rig.echo('\r\n') // 命令行的换行到达 → 此刻才允许读屏
    expect(rig.captured).toEqual(['cd /etc/v2node'])
    // 同一份采集喂命令历史（开关默认开）
    expect(useHistoryStore.getState().entries.map((e) => e.command)).toEqual(['cd /etc/v2node'])
    expect(fakeOfs.invokes.some((c) => c.channel === 'history:push')).toBe(true)
  })

  it('换行迟迟不来（如 stty -echo 的口令提问）：超过窗口后到达的换行不采集', async () => {
    const rig = await mountPane()
    await rig.echo('user@host:~# ')
    rig.type('ssh other')
    await rig.echo('ssh other')
    rig.pressEnter()
    // 3 秒窗口过去了才见到第一个换行（比如对端先问了口令、echo 关着）
    const realNow = Date.now.bind(Date)
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 4000)
    try {
      await rig.echo('\r\n')
    } finally {
      nowSpy.mockRestore()
    }
    expect(rig.captured).toEqual([])
    expect(useHistoryStore.getState().entries).toEqual([])
  })

  it('关掉「记录命令历史」：历史不记，但 cd 跟随的命令照发', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.terminal.saveCommandHistory = false
    useSettingsStore.setState({ settings })

    const rig = await mountPane()
    await rig.echo('user@host:~# ')
    rig.type('cd /tmp')
    await rig.echo('cd /tmp')
    rig.pressEnter()
    await rig.echo('\r\n')
    expect(rig.captured).toEqual(['cd /tmp'])
    expect(useHistoryStore.getState().entries).toEqual([])
    expect(fakeOfs.invokes.some((c) => c.channel === 'history:push')).toBe(false)
  })
})
