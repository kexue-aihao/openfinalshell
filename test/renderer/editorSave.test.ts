import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteFileSaveResult, RemoteFileView, RemoteSaveGates } from '@shared/types'
import { planDraftSwap } from '@/features/editor/draftSwap'
import { blockAfter, flat, read, stripComments } from '../sourceGuard'

/**
 * 内置编辑器保存那条路的**渲染进程**一侧。
 *
 * main 那侧（闸门、硬拒、基线）由 test/unit/fileSave.test.ts 覆盖，这里只管接线，
 * 而接线上最容易静默出错的是**参数**：charset / eol / hasBom 少传或传错一个，
 * 编译得过、跑得通、界面上一切正常，只是文件被静默改写（GBK 存成 UTF-8、
 * CRLF 整个翻面、.bat 的 BOM 没了）。所以这里的主力断言是"发出去的那一份长什么样"。
 */

const calls: Array<[string, unknown[]]> = []
let saveResult: RemoteFileSaveResult = { kind: 'saved', bytes: 10, mode: 0o644 }
let saveThrows: Error | null = null

const VIEW: RemoteFileView = {
  requestedPath: '/etc/app.conf',
  resolvedPath: '/etc/app.conf',
  text: 'old\n',
  charset: 'gbk',
  eol: 'crlf',
  hasBom: true,
  mixedEol: true,
  lossless: true,
  bytes: 4,
  mode: 0o600
}

vi.mock('@/ipc/api', () => ({
  ofs: {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      calls.push([channel, args])
      if (channel === 'sftp:fileView') return VIEW
      if (channel === 'sftp:fileSave') {
        if (saveThrows) throw saveThrows
        return saveResult
      }
      return undefined
    }),
    send: vi.fn(),
    on: () => () => {}
  }
}))

const { useEditorStore, NO_GATES } = await import('@/stores/useEditorStore')

const SID = 'sid-1'
const P = '/etc/app.conf'
const KEY = `${SID}::${P}`

/** 装一个已经读好的文件，不走 open（那条要过 fileView，另有用例） */
function seed(patch: Partial<ReturnType<typeof useEditorStore.getState>['files'][number]> = {}): void {
  useEditorStore.setState({
    files: [
      {
        key: KEY,
        sessionId: SID,
        path: P,
        origin: 'srv-1',
        status: 'ready',
        view: { ...VIEW },
        charset: 'gbk',
        dirty: false,
        saving: false,
        ...patch
      }
    ],
    active: KEY
  })
}

const lastSave = (): Record<string, unknown> =>
  (calls.filter((c) => c[0] === 'sftp:fileSave').at(-1)?.[1][0] ?? {}) as Record<string, unknown>

beforeEach(() => {
  calls.length = 0
  saveThrows = null
  saveResult = { kind: 'saved', bytes: 10, mode: 0o644 }
  useEditorStore.setState({ files: [], active: undefined })
})

describe('保存发出去的那一份参数', () => {
  /**
   * **这一条是本文件的主力。** 三个字段每一个漏掉都会静默改写文件，而且都不报错：
   * charset 少传 → GBK 的配置按 UTF-8 存回去（整个文件变乱码）；
   * eol 少传 → CRLF 文件整个翻面；hasBom 少传 → .bat / .ps1 的 BOM 没了。
   * fixture 刻意选了"GBK + CRLF + 带 BOM"这一组，三个都不是默认值。
   */
  it('charset / eol / hasBom 三个都按当前那份 view 原样发出去', async () => {
    seed()
    await useEditorStore.getState().save(KEY, NO_GATES, 'new\n')

    expect(lastSave()).toMatchObject({
      sessionId: SID,
      path: P,
      text: 'new\n',
      charset: 'gbk',
      eol: 'crlf',
      hasBom: true
    })
  })

  it('charset 用 store 里的（换过编码之后就是新的那个），不是 view 里那份', async () => {
    // 换编码 = 重读，两者本来一致；但如果哪天不一致了，权威是 store 那份
    seed({ charset: 'big5' })
    await useEditorStore.getState().save(KEY, NO_GATES, 'x\n')
    expect(lastSave().charset).toBe('big5')
  })

  it('gates 原样传下去，一个不加一个不减', async () => {
    seed()
    const gates: RemoteSaveGates = {
      overwriteRemoteChanges: true,
      allowNonAtomic: false,
      allowShrink: true
    }
    await useEditorStore.getState().save(KEY, gates, 'x\n')
    expect(lastSave().gates).toEqual(gates)
  })

  it('NO_GATES 三个都是 false（保存的起点不许有任何一个默认放行）', () => {
    expect(NO_GATES).toEqual({
      overwriteRemoteChanges: false,
      allowNonAtomic: false,
      allowShrink: false
    })
  })
})

