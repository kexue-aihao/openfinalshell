// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import { Terminal } from '@xterm/xterm'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { ConnectionProfile, SessionId, SftpEntry, Snippet, TermId } from '@shared/types'
// 组件自己不 import '@/i18n'（生产里由 App 入口初始化）——这里显式拉一次，
// 否则 useTranslation 拿到的是没有语言包的默认实例，断言的中文文案全变成键名
import '@/i18n'
import { SftpPane } from '@/features/sftp/SftpPane'
import { SnippetPanel } from '@/features/snippets/SnippetPanel'
import { CommandEditorModal } from '@/features/snippets/CommandEditorModal'
import { registerTerm, unregisterTerm } from '@/features/terminal/termRegistry'
import { useCommandEditorStore } from '@/stores/useCommandEditorStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useHistoryStore } from '@/stores/useHistoryStore'
import { useSessionStore, type SessionTab } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSnippetStore } from '@/stores/useSnippetStore'
import { deferred, fakeOfs, type Deferred } from './fakeOfs'

/**
 * 程序化执行（快捷命令 / 命令编辑器）→ SFTP cd 跟随的**整链**测试。
 *
 * 这条链曾整条断掉而无人报警：跟随的唯一事件源挂在 TerminalPane 的 Enter 按键采集上
 * （keydown 快照 → 回显换行时读屏），而快捷命令走 term:exec 程序化写入 —— 没有 keydown，
 * 事件一条都不发。命令照常执行、历史照常记（发送侧自己 push），**只有跟随静默失效**，
 * 三层 grep 护栏全都读不出来。所以这里把用户的实际动作摆一遍：点快捷命令，看面包屑。
 */

const TERM_ID = 't1' as TermId

const tab: SessionTab = {
  id: 'tab1',
  profileId: 'p1',
  sessionId: 's1' as SessionId,
  termId: TERM_ID,
  title: 'srv',
  state: 'ready',
  sftpOpen: true,
  monitorOpen: false,
  shellEpoch: 0
}

// SnippetPanel 只读 host/username/port 做 {{}} 展开，其余字段这条链用不到
const profile = {
  id: 'p1',
  name: 'srv',
  groupId: null,
  host: '10.0.0.1',
  port: 22,
  username: 'root'
} as unknown as ConnectionProfile

function entry(name: string, dir: string): SftpEntry {
  return {
    name,
    path: dir === '/' ? `/${name}` : `${dir}/${name}`,
    type: 'file',
    size: 1,
    mode: 0o644,
    modeStr: '-rw-r--r--',
    owner: 'admin', // 别用 root：会与面包屑上的 'root' 撞文本
    group: 'admin',
    mtime: 1700000000
  }
}

/** 每个远端目录一个 deferred —— readdir 的回包时机由测试握着 */
const dirs = new Map<string, Deferred<SftpEntry[]>>()
function dirD(path: string): Deferred<SftpEntry[]> {
  let d = dirs.get(path)
  if (!d) {
    d = deferred<SftpEntry[]>()
    dirs.set(path, d)
  }
  return d
}

/** 把已排队的微任务（invoke 包装 + load 的 await 链）全放行 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function seedSnippet(command: string, autoEnter: boolean): void {
  useSnippetStore.setState({
    loaded: true,
    groups: [{ id: 'g1', name: '默认', order: 0 }],
    snippets: [
      {
        id: 'sn1' as Snippet['id'],
        groupId: 'g1',
        name: '跳目录',
        command,
        autoEnter,
        order: 0
      }
    ]
  })
}

/** 面板 + 快捷命令侧栏一起挂，等初始目录 /root 就绪 */
async function mountReady(ui: React.ReactNode): Promise<void> {
  render(<AntdApp>{ui}</AntdApp>)
  await flush()
  await act(async () => dirD('/root').resolve([entry('a.txt', '/root')]))
  await flush()
  expect(screen.getByText('root')).toBeTruthy()
}

beforeEach(() => {
  fakeOfs.reset()
  dirs.clear()
  fakeOfs.handle('sftp:realpath', () => '/root')
  fakeOfs.handle('sftp:readdir', (p) => dirD((p as { path: string }).path).promise)
  fakeOfs.handle('term:exec', () => undefined)
  fakeOfs.handle('history:push', () => undefined)
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
  useSessionStore.setState({ tabs: [tab], activeTabId: tab.id })
  useHistoryStore.setState({ entries: [], loaded: true })
  useConnectionStore.setState({ profiles: [profile] })
})

afterEach(() => {
  unregisterTerm(TERM_ID)
  cleanup()
})

