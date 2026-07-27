import { describe, expect, it } from 'vitest'
import { REMOTE_CHARSETS } from '@shared/constants'
import { createMockOfs } from '@/ipc/mock'
import { blockAfter, channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * 内置编辑器的接线护栏。
 *
 * 这里只放"少写一行也编译得过、跑起来也不抛，只是静默走偏"的那几条 ——
 * 语法着色、点击落点、CSP、编码解析都有各自的行为用例（editorPolicy / legacyTokens /
 * textCodec 三个单测 + 打包冒烟 step 8.8），不在这儿重复。
 */

const IPC = 'src/shared/ipc.ts'
const SFTP_IPC = 'src/main/ipc/sftp.ipc.ts'
const SESSION_VIEW = 'src/renderer/src/features/sessions/SessionView.tsx'
const SESSION_STORE = 'src/renderer/src/stores/useSessionStore.ts'
const EDIT_MANAGER = 'src/main/sftp/RemoteEditManager.ts'

describe('契约与 IPC 边界', () => {
  it('sftp:fileView 在契约里，且落在 sftp: 前缀下', () => {
    const invoke = channelsOf('InvokeMap')
    // 反空转：正则失配时下面那条断言会在空数组上空跑
    expect(invoke.length).toBeGreaterThan(30)
    expect(invoke).toContain('sftp:fileView')
  })

  /**
   * **这一条是安全边界，不是代码风格。**
   *
   * charset 是渲染进程可控输入（状态栏上能切编码），而 iconv-lite 除了真编码之外还接受
   * 'hex' / 'base64' 这类字节变换。今天这条通道只读，所以最坏是把文件显示成一堆十六进制；
   * 可编辑之后，一个 'hex' 就意味着渲染进程能用 "0a1b2c…" 精确构造任意字节写到远端文件里 ——
   * 而"我们只传字符串所以构造不出任意字节"这个论证会当场失效。
   *
   * 判据是 z.enum(REMOTE_CHARSETS)：换成 z.string() 一样编译得过、一样跑得通、
   * 一样通不过任何别的用例。
   */
  it('charset 在 zod 那一层就按白名单卡死（不是 z.string）', () => {
    const src = stripComments(read(SFTP_IPC))
    const at = src.indexOf("'sftp:fileView'")
    expect(at, 'sftp:fileView 没有在 main 侧注册').toBeGreaterThan(0)
    const decl = flat(src.slice(at, at + 400))
    expect(decl).toContain('z.enum(REMOTE_CHARSETS)')
    expect(decl, 'charset 被放成了任意字符串').not.toMatch(/charset:\s*z\.string/)
  })

  it('白名单里没有 iconv 的字节变换伪编码', () => {
    for (const fake of ['hex', 'base64', 'binary', 'utf16', 'utf-16le', 'ucs2']) {
      expect(REMOTE_CHARSETS as readonly string[], `${fake} 不该在白名单里`).not.toContain(fake)
    }
    // 反空转：真编码得在
    expect(REMOTE_CHARSETS as readonly string[]).toContain('utf8')
    expect(REMOTE_CHARSETS as readonly string[]).toContain('gbk')
  })

  it('只读查看的返回里没有本地路径（本地路径只出不进那条铁律的另一半）', () => {
    const src = stripComments(read(IPC))
    const decl = flat(src.slice(src.indexOf("'sftp:fileView'"), src.indexOf("'sftp:editOpen'")))
    expect(decl).not.toContain('localPath')
  })

  it('mock 里有 fileView，否则浏览器 mock 模式一点开就抛', async () => {
    const ofs = createMockOfs()
    const view = await ofs.invoke('sftp:fileView', { sessionId: 's1', path: '/etc/x.conf' })
    expect(view.text.length).toBeGreaterThan(0)
    expect(view.requestedPath).toBe('/etc/x.conf')
    // mock 也要带上那个全角空格：它是"不可见字符标记"这条功能在 mock 模式下的唯一样本
    expect(view.text).toContain('　')
  })
})

describe('三格布局', () => {
  /**
   * 尺寸持久化不许按位置取值。
   *
   * 原来是 PanelGroup 的 `onLayout={(sizes) => … sizes[1]}`，而 sizes[1] 是"第二格"——
   * 编辑器那一格插进来之后，第二格从 SFTP 变成了编辑器，于是拖编辑器的分隔条
   * 会静默写进 sftpPaneHeightPct。这种错不报警、不抛异常，只是把用户的布局越拖越歪。
   */
  it('用每个 Panel 自己的 onResize，不用 onLayout 按下标取值', () => {
    const src = stripComments(read(SESSION_VIEW))
    expect(src, '又回到按位置取 sizes[n] 了').not.toMatch(/sizes\[\d\]/)
    expect(src).not.toContain('onLayout')
    // 两格各有自己的 onResize，各写自己那个键
    expect(src).toContain('editorPaneHeightPct: size')
    expect(src).toContain('sftpPaneHeightPct: size')
  })

  it('三格顺序是 终端 1 / 编辑器 2 / SFTP 3', () => {
    const src = flat(stripComments(read(SESSION_VIEW)))
    const term = src.indexOf('id="term" order={1}')
    const editor = src.indexOf('id="editor" order={2}')
    const sftp = src.indexOf('id="sftp" order={3}')
    expect(term).toBeGreaterThan(0)
    expect(editor).toBeGreaterThan(term)
    expect(sftp).toBeGreaterThan(editor)
  })
})

describe('不泄漏', () => {
  /**
   * 会话关掉要连它的文件一起清。这一条与 useMonitorStore.clear 那个泄漏是同一类，
   * 而且更贵：每份正文最多 2MB，JS 字符串是 UTF-16，十份就是 40MB 常驻。
   * 断言必须在 closeTab 的**函数体内**找到调用 —— 只在整份文件里搜字符串的话，
   * 写在别处（甚至写在一段永不执行的代码里）也算过。
   */
  it('closeTab 里清掉该会话的编辑器文件', () => {
    const body = blockAfter(stripComments(read(SESSION_STORE)), 'closeTab: async (id)')
    expect(flat(body)).toContain('useEditorStore.getState().closeSession(tab.sessionId)')
  })
})

describe('只读查看与外部编辑器共用同一份门禁', () => {
  /**
   * 软链解析 + 三道门（类型 / 尺寸 / 二进制）只能有一份实现。
   *
   * 软链那条不做的后果是致命的：写回用的 rename 会把软链**本身**替换成普通文件，
   * 而 /etc/nginx/sites-enabled/* 全是软链。两份实现漂开的第一天就会有一边写坏文件，
   * 所以这条断言的是"RemoteEditManager 不再自己做这些判断"。
   */
  it('RemoteEditManager 走 readRemoteTextFile，不再自己判软链/类型/尺寸/二进制', () => {
    const src = stripComments(read(EDIT_MANAGER))
    expect(src).toContain('readRemoteTextFile(sftp, remotePath)')
    // 这四个是被提走的判断，留在这儿就说明有人把它们抄回来了
    for (const gone of ['sftpLstat(', 'sftpRealpath(', "=== 'symlink'", 'typeFromMode(']) {
      expect(src, `${gone} 又回到 RemoteEditManager 里了 —— 门禁出现了第二份实现`).not.toContain(gone)
    }
  })

  it('只读查看那条路上没有 spawn、没有本地临时文件', () => {
    const src = stripComments(read('src/main/sftp/fileView.ts'))
    for (const forbidden of ['child_process', 'spawn', 'writeFile', 'mkdtemp', 'app.getPath']) {
      expect(src, `只读查看不该碰 ${forbidden}`).not.toContain(forbidden)
    }
  })
})