describe('存成之后的状态', () => {
  it('view.text 换成刚写上去的那份，dirty 清掉', async () => {
    seed({ dirty: true })
    await useEditorStore.getState().save(KEY, NO_GATES, 'new content\n')

    const f = useEditorStore.getState().files[0]
    expect(f.view?.text).toBe('new content\n')
    expect(f.dirty).toBe(false)
    expect(f.saving).toBe(false)
  })

  /** 编码后的长度只有 main 知道（GBK 的中文是 2 字节、UTF-8 是 3），不许自己算 */
  it('bytes / mode 用 main 回来的实测值', async () => {
    seed()
    saveResult = { kind: 'saved', bytes: 4096, mode: 0o640 }
    await useEditorStore.getState().save(KEY, NO_GATES, 'x\n')

    const view = useEditorStore.getState().files[0].view
    expect(view?.bytes).toBe(4096)
    expect(view?.mode).toBe(0o640)
  })

  /**
   * 保存已经把行尾统一掉了，`mixedEol` 那条警告不再适用；远端那份字节就是刚从这个
   * 字符串编出来的，所以 `lossless` 必真。两条都不更新的话，状态条上会一直挂着
   * 两个已经不成立的提示。
   */
  it('mixedEol 置假、lossless 置真', async () => {
    seed()
    expect(useEditorStore.getState().files[0].view?.mixedEol).toBe(true)
    await useEditorStore.getState().save(KEY, NO_GATES, 'x\n')

    const view = useEditorStore.getState().files[0].view
    expect(view?.mixedEol).toBe(false)
    expect(view?.lossless).toBe(true)
  })

  it('saving 在飞期间为真、结束为假', async () => {
    seed()
    const p = useEditorStore.getState().save(KEY, NO_GATES, 'x\n')
    expect(useEditorStore.getState().files[0].saving).toBe(true)
    await p
    expect(useEditorStore.getState().files[0].saving).toBe(false)
  })
})

describe('三个闸门：一个字节都没写，所以什么都不许改', () => {
  it.each([
    [{ kind: 'conflict', reason: '远端文件在你编辑期间被改动过' } as RemoteFileSaveResult, 'conflict'],
    [{ kind: 'nonAtomic' } as RemoteFileSaveResult, 'nonAtomic'],
    [{ kind: 'shrink', remoteBytes: 8192, localBytes: 0 } as RemoteFileSaveResult, 'shrink']
  ])('%#. %s 时 view.text 不动、dirty 保持', async (result) => {
    seed({ dirty: true })
    saveResult = result
    const got = await useEditorStore.getState().save(KEY, NO_GATES, 'new\n')

    // 结果原样交给调用方（EditorHost 要据此弹确认框）
    expect(got).toEqual(result)
    const f = useEditorStore.getState().files[0]
    // 内容确实还没上去，所以脏标记**必须**留着 —— 清掉的话用户会以为存上了
    expect(f.view?.text).toBe('old\n')
    expect(f.dirty).toBe(true)
    expect(f.saving).toBe(false)
  })

  /** store 里不许有任何弹框：确认框归 EditorHost（要 antd 的 modal 上下文与 i18n） */
  it('store 里不弹任何对话框', () => {
    const src = stripComments(read('src/renderer/src/stores/useEditorStore.ts'))
    for (const ui of ['modal.', 'Modal', 'message.', 'confirm(']) {
      expect(src, `store 里出现了 ${ui} —— 弹框归 EditorHost`).not.toContain(ui)
    }
  })
})

