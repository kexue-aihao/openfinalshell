// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, type RenderResult } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { SessionId, SftpEntry } from '@shared/types'
// SftpPane 自己不 import '@/i18n'（生产里由 App 入口初始化）——这里显式拉一次，
// 否则 useTranslation 拿到的是没有语言包的默认实例，断言的中文文案全变成键名
import '@/i18n'
import { SftpPane } from '@/features/sftp/SftpPane'
import { emitShellCommand } from '@/features/terminal/commandEvents'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { SessionTab } from '@/stores/useSessionStore'
import { deferred, fakeOfs, type Deferred } from './fakeOfs'

/**
 * cd 跟随的**运行时时序**测试。这一片的四个历史 bug（0.15.2/0.15.3 修的那些）全都有
 * 一个共同点：grep 护栏读源码读不出来 —— 它们只在"两个异步回包交错"或"失败之后再成功"
 * 这样的时间序列里出现。这里把每个序列在真组件上摆一遍。
 *
 * 断言取用户可见面：面包屑文本、骨架（aria-busy）、错误空态（重试链接）、toast 文案。
 * 不断言内部 state —— 内部怎么记是实现自由，用户看到什么才是契约。
 */

const tab: SessionTab = {
  id: 'tab1',
  profileId: 'p1',
  sessionId: 's1' as SessionId,
  termId: null,
  title: 'srv',
  state: 'ready',
  sftpOpen: true,
  monitorOpen: false,
  shellEpoch: 0
}

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

function mount(): RenderResult {
  return render(
    <AntdApp>
      <SftpPane tab={tab} active />
    </AntdApp>
  )
}

/** 图标按钮定位：这一排全是无文本的 icon button，靠 lucide 的类名找 */
function iconButton(container: HTMLElement, icon: string): HTMLButtonElement {
  const svg = container.querySelector(`svg.lucide-${icon}`)
  expect(svg, `找不到图标 lucide-${icon}`).toBeTruthy()
  const btn = svg!.closest('button')
  expect(btn, `图标 ${icon} 不在按钮里`).toBeTruthy()
  return btn as HTMLButtonElement
}

beforeEach(() => {
  fakeOfs.reset()
  dirs.clear()
  fakeOfs.handle('sftp:realpath', () => '/root')
  fakeOfs.handle('sftp:readdir', (p) => dirD((p as { path: string }).path).promise)
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
})

afterEach(() => {
  cleanup()
})

describe('cd 跟随：按下即翻页', () => {
  it('导航发起的同一帧：面包屑翻到目标、列表变骨架、三个写入口禁用；回包后全部复原', async () => {
    const { container } = mount()
    await flush()
    await act(async () => dirD('/root').resolve([entry('a.txt', '/root')]))
    await flush()
    // 初始就绪：面包屑在 /root，没有骨架
    expect(screen.getByText('root')).toBeTruthy()
    expect(container.querySelector('[aria-busy]')).toBeNull()

    // 终端里执行 cd /etc —— readdir 还没回，此刻界面就必须已经翻页
    act(() => emitShellCommand(tab.id, 'cd /etc'))
    expect(screen.getByText('etc'), '面包屑没有立刻翻到目标目录').toBeTruthy()
    expect(container.querySelector('[aria-busy]'), '列表位置没有换成骨架').toBeTruthy()
    // 未确认目录期间，往目录里写的入口必须关着（写进"还没去成"的目录）
    expect(iconButton(container, 'folder-plus').disabled).toBe(true)
    expect(iconButton(container, 'upload').disabled).toBe(true)
    expect(iconButton(container, 'folder-up').disabled).toBe(true)

    // 回包到达：骨架撤掉、写入口恢复、目录已确认
    await act(async () => dirD('/etc').resolve([entry('hosts', '/etc')]))
    await flush()
    expect(container.querySelector('[aria-busy]')).toBeNull()
    expect(iconButton(container, 'folder-plus').disabled).toBe(false)
    expect(screen.getByText('etc')).toBeTruthy()
  })
})

