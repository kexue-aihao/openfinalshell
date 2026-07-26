import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { CHANNEL_PREFIXES, MAIN_ONLY_SETTINGS_PATHS, type EventMap } from '@shared/ipc'
import type { RemoteEditEntry } from '@shared/types'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { createMockOfs } from '@/ipc/mock'
import { blockAfter, channelsOf, flat, read, stripComments } from './sourceGuard'

/**
 * 远端编辑"接线"这一片的护栏。挑的这几处都有同一个特征：错了不会抛异常，只会静默走偏。
 *
 *  1. channel 名必须落在 preload 的前缀白名单里 —— 起成 'edit:open' 的话 renderer 一调
 *     就被 assertChannel 拦在门外，而白名单常量本身照样是绿的；
 *  2. 只许 main 自己写的设置键（externalEditorPath → spawn 的可执行文件）必须真的在
 *     IPC 边界被剥掉，且那张表指向的字段必须真的存在；
 *  3. RemoteEditManager 的三个清场入口（stopBySession / stopAll / purgeStaleTempDirs）
 *     必须真的有调用点 —— 没人调它们时，远端文件的明文副本会永久留在 %TEMP%；
 *  4. 浏览器调试模式的桩：编辑是一条纯异步状态链，桩若只回终态，
 *     downloading / uploading 这些只在中间态露脸的 UI 在浏览器里根本没法验；
 *  5. shrink（截断闸门）与"编辑器起不动"这两条 main 侧新加的信息必须真的有界面出口 ——
 *     两者都属于"main 发了、界面没接，于是用户什么都看不到"的静默走偏。
 *
 * 前三条都得从**源码文本**上钉：它们全是"少写一行也编译得过"的那类错，类型系统看不见。
 * 所以 1 不再对着本文件里硬编码的字符串数组断言（那种写法把 'sftp:editOpen' 真改成
 * 'edit:open' 之后依然是绿的，而它宣称防的正是这个），改成运行期从 src/shared/ipc.ts
 * 的源码里枚举真实 channel 名。
 *
 * 这几个读源码的小工具（read / stripComments / flat / blockAfter / channelsOf）现在住在
 * ./sourceGuard —— 快速删除那片护栏也要用，两份实现会各自漂移。
 */

describe('接线契约', () => {
  const invoke = channelsOf('InvokeMap')
  const events = channelsOf('EventMap')
  const all = [...invoke, ...channelsOf('SendMap'), ...events]

  it('契约源码里的每一个 channel 都落在 preload 前缀白名单内', () => {
    // 先确认真的抠出东西来了：正则失配时下面那条断言会空跑一遍还是绿的
    expect(invoke.length).toBeGreaterThan(30)
    expect(events.length).toBeGreaterThan(5)
    const blocked = all.filter((c) => !CHANNEL_PREFIXES.some((p) => c.startsWith(p)))
    expect(blocked).toEqual([])
  })

  it('远端编辑这一组 channel 的名字就是界面/主进程两侧写死的那些', () => {
    // 改名会让 renderer 与 main 各自安静地对着不存在的 channel 说话（invoke 侧报"没有处理器"，
    // 事件侧连报错都没有）。这一组的名字在两侧都是字面量，只能靠这里对齐
    expect(invoke).toEqual(
      expect.arrayContaining([
        'sftp:editOpen',
        'sftp:editList',
        'sftp:editSave',
        'sftp:editRetry',
        'sftp:editStop',
        'sftp:pickEditor',
        'sftp:clearEditor'
      ])
    )
    expect(events).toContain('sftp:editState')
    // 重试与"仍然覆盖"必须是两个入口：合成一个的话，一次网络抖动就把用户推上跳过冲突检测的路
    expect(invoke.filter((c) => c === 'sftp:editRetry')).toHaveLength(1)
  })
})