describe('硬拒（抛异常）', () => {
  it('抛错时 saving 收回，异常原样往上抛', async () => {
    seed({ dirty: true })
    saveThrows = new Error('有 1 种字符无法用 gbk 表示')
    await expect(useEditorStore.getState().save(KEY, NO_GATES, 'x🎉\n')).rejects.toThrow(
      /无法用 gbk 表示/
    )
    const f = useEditorStore.getState().files[0]
    expect(f.saving).toBe(false)
    // 内容没上去，脏标记留着
    expect(f.dirty).toBe(true)
  })

  it('文件已经关掉了 → 抛错而不是静默什么都不做', async () => {
    seed()
    useEditorStore.setState({ files: [] })
    await expect(useEditorStore.getState().save(KEY, NO_GATES, 'x\n')).rejects.toThrow(/关掉/)
    expect(calls.some((c) => c[0] === 'sftp:fileSave')).toBe(false)
  })

  it('还没读完就存 → 抛错，一个字节都不发', async () => {
    seed({ status: 'loading', view: undefined })
    await expect(useEditorStore.getState().save(KEY, NO_GATES, 'x\n')).rejects.toThrow(/还没读完/)
    expect(calls.some((c) => c[0] === 'sftp:fileSave')).toBe(false)
  })
})

describe('脏标记', () => {
  it('setDirty 值没变时返回同一个数组（每次按键都会调到它）', () => {
    seed({ dirty: false })
    const before = useEditorStore.getState().files
    useEditorStore.getState().setDirty(KEY, false)
    // 引用相等 —— 否则每敲一个键整格编辑器都要重渲染一次
    expect(useEditorStore.getState().files).toBe(before)

    useEditorStore.getState().setDirty(KEY, true)
    expect(useEditorStore.getState().files).not.toBe(before)
    expect(useEditorStore.getState().files[0].dirty).toBe(true)
  })

  it('重新加载清掉脏标记（编辑器里的内容会被换成新读到的那份）', async () => {
    seed({ dirty: true })
    await useEditorStore.getState().reload(KEY)
    expect(useEditorStore.getState().files[0].dirty).toBe(false)
  })

  it('hasDirty 看全窗口（编辑器窗口关闭裁决用它）', () => {
    useEditorStore.setState({
      files: [
        { key: 'a::1', sessionId: 'a', path: '/1', origin: 'A', status: 'ready', charset: 'utf8', dirty: false, saving: false },
        { key: 'b::2', sessionId: 'b', path: '/2', origin: 'B', status: 'ready', charset: 'utf8', dirty: true, saving: false }
      ],
      active: undefined
    })
    expect(useEditorStore.getState().hasDirty()).toBe(true)
    useEditorStore.getState().setDirty('b::2', false)
    expect(useEditorStore.getState().hasDirty()).toBe(false)
  })

  it('新打开的文件是干净的', async () => {
    await useEditorStore.getState().open(SID, P, 'srv-1')
    const f = useEditorStore.getState().files[0]
    expect(f.dirty).toBe(false)
    expect(f.saving).toBe(false)
    expect(f.origin).toBe('srv-1')
  })

  it('关掉激活标签 → 焦点落到右边邻居（没有就左边）', async () => {
    useEditorStore.setState({
      files: ['1', '2', '3'].map((n) => ({
        key: `s::/${n}`,
        sessionId: 's',
        path: `/${n}`,
        origin: 'A',
        status: 'ready' as const,
        charset: 'utf8' as const,
        dirty: false,
        saving: false
      })),
      active: 's::/2'
    })
    useEditorStore.getState().close('s::/2')
    expect(useEditorStore.getState().active).toBe('s::/3')
    useEditorStore.getState().close('s::/3')
    expect(useEditorStore.getState().active).toBe('s::/1')
    // 关非激活项不动焦点
    useEditorStore.setState({ active: 's::/1' })
    useEditorStore.getState().close('nope')
    expect(useEditorStore.getState().active).toBe('s::/1')
  })
})

// ---------------- 接线护栏 ----------------

const HOST = 'src/renderer/src/features/editor/EditorWindowShell.tsx'
const EDITOR = 'src/renderer/src/features/editor/CodeEditor.tsx'
const CM_SETUP = 'src/renderer/src/features/editor/cmSetup.ts'
const SESSION_STORE = 'src/renderer/src/stores/useSessionStore.ts'

