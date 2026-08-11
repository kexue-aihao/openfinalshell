// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import type { RemoteFileView, SessionId } from '@shared/types'
import '@/i18n'
import { useEditorStore } from '@/stores/useEditorStore'
import { deferred, fakeOfs, type Deferred } from './fakeOfs'

/**
 * 独立编辑器窗口壳的**运行时**测试：排队请求的领取、跨会话标签、断连横幅、
 * 关窗的脏文件裁决。这些都是"事件与异步回包交错"的行为，grep 护栏读不出来。
 *
 * CodeMirror 本体 mock 掉（EditorView 在 jsdom 里量不出布局），mock 只渲染正文 ——
 * 这里测的是**壳**：标签条、横幅、裁决链路。CodeMirror 自己的行为
 * （草稿去留、脏比较）在 editorSave.test.ts 的纯函数用例里。
 */

vi.mock('@/features/editor/CodeEditor', () => ({
  CodeEditor: (props: { text: string }) => <div data-testid="code-editor">{props.text}</div>
}))

// mock 必须先于被测组件的 import 生效（vi.mock 会被提升，这里的顺序只是给人看的）
import { EditorWindowShell } from '@/features/editor/EditorWindowShell'

function view(text: string, path: string): RemoteFileView {
  return {
    requestedPath: path,
    resolvedPath: path,
    text,
    charset: 'utf8',
    eol: 'lf',
    hasBom: false,
    mixedEol: false,
    lossless: true,
    bytes: text.length,
    mode: 0o644
  }
}

/** 每个 (sessionId, path) 一个 deferred —— fileView 的回包时机由测试握着 */
const reads = new Map<string, Deferred<RemoteFileView>>()
function readD(sessionId: string, path: string): Deferred<RemoteFileView> {
  const k = `${sessionId}::${path}`
  let d = reads.get(k)
  if (!d) {
    d = deferred<RemoteFileView>()
    reads.set(k, d)
  }
  return d
}

let queued: Array<{ sessionId: SessionId; path: string; origin: string }> = []

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function mount(): ReturnType<typeof render> {
  return render(
    <AntdApp>
      <EditorWindowShell />
    </AntdApp>
  )
}

const req = (sid: string, path: string, origin: string): { sessionId: SessionId; path: string; origin: string } => ({
  sessionId: sid as SessionId,
  path,
  origin
})

beforeEach(() => {
  fakeOfs.reset()
  reads.clear()
  queued = []
  useEditorStore.setState({ files: [], active: undefined })
  fakeOfs.handle('editor:ready', () => queued)
  fakeOfs.handle('editor:closeNow', () => undefined)
  fakeOfs.handle('sftp:fileView', (p) => {
    const { sessionId, path } = p as { sessionId: string; path: string }
    return readD(sessionId, path).promise
  })
})

afterEach(() => {
  cleanup()
})

