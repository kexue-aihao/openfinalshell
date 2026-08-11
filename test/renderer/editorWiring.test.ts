import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { DEFAULT_SETTINGS, REMOTE_CHARSETS } from '@shared/constants'
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

  /**
   * 内置编辑器的两条 channel 里都不许出现本地路径。
   *
   * 上一版这条只管 fileView，而且截止点取的是 'sftp:editOpen'（外部编辑器那条，
   * 它的返回里**确实**带着 localPath）。那条 channel 删掉之后截止点换成 transfer:enqueue ——
   * 传输队列是本项目里唯一正当地收本地路径的地方。
   *
   * 截止点用**代码里的那个 channel 名**而不是分节注释：stripComments 会把
   * `// --- 传输队列 ---` 整行吃掉，拿它当锚点会得到 -1，于是切片变成"从 fileView 到开头"、
   * 空字符串，断言恒真。（第一版就是这么写的，是下面那句 toBeGreaterThan 抓住的。）
   */
  it('fileView / fileSave 的契约里都没有本地路径', () => {
    const src = stripComments(read(IPC))
    const from = src.indexOf("'sftp:fileView'")
    const to = src.indexOf("'transfer:enqueue'")
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    expect(flat(src.slice(from, to))).not.toContain('localPath')
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

describe('会话面板布局（编辑器已迁去独立窗口）', () => {
  /**
   * 尺寸持久化不许按位置取值。
   *
   * 原来是 PanelGroup 的 `onLayout={(sizes) => … sizes[1]}`，而 sizes[1] 是"第二格"——
   * 面板增删一次它就指错一次。这种错不报警、不抛异常，只是把用户的布局越拖越歪。
   */
  it('用每个 Panel 自己的 onResize，不用 onLayout 按下标取值', () => {
    const src = stripComments(read(SESSION_VIEW))
    expect(src, '又回到按位置取 sizes[n] 了').not.toMatch(/sizes\[\d\]/)
    expect(src).not.toContain('onLayout')
    expect(src).toContain('sftpPaneHeightPct: size')
  })

  /**
   * 嵌入式编辑器那一格删净了没有。半删是最坏的状态：会话面板里残留一格
   * 没人喂数据的编辑器，与独立窗口各显示一份、迟早内容对不上。
   */
  it('会话面板里没有编辑器那一格', () => {
    const src = flat(stripComments(read(SESSION_VIEW)))
    expect(src).not.toContain('EditorHost')
    expect(src).not.toContain('id="editor"')
    expect(src).not.toContain('useEditorStore')
    // 该在的两格还在
    expect(src).toContain('id="term" order={1}')
    expect(src).toContain('id="sftp"')
  })
})

describe('独立编辑器窗口的接线', () => {
  const MAIN_ENTRY = 'src/renderer/src/main.tsx'
  const EDITOR_WINDOW = 'src/main/editorWindow.ts'
  const SHELL = 'src/renderer/src/features/editor/EditorWindowShell.tsx'
  const SFTP_PANE = 'src/renderer/src/features/sftp/SftpPane.tsx'

  it('editor: 前缀在 preload 白名单里，三条 invoke + 两条事件都在契约里', () => {
    const src = stripComments(read(IPC))
    const at = src.indexOf('export const CHANNEL_PREFIXES')
    expect(src.slice(at, src.indexOf('] as const', at))).toContain("'editor:'")
    const invoke = channelsOf('InvokeMap')
    for (const ch of ['editor:openFile', 'editor:ready', 'editor:closeNow']) {
      expect(invoke).toContain(ch)
    }
    const events = channelsOf('EventMap')
    expect(events).toContain('editor:open')
    expect(events).toContain('editor:closeRequest')
  })

  it('renderer 入口按 #/editor 分流；主进程两种加载方式都带上它', () => {
    const entry = stripComments(read(MAIN_ENTRY))
    expect(entry).toContain("window.location.hash.startsWith('#/editor')")
    expect(entry).toContain('EditorWindowApp')
    const win = stripComments(read(EDITOR_WINDOW))
    // dev 是 URL 拼接、打包走 loadFile 的 hash 选项 —— 少一个的症状是那种模式下
    // 编辑器窗口渲染出**整个主界面**（分流条件不成立就落到 App）
    expect(win).toContain('#/editor')
    expect(flat(win)).toContain("loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: '/editor' })")
  })

  /**
   * **打开请求要排队。** 窗口刚创建时 renderer 还没订阅 editor:open，直接 send 必丢
   * （发进虚空、不报错）—— 症状是"第一次点『内置编辑器查看』只出来一个空窗口"。
   * renderer 侧则必须先挂订阅再 invoke editor:ready 领队列，顺序反了同样丢。
   */
  it('renderer 就绪前的请求进队列，就绪后由 editor:ready 取走', () => {
    const win = flat(stripComments(read(EDITOR_WINDOW)))
    expect(win).toContain('pending.push(req)')
    expect(win).toContain('rendererReady')
    const shell = stripComments(read(SHELL))
    const sub = shell.indexOf("ofs.on('editor:open'")
    const ready = shell.indexOf("invoke('editor:ready')")
    expect(sub).toBeGreaterThan(0)
    expect(ready, '没有领取排队请求的 editor:ready').toBeGreaterThan(sub)
  })

  /**
   * 窗口关闭必须过 renderer 的脏裁决：close 拦下来发 closeRequest，
   * 收到 closeNow 才放行。少了拦截，未保存的改动随手一个 × 就没了。
   */
  it('close 被拦下交给 renderer 裁决，closeNow 才放行', () => {
    const win = flat(stripComments(read(EDITOR_WINDOW)))
    expect(win).toContain('e.preventDefault()')
    expect(win).toContain("emitEditor('editor:closeRequest', null)")
    expect(win).toContain('allowClose = true')
  })

  it('SftpPane 的「内置编辑器查看」走 editor:openFile，不再直摸编辑器 store', () => {
    const src = stripComments(read(SFTP_PANE))
    expect(flat(src)).toContain("invoke('editor:openFile'")
    expect(src, 'SftpPane 又直接 import 编辑器 store 了').not.toContain('useEditorStore')
  })

  /**
   * 两个窗口都要收到的低频事件必须走 broadcast：settings:changed（编辑器窗口的
   * 主题/语言热更）与 session:state（断连横幅）。只发主窗口的症状是编辑器窗口
   * 主题切不动、会话断了也不知道 —— 都不报错。
   */
  it('settings:changed 与 session:state 走 broadcast', () => {
    expect(
      flat(stripComments(read('src/main/ipc/settings.ipc.ts')))
    ).toContain("broadcast('settings:changed', next)")
    expect(
      flat(stripComments(read('src/main/ssh/SshConnectionManager.ts')))
    ).toContain("broadcast('session:state'")
  })

  /** term:data 这类高频字节流不许广播：编辑器窗口不消费它，广播就是每块白克隆一次 */
  it('broadcast 只用于低频事件，term:data 仍然只发主窗口', () => {
    const src = flat(stripComments(read('src/main/ssh/ShellSession.ts')))
    expect(src).toContain("emit('term:data'")
    expect(src, 'term:data 被广播出去了').not.toContain("broadcast('term:data'")
  })

  /**
   * 会话面板关掉 tab 时**不动**编辑器 store：编辑器文件活在另一个窗口里，
   * 这边一动就是把用户正改着的文件突然抽掉（closeTab 里那段注释是完整理由）。
   */
  it('useSessionStore 不 import 编辑器 store', () => {
    const body = blockAfter(stripComments(read(SESSION_STORE)), 'closeTab: async (id)')
    expect(flat(body)).not.toContain('useEditorStore')
  })
})

describe('读和写共用同一份门禁', () => {
  /**
   * 软链解析只能有一份实现，而现在它的两个消费者是**读**（readRemoteTextFile）
   * 与**写**（fileSave）—— 上一版是"只读查看"与"外部编辑器"。
   *
   * 不解析的后果是致命的：写回用的 rename 会把软链**本身**替换成普通文件，
   * 而 /etc/nginx/sites-enabled/* 全是软链。所以断言的是"fileSave 不自己判软链"。
   */
  it('fileSave 走 resolveRemoteTarget，不自己 lstat/realpath', () => {
    const src = stripComments(read('src/main/sftp/fileSave.ts'))
    expect(src).toContain('resolveRemoteTarget(sftp, path)')
    for (const gone of ['sftpLstat(', 'sftpRealpath(', "=== 'symlink'", 'typeFromMode(']) {
      expect(src, `${gone} 出现在 fileSave 里了 —— 软链解析有了第二份实现`).not.toContain(gone)
    }
  })

  it('读那条路也走同一个函数', () => {
    const src = stripComments(read('src/main/sftp/remoteTextFile.ts'))
    expect(src).toContain('await resolveRemoteTarget(sftp, remotePath)')
  })

  /**
   * 内置编辑器这条路上不该出现本地文件与子进程。
   *
   * 上一版这条盯的是"只读查看别学外部编辑器那套"；现在外部编辑器没了，
   * 它盯的是**别把那套重新长出来** —— 内容以字符串来回，main 侧一个本地文件都不落。
   */
  it('查看与保存两条路上都没有 spawn、没有本地临时文件', () => {
    for (const f of ['src/main/sftp/fileView.ts', 'src/main/sftp/fileSave.ts']) {
      const src = stripComments(read(f))
      for (const forbidden of ['child_process', 'spawn', 'writeFile', 'mkdtemp', 'app.getPath']) {
        expect(src, `${f} 不该碰 ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})

/**
 * 外部编辑器那条路删干净了没有。
 *
 * 半删是最坏的状态：契约里留着一条没人实现的 channel、界面上留着一个点了没反应的菜单项、
 * 或者反过来 —— 实现还在但没人调（那就是一片没有测试保护的活代码）。所以这里两头都查。
 */
describe('外部编辑器整条路已删净', () => {
  it('那几条 channel 从契约里消失了', () => {
    const invoke = channelsOf('InvokeMap')
    // 反空转：正则失配时下面这些断言会在空数组上空跑
    expect(invoke.length).toBeGreaterThan(30)
    for (const gone of [
      'sftp:editOpen',
      'sftp:editList',
      'sftp:editSave',
      'sftp:editRetry',
      'sftp:editStop',
      'sftp:pickEditor',
      'sftp:clearEditor'
    ]) {
      expect(invoke, `${gone} 还在契约里`).not.toContain(gone)
    }
    // 该留的还在
    expect(invoke).toContain('sftp:fileView')
    expect(invoke).toContain('sftp:fileSave')
  })

  it('事件表里没有 sftp:editState', () => {
    const events = channelsOf('EventMap')
    expect(events.length).toBeGreaterThan(5)
    expect(events).not.toContain('sftp:editState')
  })

  it('那两个模块的文件真的不在了', () => {
    for (const gone of [
      'src/main/sftp/RemoteEditManager.ts',
      'src/main/sftp/localFileWatch.ts',
      'src/renderer/src/features/sftp/editUiState.ts'
    ]) {
      expect(existsSync(gone), `${gone} 还在`).toBe(false)
    }
  })

  it('设置里没有 externalEditorPath 了（连默认值一起）', () => {
    expect(Object.keys(DEFAULT_SETTINGS.sftp)).not.toContain('externalEditorPath')
  })

  /**
   * **「打开」必须落到内置编辑器。** 这是这一片里用户唯一看得见的行为变化：
   * 那个菜单项与双击（doubleClickAction='open'）走的是同一个分支，
   * 上一版它调 startEdit（起外部编辑器）。接错的症状是"点「打开」什么都不发生"——
   * 不报错、不抛异常，只是没反应。
   */
  it('openEntry 的 edit 分支调的是内置编辑器', () => {
    const src = stripComments(read('src/renderer/src/features/sftp/SftpPane.tsx'))
    expect(flat(src)).toContain("else if (fileAction === 'edit') void openInEditor(entry)")
    expect(src, 'startEdit 还在 —— 外部编辑器那条路没删净').not.toContain('startEdit')
  })
})