describe('一条确认只打开一个闸门', () => {
  /**
   * **这条是 SaveGates 拆成三个 boolean 在界面这一侧的红证。**
   *
   * 老路把三件事挤成一个 force，于是用户点"仍然覆盖"顺带把非原子替换也放行了。
   * 界面这侧同样能犯这个错 —— 只要在某个 onOk 里多写一个 gate。所以断言
   * GATE_OF 这张表里 kind 与 gate 是一对一的，且 onOk 只叠加 `spec.gate` 一个。
   */
  const src = stripComments(read(HOST))

  it('三种闸门各自映射到不同的一个开关', () => {
    const table = flat(src.slice(src.indexOf('const GATE_OF'), src.indexOf('export function EditorWindowShell')))
    for (const [kind, gate] of [
      ['conflict', 'overwriteRemoteChanges'],
      ['nonAtomic', 'allowNonAtomic'],
      ['shrink', 'allowShrink']
    ]) {
      const at = table.indexOf(`${kind}:`)
      expect(at, `GATE_OF 里没有 ${kind}`).toBeGreaterThan(0)
      // 每一项的 gate 必须紧跟在它自己的 kind 后面（150 字符内），不许交叉
      expect(table.slice(at, at + 150), `${kind} 该开的是 ${gate}`).toContain(`gate: '${gate}'`)
    }
  })

  it('onOk 里只叠加 spec.gate 那一个开关，不许写死第二个', () => {
    const at = src.indexOf('onOk: () => doSave')
    expect(at).toBeGreaterThan(0)
    const line = src.slice(at, at + 120)
    expect(line).toContain('[spec.gate]: true')
    for (const gate of ['overwriteRemoteChanges:', 'allowNonAtomic:', 'allowShrink:']) {
      expect(line, `onOk 里写死了 ${gate} —— 一条确认只能打开一个闸门`).not.toContain(gate)
    }
  })

  it('两个危险分支不给默认焦点（顺手一个回车不该等于覆盖别人的改动）', () => {
    const table = flat(src.slice(src.indexOf('const GATE_OF'), src.indexOf('export function EditorWindowShell')))
    // conflict 会盖掉别人的改动、shrink 会把文件截短 —— 这两个是 danger
    expect(table.slice(table.indexOf('conflict:'), table.indexOf('nonAtomic:'))).toContain(
      'danger: true'
    )
    expect(table.slice(table.indexOf('shrink:'))).toContain('danger: true')
    expect(flat(src)).toContain("autoFocusButton: spec.danger ? null : 'ok'")
  })

  /** 已经确认过的闸门又被拦一次 → 报错，绝不再弹一次框（否则是个关不掉的对话框） */
  it('同一个闸门不许弹第二次', () => {
    expect(flat(src)).toContain('if (gates[spec.gate])')
  })
})

describe('破坏性操作先问一句', () => {
  const src = stripComments(read(HOST))

  it('关标签 / 重新加载 / 换编码三条路都过 confirmDiscard', () => {
    // 三个入口都会让编辑器里那份内容消失，而"改了半小时"与"随手点了一下"界面上看不出区别
    expect(blockAfter(src, 'const tryClose')).toContain('confirmDiscard(')
    expect(blockAfter(src, 'const tryReload')).toContain('confirmDiscard(')
    // 换编码走的是 tryReload，不是 reload
    expect(flat(src)).toContain('onCharset={(charset: RemoteCharset) => tryReload(active.key, charset)}')
    expect(flat(src), '关闭按钮绕过了脏检查').not.toContain('closeFile(f.key)')
  })

  /**
   * 关会话**不再**碰编辑器：编辑器是独立窗口，文件的生死只归它自己的关闭链路管。
   * 嵌入式时代 closeTab 要先问脏、再 closeSession 清光 —— 那两步现在都不该存在，
   * 残留任何一步都会把另一个窗口里用户正改着的文件突然抽掉。
   */
  it('closeTab 不碰编辑器 store（脏裁决在编辑器窗口自己的关闭链路上）', () => {
    const store = stripComments(read(SESSION_STORE))
    expect(store, 'useSessionStore 又 import 编辑器 store 了').not.toContain('useEditorStore')
    // 编辑器窗口的关闭链路：closeRequest → hasDirty 裁决 → closeNow
    const shell = flat(stripComments(read(HOST)))
    const at = shell.indexOf("ofs.on('editor:closeRequest'")
    expect(at, '编辑器窗口没接 closeRequest').toBeGreaterThan(0)
    const handler = shell.slice(at, at + 700)
    expect(handler).toContain('hasDirty()')
    expect(handler).toContain("invoke('editor:closeNow')")
  })
})