describe('打开请求的送达', () => {
  it('窗口创建前排队的请求由 editor:ready 领取，标签带来源前缀', async () => {
    queued = [req('s1', '/etc/nginx.conf', 'web-1')]
    mount()
    await flush()
    await act(async () => readD('s1', '/etc/nginx.conf').resolve(view('server {}', '/etc/nginx.conf')))
    await flush()
    expect(screen.getByText('web-1')).toBeTruthy()
    expect(screen.getByText('nginx.conf')).toBeTruthy()
    expect(screen.getByTestId('code-editor').textContent).toBe('server {}')
  })

  it('两台机器的同名文件各占一个标签，靠 origin 区分；点标签切换激活', async () => {
    mount()
    await flush()
    act(() => fakeOfs.emit('editor:open', req('s1', '/etc/nginx.conf', 'web-1')))
    await act(async () => readD('s1', '/etc/nginx.conf').resolve(view('AAA', '/etc/nginx.conf')))
    act(() => fakeOfs.emit('editor:open', req('s2', '/etc/nginx.conf', 'db-2')))
    await act(async () => readD('s2', '/etc/nginx.conf').resolve(view('BBB', '/etc/nginx.conf')))
    await flush()

    // 两个标签都在，后打开的是激活项（正文是它的）
    expect(screen.getByText('web-1')).toBeTruthy()
    expect(screen.getByText('db-2')).toBeTruthy()
    expect(screen.getByTestId('code-editor').textContent).toBe('BBB')

    // 点回第一个标签
    act(() => {
      screen.getByText('web-1').closest('[role="tab"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })
    await flush()
    expect(screen.getByTestId('code-editor').textContent).toBe('AAA')
  })

  it('同一个文件再点一次只是切过去，不多开标签', async () => {
    mount()
    await flush()
    act(() => fakeOfs.emit('editor:open', req('s1', '/a.txt', 'web-1')))
    await act(async () => readD('s1', '/a.txt').resolve(view('a', '/a.txt')))
    act(() => fakeOfs.emit('editor:open', req('s1', '/b.txt', 'web-1')))
    await act(async () => readD('s1', '/b.txt').resolve(view('b', '/b.txt')))
    await flush()
    act(() => fakeOfs.emit('editor:open', req('s1', '/a.txt', 'web-1')))
    await flush()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByTestId('code-editor').textContent).toBe('a')
  })
})

describe('会话断开', () => {
  it('断开挂横幅、禁保存；会话恢复后横幅撤掉', async () => {
    const { container } = mount()
    await flush()
    act(() => fakeOfs.emit('editor:open', req('s1', '/etc/app.conf', 'web-1')))
    await act(async () => readD('s1', '/etc/app.conf').resolve(view('x', '/etc/app.conf')))
    await flush()

    const saveBtn = (): HTMLButtonElement =>
      container.querySelector('button[data-ofs-save]') as HTMLButtonElement
    expect(saveBtn().disabled).toBe(false)

    act(() => fakeOfs.emit('session:state', { sessionId: 's1' as SessionId, state: 'closed' }))
    await flush()
    expect(screen.getByText(/「web-1」的会话已断开/)).toBeTruthy()
    expect(saveBtn().disabled, '会话断开后保存按钮必须禁用').toBe(true)

    act(() => fakeOfs.emit('session:state', { sessionId: 's1' as SessionId, state: 'ready' }))
    await flush()
    expect(screen.queryByText(/的会话已断开/)).toBeNull()
    expect(saveBtn().disabled).toBe(false)
  })
})

describe('关窗裁决', () => {
  it('无脏文件：closeRequest 直接放行（invoke editor:closeNow，不弹框）', async () => {
    mount()
    await flush()
    act(() => fakeOfs.emit('editor:open', req('s1', '/a.txt', 'web-1')))
    await act(async () => readD('s1', '/a.txt').resolve(view('a', '/a.txt')))
    await flush()

    act(() => fakeOfs.emit('editor:closeRequest', null))
    await flush()
    expect(fakeOfs.invokes.filter((c) => c.channel === 'editor:closeNow')).toHaveLength(1)
    expect(screen.queryByText(/未保存/)).toBeNull()
  })

  it('有脏文件：先问，确认「丢掉改动」才放行', async () => {
    mount()
    await flush()
    act(() => fakeOfs.emit('editor:open', req('s1', '/a.txt', 'web-1')))
    await act(async () => readD('s1', '/a.txt').resolve(view('a', '/a.txt')))
    await flush()
    act(() => useEditorStore.getState().setDirty('s1::/a.txt', true))

    act(() => fakeOfs.emit('editor:closeRequest', null))
    await flush()
    // 弹了确认框、还没放行（antd 会把标题渲染在可见标题与无障碍描述两处，用 AllBy）
    expect((await screen.findAllByText(/1 个文件未保存/)).length).toBeGreaterThan(0)
    expect(fakeOfs.invokes.filter((c) => c.channel === 'editor:closeNow')).toHaveLength(0)

    // 确认丢弃 → 放行
    const ok = (await screen.findAllByText('丢掉改动'))
      .map((el) => el.closest('button'))
      .find(Boolean)!
    act(() => {
      ok.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(fakeOfs.invokes.filter((c) => c.channel === 'editor:closeNow')).toHaveLength(1)
  })
})

describe('超上限', () => {
  it('第 11 个文件打不开：在本窗口 toast 说明，不静默', async () => {
    mount()
    await flush()
    useEditorStore.setState({
      files: Array.from({ length: 10 }, (_, i) => ({
        key: `s1::/f${i}`,
        sessionId: 's1' as SessionId,
        path: `/f${i}`,
        origin: 'web-1',
        status: 'ready' as const,
        charset: 'utf8' as const,
        dirty: false,
        saving: false
      })),
      active: 's1::/f0'
    })
    act(() => fakeOfs.emit('editor:open', req('s1', '/one-more.txt', 'web-1')))
    await flush()
    expect(await screen.findByText(/同时打开的文件不能超过 10 个/)).toBeTruthy()
    expect(useEditorStore.getState().files).toHaveLength(10)
  })
})