describe('cd 跟随：过期回包', () => {
  /** 两次跟随并发在飞、后发先至的公共开局：面板已落在 /b，/a 还在路上 */
  async function raceInto(): Promise<void> {
    mount()
    await flush()
    await act(async () => dirD('/root').resolve([entry('a.txt', '/root')]))
    await flush()
    // cwd 都还是 /root，所以两条都会发起（这正是并发的来源）
    act(() => emitShellCommand(tab.id, 'cd /a'))
    act(() => emitShellCommand(tab.id, 'cd /b'))
    await act(async () => dirD('/b').resolve([entry('bfile', '/b')]))
    await flush()
    expect(screen.getByText('b')).toBeTruthy()
  }

  it('cd /a 紧跟 cd /b：迟到的 /a **成功**回包不许把面板压回 /a', async () => {
    await raceInto()
    // 0.15.2 之前没有代号守卫：这一步会 setCwd('/a')，面包屑倒回、列表换成 /a 的内容，
    // 用户看到的是"跳错了目录、刷新一下才好"——最难描述清楚的那类 bug
    await act(async () => dirD('/a').resolve([entry('afile', '/a')]))
    await flush()
    expect(screen.queryByText('a'), '迟到的成功回包把面板压回了 /a').toBeNull()
    expect(screen.getByText('b')).toBeTruthy()
  })

  it('cd /a 紧跟 cd /b：迟到的 /a **失败**回包不许弹提示、不许立错误空态', async () => {
    await raceInto()
    // 它已经被更新的导航取代 —— 为一个用户早已离开的目标弹"无法跟随"只会造成困惑
    await act(async () => dirD('/a').reject(new Error('slow boom')))
    await flush()
    expect(screen.queryByText(/无法跟随到/)).toBeNull()
    expect(screen.queryByText('a')).toBeNull()
    expect(screen.getByText('b')).toBeTruthy()
    expect(screen.queryByText('重试')).toBeNull()
  })
})

describe('cd 跟随：失败语义', () => {
  it('跟随失败：toast 说明路径与原因，面板不被错误空态劫持，路径弹回原目录', async () => {
    const { container } = mount()
    await flush()
    await act(async () => dirD('/root').resolve([entry('a.txt', '/root')]))
    await flush()

    act(() => emitShellCommand(tab.id, 'cd /nope'))
    await act(async () => dirD('/nope').reject(new Error('No such file')))
    await flush()

    // 静默 ≠ 无声：会自己消失的提示要把"为什么没跟过去"说清楚
    expect(await screen.findByText('无法跟随到 /nope：No such file')).toBeTruthy()
    // 但面板不被劫持：没有错误空态，面包屑弹回已确认目录，骨架已撤
    expect(screen.queryByText('重试')).toBeNull()
    expect(screen.getByText('root')).toBeTruthy()
    expect(screen.queryByText('nope')).toBeNull()
    expect(container.querySelector('[aria-busy]')).toBeNull()
  })

  it('一次失败留下的错误空态，之后跟随（静默）成功必须无条件清掉', async () => {
    const { container } = mount()
    await flush()
    // 初始加载（非静默）失败 → 错误空态占住表格位置
    await act(async () => dirD('/root').reject(new Error('perm denied')))
    await flush()
    expect(screen.getByText('perm denied')).toBeTruthy()
    expect(screen.getByText('重试')).toBeTruthy()

    // cd 跟随（静默）成功 —— 0.15.2 的缺陷是这里不清错，表格被错误空态永久顶掉
    act(() => emitShellCommand(tab.id, 'cd /etc'))
    await act(async () => dirD('/etc').resolve([entry('hosts', '/etc')]))
    await flush()
    expect(screen.queryByText('perm denied'), '成功后错误空态没有被清掉').toBeNull()
    expect(screen.queryByText('重试')).toBeNull()
    expect(screen.getByText('etc')).toBeTruthy()
    expect(container.querySelector('[aria-busy]')).toBeNull()
  })
})