describe('编辑器本体的接线', () => {
  it('装了撤销历史 —— 可写之后没有 Ctrl+Z 是不可接受的', () => {
    const src = stripComments(read(CM_SETUP))
    // history() 不装的话 historyKeymap 是空转，而 defaultKeymap 里并不含撤销
    expect(src).toContain('history()')
    expect(src).toContain('historyKeymap')
  })

  it('Ctrl+S 带 preventDefault（否则 Chromium 的"保存网页"会弹出来）', () => {
    const src = flat(stripComments(read(EDITOR)))
    const at = src.indexOf("key: 'Mod-s'")
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 120)).toContain('preventDefault: true')
  })

  /**
   * Ctrl+S 只在编辑器有焦点时生效。做成全局快捷键会抢掉终端里的流控（XOFF）——
   * less / vim 用户会莫名其妙。
   */
  it('Ctrl+S 不是全局快捷键', () => {
    const src = stripComments(read('src/renderer/src/hooks/useGlobalShortcuts.ts'))
    expect(src, 'Ctrl+S 被做成全局快捷键了 —— 终端里那是流控').not.toMatch(/KeyS|'s'/)
  })

  /**
   * 正文不进 store：doc 最大 2MB，每敲一个键复制一份字符串再重渲染整棵子树是可感知的卡。
   * 判据是 CodeEditor 不接受 onChange/onTextChange 这类"把正文推上去"的回调。
   */
  it('正文不往上推（只推脏标记，正文靠 docRef 取）', () => {
    const src = stripComments(read(EDITOR))
    expect(src).toContain('docRef.current = () => view.state.doc.toString()')
    for (const pushy of ['onChange', 'onTextChange', 'onDocChange']) {
      expect(src, `${pushy} 会把最多 2MB 的正文每次按键推一遍`).not.toContain(pushy)
    }
  })

  /**
   * 草稿暂存必须按 fileKey 清理。fileKey 是 `sessionId::path::charset`，
   * 关掉再重新打开同一个文件会得到同一个 key —— 不清的话，用户"关标签放弃改动"
   * 之后再打开，草稿会诡异地复活。
   */
  it('关掉的文件的草稿暂存会被清掉', () => {
    const src = stripComments(read(EDITOR))
    expect(flat(src)).toContain('const live = new Set(openKeys)')
    expect(src).toContain('states.current.delete(key)')
    expect(src).toContain('docBase.current.delete(key)')
  })

  /** 解不干净的文件必须只读：main 会硬拒，但界面不能让用户先改二十分钟再被拒 */
  it('lossless 为假时编辑器是只读的', () => {
    const src = flat(stripComments(read(HOST)))
    expect(src).toContain('!active.view.lossless')
    const at = src.indexOf('const readOnly =')
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 160)).toContain('lossless')
  })
})

// ---------------- 草稿去留的决策表 ----------------

/**
 * `planDraftSwap` 是整片里最容易静默丢数据的一段（只有一个 EditorView，
 * 切标签时无条件重建就会把未保存的改动扔掉），所以它被提成纯函数、有自己的表。
 *
 * 表里每一行都对应一个真实操作序列，别当成参数组合。
 */