describe('外部编辑器：只许 main 自己写', () => {
  it('主进程独占键那张表指向的字段必须真的存在', () => {
    expect(MAIN_ONLY_SETTINGS_PATHS).toContain('sftp.externalEditorPath')
    for (const path of MAIN_ONLY_SETTINGS_PATHS) {
      const [section, key] = path.split('.')
      const node = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[section]
      expect(node, `${path}：设置里没有 ${section} 这一段`).toBeTypeOf('object')
      // 字段改了名而这张表没跟着改的话，剥离就成了空转 —— 洞会一声不响地重新打开
      expect(Object.keys(node as object), `${path}：这一段里没有 ${key}`).toContain(key)
    }
    // 默认空串 = 系统默认打开方式；给个猜的路径会静默起一个用户没想用的程序
    expect(DEFAULT_SETTINGS.sftp.externalEditorPath).toBe('')
  })

  /**
   * 剥离与校验的**实现**已经搬进 services/settings.ts（stripMainOnlyPaths /
   * assertUsableEditor，两个纯函数的行为由 test/unit/settingsGuard.test.ts 直接测）。
   * 留在这里的是**接线**：那两道门必须真的架在每一个"外来数据"入口上 ——
   * 少调一处不会抛异常、不会编译不过，只会让那个入口安静地重新打开。
   */
  it('settings:set 不把渲染进程给的 patch 原样交给 patchSettings', () => {
    const src = stripComments(read('src/main/ipc/settings.ipc.ts'))
    // 拿 channel 名的字符串字面量当锚点：handle( 与它之间怎么折行都不影响
    const body = flat(blockAfter(src, "'settings:set'"))
    expect(body).toMatch(/stripMainOnlyPaths\(\s*patch\s*,/)
    // 这就是那条提权链的第二步：patchSettings(patch) 会把渲染进程给的 exe 路径直接落库
    expect(body).not.toMatch(/patchSettings\(\s*patch\s*[,)]/)
    // 那张表得真的被剥离实现读到：没人读它，剥离就是空转，洞会一声不响地重新打开
    expect(flat(stripComments(read('src/main/services/settings.ts')))).toContain(
      'MAIN_ONLY_SETTINGS_PATHS'
    )
  })

  it('导入配置那条外来入口同样过剥离（换机迁移的导出文件也不可信）', () => {
    // 这一条是上一版真实漏掉的那处：只有 settings:set 剥，导入文件整条绕过去 ——
    // 一份同事分享的导出文件里写上 sftp.externalEditorPath，受害者此后每次
    // "编辑远端文件"都会执行文件里指定的那个 exe
    const src = flat(stripComments(read('src/main/services/importData.ts')))
    expect(src).toMatch(/stripMainOnlyPaths\(/)
  })

  it('spawn 的 exe 只能来自 sftp:pickEditor 那条路，且校验过', () => {
    const ipc = flat(stripComments(read('src/main/ipc/sftp.ipc.ts')))
    expect(ipc).toMatch(/handle\(\s*'sftp:pickEditor'/)
    expect(ipc).toMatch(/handle\(\s*'sftp:clearEditor'/)
    // 写入侧：对话框结果落库之前先过校验。对话框那个 filters 只是过滤器不是校验 ——
    // 用户可以在文件类型里切成"所有文件"
    expect(flat(blockAfter(ipc, "'sftp:pickEditor'"))).toMatch(/assertUsableEditor\(\s*picked\s*\)/)
    // 校验本体：绝对路径 + 存在 + 是文件 + win32 只放行 .exe，四条都得在
    const guard = flat(stripComments(read('src/main/services/settings.ts')))
    expect(guard).toMatch(/isAbsolute\(/)
    expect(guard).toMatch(/isFile\(\)/)
    expect(guard).toMatch(/extname\(/)
    expect(guard).toMatch(/'\.exe'/)
    // .bat/.cmd 要经 cmd.exe 解释执行，放行它等于把 shell 请回来
    expect(guard).not.toMatch(/'\.(bat|cmd)'/)
    // 使用侧（spawn 之前每次都再校验一次、且空串那条路不许调它）是行为，
    // 由 test/unit/remoteEditManager.test.ts 的 launchEditor 用例钉，这里不重抄一遍源文本
  })
})

describe('编辑清场：三个入口都得有调用点', () => {
  const managerSrc = stripComments(read('src/main/sftp/RemoteEditManager.ts'))

  it('RemoteEditManager 上确实有这三个方法（调用点不许写给一个不存在的导出）', () => {
    for (const method of ['stopBySession', 'stopAll', 'purgeStaleTempDirs', 'retry']) {
      expect(flat(managerSrc), `RemoteEditManager 没有 ${method}`).toMatch(
        new RegExp(`async ${method}\\(`)
      )
    }
  })

  it('会话关闭时按会话清场（不然 watcher 泄漏、明文副本留在 %TEMP%）', () => {
    const src = stripComments(read('src/main/ssh/SshConnectionManager.ts'))
    const body = flat(blockAfter(src, 'close(sessionId'))
    expect(body).toMatch(/remoteEditManager\.stopBySession\(\s*sessionId\s*\)/)
  })

  it('退出时 stopAll、启动时清掉上次崩溃留下的临时根', () => {
    const src = stripComments(read('src/main/index.ts'))
    expect(flat(blockAfter(src, "app.on('before-quit'"))).toMatch(
      /remoteEditManager\.stopAll\(\s*\)/
    )
    // 必须在 app ready 之后：模块顶层那会儿 app.getPath('temp') 还没准备好
    expect(flat(blockAfter(src, 'app.whenReady()'))).toContain('purgeStaleTempDirs')
    /**
     * 这里曾经还有一条 `indexOf('purgeStaleTempDirs') > indexOf('requestSingleInstanceLock')`
     * 的源码顺序护栏，声称防的是"第二个实例把第一个实例正在用的目录删掉"。它是纸糊的：
     * 把 purge 挪到 app.on('ready') 顶层（正是它声称要防的形状）照样绿，因为那一行在
     * 文件里的字节偏移仍然排在单实例锁后面。真正的语义现在由
     * test/unit/remoteEditManager.test.ts 里那两条**行为**用例接管（按真实顺序跑一遍 +
     * 靠 .ofs-owner 里的 pid 探活判"这个根还有没有主"），删掉不留假保险。
     */
  })
})

/**
 * 这一片只能从源文本上守：渲染进程的测试跑在 node 环境（没有 jsdom），组件挂不起来，
 * 而这里要钉的偏偏是"main 发出来的东西在界面上有没有出口"—— 漏接不抛异常、不报错，
 * 只是用户永远等不到那个框。同 sftpEditUi.test.ts 里那几条的做法。
 */
describe('shrink：截断闸门要有界面出口', () => {
  const pane = stripComments(read('src/renderer/src/features/sftp/SftpPane.tsx'))

  it('shrink 与 conflict/blocked 走同一个覆盖确认框，不另开一条 force 保存的路', () => {
    // 三态在同一处分岔。漏掉 shrink 的话，"远端 nginx.conf 差点被截断"这件事在界面上
    // 只剩列表里一行状态字，等裁决的编辑永远等不到裁决
    const variants = flat(blockAfter(pane, 'function overwriteVariantOf'))
    for (const state of ['conflict', 'blocked', 'shrink']) {
      expect(variants, `overwriteVariantOf 漏了 ${state}`).toContain(`'${state}'`)
    }
    // "仍然覆盖"仍旧只有一条路（editSave 带 force）——shrink 不许自己再开一个入口，
    // 那等于多一条跳过冲突检测的路。sftpEditUi.test.ts 那条同款断言是另一半保险
    expect(pane.match(/force: true/g) ?? []).toHaveLength(1)
  })

  it('三态各用自己的标题与说明，不套 conflict 那套', () => {
    // 新态套旧文案比没有框更坏：它告诉用户"远端在编辑期间被人改过"，
    // 而实情是他本地这份只剩半截 —— 照着那句话点"仍然覆盖"正好把远端截断
    for (const key of ['editShrinkTitle', 'editShrinkDesc', 'editShrinkHint', 'editStateShrink']) {
      expect(pane, `SftpPane 没用上 sftp.${key}`).toContain(`t('sftp.${key}'`)
    }
  })

  it('说明里带远端实数，且调用处真的把这个数传进去了', () => {
    // {{remote}} 占位符没人给值时 i18next 原样渲染 "{{remote}}"，类型系统看不见这种错
    for (const sftp of [zh.translation.sftp, en.translation.sftp]) {
      expect(sftp.editShrinkDesc).toContain('{{remote}}')
    }
    expect(flat(pane)).toMatch(/t\(\s*'sftp\.editShrinkDesc'\s*,\s*\{\s*remote:/)
    // 取不到那个数时说"未知大小"，不许拿 0 顶替 —— "远端原来有 0 B"是句谎话，
    // 而它恰好会把用户往"那覆盖吧"推
    expect(pane).toContain("t('sftp.editSizeUnknown')")
  })

  it('默认按钮不是"仍然覆盖"', () => {
    // 这一态最可能的成因是编辑器还没写完就被读到了：顺手一个回车不该把远端文件截断。
    // 另两态沿用 antd 的默认焦点，所以这里钉的是"shrink 这一支给的是 null"
    expect(flat(pane)).toMatch(/autoFocusButton:\s*variant === 'shrink'\s*\?\s*null/)
  })

  it('重新挂载时停在 shrink 的编辑同样会弹框', () => {
    // 收起 SFTP 分屏期间订阅是断的，停下来的编辑只能靠这次全量对齐捞出来 ——
    // 这条分支漏了 shrink，那些编辑就只能靠用户再存一次盘才有人管
    expect(flat(blockAfter(pane, '.then((list)'))).toMatch(/overwriteVariantOf\(\s*e\.state\s*\)/)
  })
})

describe('外部编辑器起不动：界面要看得见', () => {
  const pane = stripComments(read('src/renderer/src/features/sftp/SftpPane.tsx'))
  const manager = stripComments(read('src/main/sftp/RemoteEditManager.ts'))
  /**
   * main 侧那句原话的开头。它同时是两侧的约定：main 起不了编辑器时**刻意不改状态**
   * （编辑本身没坏：文件已落地、watcher 还在盯着），只在原状态上挂一句 message，
   * 于是这条信息混在普通 warning 里到达，界面只能靠这个开头把它跟"权限位没恢复"
   * 那类 warning 分开。任一侧改了这句话，下面这条就红 —— 那正是要它红的时候。
   */
  const MARKER = '外部编辑器没能启动'

  it('main 侧发的那句话与界面认的前缀是同一串', () => {
    expect(manager, 'RemoteEditManager 不再发这句话了').toContain(MARKER)
    expect(pane, 'SftpPane 认的前缀跟 main 发的对不上').toContain(MARKER)
  })

  it('认出来之后弹的是带"去设置里换一个"的那条，且不重复弹原话', () => {
    expect(pane).toContain("t('sftp.editEditorFailed'")
    // 原话被这个条件挡住，否则同一件事弹两条（一条原话 + 一条带引导的）
    expect(flat(pane)).toMatch(/p\.warning && !editorDown/)
    for (const sftp of [zh.translation.sftp, en.translation.sftp]) {
      // main 那句人话（含原因和本地路径）要原样带进去，光说"编辑器起不来"没法排查
      expect(sftp.editEditorFailed).toContain('{{reason}}')
    }
    // 必须把人引到设置里去：这条最常见的成因就是那个 exe 被换掉/删掉了
    expect(zh.translation.sftp.editEditorFailed).toMatch(/设置/)
    expect(en.translation.sftp.editEditorFailed).toMatch(/Settings/)
  })

  it('它不是"写回失败"，不许混进重试框那条路', () => {
    // 走重试框等于给一个毫不相干的出口（"重试写回"），而远端根本没出问题；
    // 真正该做的是换一个编辑器。所以这一支只弹 message，不碰 askEditRetry
    expect(flat(blockAfter(pane, 'if (editorDown)'))).not.toContain('askEditRetry')
  })
})

describe('mock IPC：远端编辑桩', () => {
  let ofs = createMockOfs()
  let seen: EventMap['sftp:editState'][] = []

  beforeEach(() => {
    vi.useFakeTimers()
    ofs = createMockOfs()
    seen = []
    ofs.on('sftp:editState', (p) => seen.push(p))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const open = (path: string, sessionId = 's1'): Promise<RemoteEditEntry> =>
    ofs.invoke('sftp:editOpen', { sessionId, path })

  it('editOpen 先给 downloading，晚一拍才补 editing 事件', async () => {
    const entry = await open('/etc/nginx/nginx.conf')
    expect(entry.state).toBe('downloading')
    // 本地路径由"main"派生并只出不进：界面要能显示它
    expect(entry.localPath).not.toBe('')
    expect(seen).toEqual([])

    vi.advanceTimersByTime(1000)
    expect(seen.map((e) => e.state)).toEqual(['editing'])
    expect(seen[0].editId).toBe(entry.id)
    expect(seen[0].remotePath).toBe('/etc/nginx/nginx.conf')
  })

  it('同会话同路径重复 open 复用同一条编辑', async () => {
    const first = await open('/home/test/.bashrc')
    const again = await open('/home/test/.bashrc')
    expect(again.id).toBe(first.id)
    expect(await ofs.invoke('sftp:editList', { sessionId: 's1' })).toHaveLength(1)
  })

  it('editSave 缺 force 直接拒 —— 不给"保存"按钮留一条跳过冲突检测的路', async () => {
    const entry = await open('/home/test/notes.md')
    await expect(ofs.invoke('sftp:editSave', { editId: entry.id })).rejects.toThrow(/仍然覆盖/)
    await expect(
      ofs.invoke('sftp:editSave', { editId: entry.id, force: false })
    ).rejects.toThrow(/仍然覆盖/)
  })

  it('editSave 带 force 走 uploading → editing 并落下 savedAt', async () => {
    const entry = await open('/home/test/notes.md')
    vi.advanceTimersByTime(1000)
    seen.length = 0

    const saving = await ofs.invoke('sftp:editSave', { editId: entry.id, force: true })
    expect(saving.state).toBe('uploading')
    expect(seen.map((e) => e.state)).toEqual(['uploading'])

    vi.advanceTimersByTime(1000)
    expect(seen.map((e) => e.state)).toEqual(['uploading', 'editing'])
    const [row] = await ofs.invoke('sftp:editList', { sessionId: 's1' })
    expect(row.savedAt).toBeGreaterThan(0)
  })

  it('editRetry 不需要 force（它保留冲突检测），编辑没了则报人话', async () => {
    const entry = await open('/home/test/notes.md')
    vi.advanceTimersByTime(1000)
    seen.length = 0

    const retrying = await ofs.invoke('sftp:editRetry', { editId: entry.id })
    expect(retrying.state).toBe('uploading')
    vi.advanceTimersByTime(1000)
    expect(seen.map((e) => e.state)).toEqual(['uploading', 'editing'])

    await ofs.invoke('sftp:editStop', { editId: entry.id })
    await expect(ofs.invoke('sftp:editRetry', { editId: entry.id })).rejects.toThrow(/已结束/)
  })

  it('editStop 发一条 closed 就收尾，在飞的定时器不许让这行复活', async () => {
    const entry = await open('/home/test/run.sh')
    await ofs.invoke('sftp:editStop', { editId: entry.id })
    // 此刻 editOpen 那条 400ms 的 editing 定时器还在飞
    vi.advanceTimersByTime(5000)
    expect(seen.map((e) => e.state)).toEqual(['closed'])
    expect(await ofs.invoke('sftp:editList', { sessionId: 's1' })).toEqual([])
  })

  it('editList 按会话隔离', async () => {
    await open('/home/test/notes.md', 's1')
    await open('/home/test/notes.md', 's2')
    expect(await ofs.invoke('sftp:editList', { sessionId: 's1' })).toHaveLength(1)
    expect(await ofs.invoke('sftp:editList', { sessionId: 's2' })).toHaveLength(1)
    expect(await ofs.invoke('sftp:editList', { sessionId: 's3' })).toEqual([])
  })
})

describe('mock IPC：外部编辑器桩', () => {
  it('pickEditor / clearEditor 走 main 那条路并推一次 settings:changed', async () => {
    const ofs = createMockOfs()
    const pushed: string[] = []
    ofs.on('settings:changed', (s) => pushed.push(s.sftp.externalEditorPath))

    const picked = await ofs.invoke('sftp:pickEditor')
    expect(picked).toMatch(/\.exe$/)
    expect((await ofs.invoke('settings:get')).sftp.externalEditorPath).toBe(picked)

    await ofs.invoke('sftp:clearEditor')
    expect((await ofs.invoke('settings:get')).sftp.externalEditorPath).toBe('')
    // 界面靠这条事件回显（它自己写不进这个字段），桩上必须也发
    expect(pushed).toEqual([picked, ''])
  })

  /**
   * 这里曾经还有一条"settings:set 改不动 externalEditorPath"。它跑的是 createMockOfs()
   * —— 渲染进程为浏览器调试自己重写的一份 IPC 桩，跟 main 侧那段剥离逻辑一个字节都不沾：
   * 把 stripMainOnlyPaths 的调用整个删掉，它依然绿。留着就是假保险。
   * 那两个纯函数（stripMainOnlyPaths / assertUsableEditor）现在由
   * test/unit/settingsGuard.test.ts 直接对着实现测。
   */
})

describe('mock IPC：新建文件桩', () => {
  it('touch 出来的文件进得了 readdir，重名一律报错而不是静默覆盖', async () => {
    const ofs = createMockOfs()
    await ofs.invoke('sftp:touch', { sessionId: 's1', path: '/home/test/fresh.txt' })
    const list = await ofs.invoke('sftp:readdir', { sessionId: 's1', path: '/home/test' })
    expect(list.map((e) => e.name)).toContain('fresh.txt')
    expect(list.find((e) => e.name === 'fresh.txt')?.size).toBe(0)

    await expect(
      ofs.invoke('sftp:touch', { sessionId: 's1', path: '/home/test/fresh.txt' })
    ).rejects.toThrow(/已存在/)
    // 固定目录树里本来就有的条目同样算已存在
    await expect(
      ofs.invoke('sftp:touch', { sessionId: 's1', path: '/home/test/notes.md' })
    ).rejects.toThrow(/已存在/)
  })

  it('新建的文件只出现在它自己的目录里', async () => {
    const ofs = createMockOfs()
    await ofs.invoke('sftp:touch', { sessionId: 's1', path: '/home/test/www/a.txt' })
    const home = await ofs.invoke('sftp:readdir', { sessionId: 's1', path: '/home/test' })
    const www = await ofs.invoke('sftp:readdir', { sessionId: 's1', path: '/home/test/www' })
    expect(home.map((e) => e.name)).not.toContain('a.txt')
    expect(www.map((e) => e.name)).toContain('a.txt')
  })
})