describe('快捷命令 → SFTP cd 跟随', () => {
  it('点一条 autoEnter 的 cd 快捷命令：命令发出去，面包屑同帧翻页，回包后落定', async () => {
    seedSnippet('cd /etc', true)
    await mountReady(
      <>
        <SnippetPanel />
        <SftpPane tab={tab} active />
      </>
    )

    act(() => {
      fireEvent.click(screen.getByText('跳目录'))
    })
    // 命令本身照常执行（这半边一直是好的）
    expect(
      fakeOfs.invokes.some(
        (c) =>
          c.channel === 'term:exec' &&
          (c.payload as { command: string }).command === 'cd /etc\n'
      )
    ).toBe(true)
    // 跟随这半边曾整条断掉：没有 Enter keydown，事件一条不发，面包屑停在 root
    expect(screen.getByText('etc'), '面包屑没有跟随快捷命令翻页').toBeTruthy()

    await act(async () => dirD('/etc').resolve([entry('hosts', '/etc')]))
    await flush()
    expect(screen.getByText('etc')).toBeTruthy()
  })

  it('多行快捷命令：其中的 cd 行触发跟随，其余行不打扰', async () => {
    seedSnippet('cd /var\nls -la', true)
    await mountReady(
      <>
        <SnippetPanel />
        <SftpPane tab={tab} active />
      </>
    )

    act(() => {
      fireEvent.click(screen.getByText('跳目录'))
    })
    expect(screen.getByText('var'), '多行体里的 cd 行没有触发跟随').toBeTruthy()

    await act(async () => dirD('/var').resolve([entry('log', '/var')]))
    await flush()
    expect(screen.getByText('var')).toBeTruthy()
  })

  it('autoEnter 关着：命令只是躺在命令行上，不算执行，不许跟随', async () => {
    seedSnippet('cd /etc', false)
    await mountReady(
      <>
        <SnippetPanel />
        <SftpPane tab={tab} active />
      </>
    )

    act(() => {
      fireEvent.click(screen.getByText('跳目录'))
    })
    // 文本发过去了（不带回车）……
    expect(
      fakeOfs.invokes.some(
        (c) =>
          c.channel === 'term:exec' && (c.payload as { command: string }).command === 'cd /etc'
      )
    ).toBe(true)
    // ……但没执行就不许跳：等用户自己按回车，那一下归 Enter 采集管
    expect(screen.queryByText('etc')).toBeNull()
    expect(screen.getByText('root')).toBeTruthy()
  })

  it('终端被全屏程序占着（alternate buffer）：写进去的不是 shell 命令，不许跟随', async () => {
    // 真 xterm 不 open() 在 jsdom 里就能跑（解析器/缓冲都活着），写入切屏序列进入 alternate
    const term = new Terminal({ allowProposedApi: true })
    await new Promise<void>((resolve) => term.write('\x1b[?1049h', resolve))
    expect(term.buffer.active.type).toBe('alternate')
    registerTerm(TERM_ID, term)

    seedSnippet('cd /etc', true)
    await mountReady(
      <>
        <SnippetPanel />
        <SftpPane tab={tab} active />
      </>
    )

    act(() => {
      fireEvent.click(screen.getByText('跳目录'))
    })
    expect(screen.queryByText('etc'), 'vim 占屏时快捷命令不该触发跟随').toBeNull()
    expect(screen.getByText('root')).toBeTruthy()
    term.dispose()
  })
})

describe('命令编辑器 → SFTP cd 跟随', () => {
  it('「发送」一段带 cd 的正文：与快捷命令同一条宣告链路，面包屑跟随', async () => {
    useCommandEditorStore.setState({
      open: true,
      text: 'cd /etc',
      target: 'current',
      autoEnter: true,
      expandVars: true
    })
    await mountReady(
      <>
        <CommandEditorModal />
        <SftpPane tab={tab} active />
      </>
    )

    const sendBtn = screen
      .getAllByRole('button')
      .find((b) => /发\s*送/.test(b.textContent ?? ''))
    expect(sendBtn, '找不到命令编辑器的发送按钮').toBeTruthy()
    act(() => {
      fireEvent.click(sendBtn!)
    })

    expect(
      fakeOfs.invokes.some(
        (c) =>
          c.channel === 'term:exec' &&
          (c.payload as { command: string }).command === 'cd /etc\n'
      )
    ).toBe(true)
    expect(screen.getByText('etc'), '命令编辑器发送后面包屑没有跟随').toBeTruthy()

    await act(async () => dirD('/etc').resolve([entry('hosts', '/etc')]))
    await flush()
    expect(screen.getByText('etc')).toBeTruthy()
  })
})