describe('planDraftSwap：换文件时草稿的去留', () => {
  const base = { prevKey: 'A', fileKey: 'A', text: 'saved', currentDoc: 'saved' }

  it('首次挂载 → 建一份', () => {
    expect(
      planDraftSwap({ ...base, prevKey: null, hasStash: false, stashBase: undefined }).kind
    ).toBe('rebuild')
  })

  it('刚存成（doc 已等于新 text）→ 什么都不动，留住撤销历史', () => {
    expect(
      planDraftSwap({
        prevKey: 'A',
        fileKey: 'A',
        text: 'new',
        currentDoc: 'new',
        hasStash: false,
        stashBase: 'old'
      }).kind
    ).toBe('keep')
  })

  it('同一个文件被重新加载（text 变了、doc 还是旧的）→ 重建', () => {
    expect(
      planDraftSwap({
        prevKey: 'A',
        fileKey: 'A',
        text: 'from server',
        currentDoc: 'my draft',
        hasStash: false,
        stashBase: 'old'
      }).kind
    ).toBe('rebuild')
  })

  /**
   * **这一条是这个模块存在的理由。**
   * 改了 A → 切到 B → 切回 A：必须恢复 A 的暂存，否则 A 的改动静默消失。
   */
  it('改了 A → 切到 B → 切回 A：恢复 A 的草稿', () => {
    // 切走时 A 的暂存是按 'a-saved' 建的，切回来时 store 里还是 'a-saved'
    expect(
      planDraftSwap({
        prevKey: 'B',
        fileKey: 'A',
        text: 'a-saved',
        currentDoc: 'b-draft',
        hasStash: true,
        stashBase: 'a-saved'
      }).kind
    ).toBe('restore')
  })

  /**
   * 但暂存过期就不许恢复：A 在别处被重新读过（或存过），暂存里那份草稿是对着一份
   * 已经不存在的内容改的 —— 恢复它等于把旧内容写回去。
   */
  it('切回 A 时 A 已经被重新读过（暂存基准对不上）→ 重建，不恢复旧草稿', () => {
    expect(
      planDraftSwap({
        prevKey: 'B',
        fileKey: 'A',
        text: 'a-reloaded',
        currentDoc: 'b-draft',
        hasStash: true,
        stashBase: 'a-saved'
      }).kind
    ).toBe('rebuild')
  })

  it('切到一个从没打开过的文件 → 建一份', () => {
    expect(
      planDraftSwap({
        prevKey: 'A',
        fileKey: 'C',
        text: 'c',
        currentDoc: 'a',
        hasStash: false,
        stashBase: undefined
      }).kind
    ).toBe('rebuild')
  })

  /** 关掉再打开同一个文件时 fileKey 一样 —— 但暂存已经被 CodeEditor 清掉了，所以 hasStash 为假 */
  it('关掉再打开（暂存已清）→ 建一份，草稿不许复活', () => {
    expect(
      planDraftSwap({
        prevKey: 'B',
        fileKey: 'A',
        text: 'a-saved',
        currentDoc: 'b',
        hasStash: false,
        stashBase: undefined
      }).kind
    ).toBe('rebuild')
  })

  it('换编码（fileKey 变了、内容也变了）→ 建一份', () => {
    expect(
      planDraftSwap({
        prevKey: 'A::utf8',
        fileKey: 'A::gbk',
        text: '中文',
        currentDoc: '???',
        hasStash: false,
        stashBase: undefined
      }).kind
    ).toBe('rebuild')
  })
})

/**
 * 脏标记不许在按键路径上做 O(整个文档) 的活。
 *
 * 这一条只能靠源码护栏：`doc.toString() !== base` 与 `!sameDoc(doc, baseText)` **行为完全一样**，
 * 所有脏标记的行为用例对两者都是绿的。差别只在代价，而代价随文档大小走 ——
 * 实测每按键 1MB 1.8ms / 8MB 7.4ms / 32MB 14.3ms（一帧才 16ms）。
 * 在小文件上永远看不出来，而 MAX_EDIT_BYTES 正是刚从 2MB 放宽到 8MB。
 */
describe('脏标记的代价', () => {
  const src = stripComments(read('src/renderer/src/features/editor/CodeEditor.tsx'))

  it('updateListener 里不出现 doc.toString()', () => {
    const at = src.indexOf('updateListener.of')
    expect(at, 'updateListener 没了？').toBeGreaterThan(0)
    const body = flat(src.slice(at, at + 260))
    expect(body, '脏标记又回到 O(整个文档) 的字符串比较了').not.toContain('toString()')
    expect(body).toContain('sameDoc(')
  })

  it('sameDoc 先比 length 再 Text.eq —— 顺序反了就等于没优化', () => {
    const at = src.indexOf('function sameDoc')
    expect(at).toBeGreaterThan(0)
    const body = flat(src.slice(at, src.indexOf('\n}', at)))
    const lenAt = body.indexOf('doc.length !== base.length')
    const eqAt = body.indexOf('doc.eq(base)')
    expect(lenAt, 'length 那一步没了').toBeGreaterThan(0)
    expect(eqAt, 'Text.eq 那一步没了').toBeGreaterThan(0)
    expect(eqAt, 'length 必须在 Text.eq 之前').toBeGreaterThan(lenAt)
    // 基准不在时必须当作脏 —— 宁可多问一次，不许静默丢改动
    expect(body).toContain('if (!base) return false')
  })

  /**
   * 三处写基准的地方（首次挂载 / rebuild / keep）都得同时写 rope 那一份。
   * 漏一处的症状是"那个文件的脏标记永远亮着"（基准取不到 → sameDoc 返回 false）——
   * 关标签时每次都白问一次，而行为用例里那些都是小文件、不会注意到。
   */
  it('docBaseText 与 docBase 成对写、成对清', () => {
    expect((src.match(/docBaseText\.current\.set/g) ?? []).length).toBe(
      (src.match(/docBase\.current\.set/g) ?? []).length
    )
    expect((src.match(/docBaseText\.current\.delete/g) ?? []).length).toBe(
      (src.match(/docBase\.current\.delete/g) ?? []).length
    )
  })
})
