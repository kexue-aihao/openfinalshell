import { describe, expect, it } from 'vitest'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { blockAfter, channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * 批量上传这一片的护栏。挑的每一处都有同一个特征：**错了不抛异常、编译照过，
 * 只是静默走偏** —— 于是既有的行为测试全绿，坏处要等真机上批量传一次才露出来。
 *
 *  1. 多选对话框：`properties` 里漏了 multiSelections，或者把 openFile 与 openDirectory
 *     一起给出去（Windows/Linux 上只显示目录选择器），"选文件"这个入口就静默失效。
 *  2. `app:pickPath` 的返回类型必须还是单值 —— 有人图省事把老 channel 改成数组，
 *     会顺手改坏另外三个只要单值的调用点。
 *  3. `parentId` 不许出现在 transfer:enqueue 的 zod schema 里。那是"渲染进程伪造不了
 *     分组关系"的**唯一**实现依据（z.object 剥掉未声明键）。
 *  4. `expandUpload` 块内不许出现 acquireTransferSftp。那是把上传展开从 start() 里
 *     搬出来的全部理由；有人"顺手"在里面加一句就退回到"展开被自己的传输饿住"。
 *  5. 合批：谁绕过 publish 直接 emit，或者旧的单条 channel 又活过来，这里就红。
 *  6. 上传入口只有一个汇合点（uploadPaths 只许一个调用点），否则日后新入口会绕过
 *     入队前该做的事（下一步就是冲突裁决挂在那儿）。
 */

const IPC = 'src/shared/ipc.ts'
const APP_IPC = 'src/main/ipc/app.ipc.ts'
const SFTP_IPC = 'src/main/ipc/sftp.ipc.ts'
const TQ = 'src/main/sftp/TransferQueue.ts'
const TW = 'src/main/sftp/TransferWorker.ts'
const PANE = 'src/renderer/src/features/sftp/SftpPane.tsx'
const STORE = 'src/renderer/src/stores/useTransferStore.ts'
const LIST = 'src/renderer/src/features/transfers/TransferList.tsx'
const MOCK = 'src/renderer/src/ipc/mock.ts'

/**
 * 从某个标记切到下一个标记之间的源码。
 *
 * 有些地方不能用 blockAfter：它取标记后**第一个**花括号块，而
 * `const uploadDirFor = (...): { dir: string; name: string | null } => {` 后面第一个
 * `{` 是**返回类型标注**，不是函数体（sftpPackWiring 里也踩过同一个坑）。
 */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  if (a < 0) throw new Error(`源码里找不到 ${from}`)
  const b = src.indexOf(to, a + from.length)
  return src.slice(a, b < 0 ? undefined : b)
}

describe('多选对话框', () => {
  it('app:pickPaths 在 InvokeMap 里（app: 前缀已在白名单，preload 不用改）', () => {
    expect(channelsOf('InvokeMap')).toContain('app:pickPaths')
  })

  const handler = between(stripComments(read(APP_IPC)), "'app:pickPaths'", "'app:openExternal'")

  it('properties 带 multiSelections —— 漏了就静默只回一条路径', () => {
    expect(flat(handler)).toContain("properties: [mode, 'multiSelections']")
  })

  /**
   * electron.d.ts 原话（showOpenDialog 的 properties）：Windows 与 Linux 上打开对话框
   * 不能同时是文件选择器和目录选择器，两个一起给只会显示**目录**选择器。
   * 所以界面上必须是两个入口，各传一个 mode。
   */
  it('不同时给 openFile 与 openDirectory（那样"选文件"会静默变成只能选目录）', () => {
    // 只看 properties 那一处：zod 的 z.enum 里两个值都在是应该的，别把它算进来
    const props = between(flat(handler), 'properties:', ']')
    expect(props).not.toContain('openFile')
    expect(props).not.toContain('openDirectory')
    expect(props).toContain('mode')
  })

  it('app:pickPath 的返回仍是单值（三个调用点都靠这个收窄）', () => {
    const src = stripComments(read(IPC))
    const decl = flat(src.slice(src.indexOf("'app:pickPath'"), src.indexOf("'app:pickPaths'")))
    expect(decl).toContain('result: string | null')
    expect(decl).not.toContain('string[]')
  })

  it('取消返回空数组而不是 null（少一个 null 分支就少一处写错的地方）', () => {
    expect(flat(handler)).toContain('return r.canceled ? [] : r.filePaths')
  })
})

describe('上传入口只有一个汇合点', () => {
  const src = stripComments(read(PANE))

  /**
   * 多出第二个调用点 = 有入口绕过了冲突裁决。
   * 唯一的出口是 proceedUpload —— 无论问不问，都从那里走。
   */
  it('uploadPaths 只有一个调用点，且在 proceedUpload 里', () => {
    expect(src).toContain('const uploadPaths =')
    expect((src.match(/uploadPaths\(/g) ?? []).length).toBe(1)
    expect(flat(blockAfter(src, 'const proceedUpload ='))).toContain('uploadPaths(localPaths, targetDir, action)')
  })

  /** 设置不是 'ask' 时不弹框，但仍然要走同一个出口（否则裁决就有两条路） */
  it('不问的那条路也经 proceedUpload', () => {
    const start = flat(blockAfter(src, 'const startUpload ='))
    expect(start).toContain("settings.sftp.conflictPolicy")
    expect(start).toContain('proceedUpload(localPaths, targetDir')
    expect(start).not.toContain('uploadPaths(')
  })

  it('拖拽与对话框两条路都汇到 startUpload', () => {
    expect(flat(blockAfter(src, 'const handleDrop ='))).toContain('startUpload(paths, targetDir)')
    expect(flat(blockAfter(src, 'const pickAndUpload ='))).toContain('startUpload(paths, targetDir)')
  })

  it('两个入口各传一个 mode，不是同一个对话框两用', () => {
    const pick = flat(blockAfter(src, 'const pickAndUpload ='))
    expect(pick).toContain("mode: kind === 'folder' ? 'openDirectory' : 'openFile'")
  })

  /** 菜单标签与真正的落点必须出自同一个函数，否则"上传到 logs"会落进 cwd */
  it('菜单标签与分发都走 uploadDirFor，而它复用 targetsFor', () => {
    expect(flat(blockAfter(src, 'const contextItems ='))).toContain('uploadDirFor(target)')
    expect(flat(blockAfter(src, 'const onContextClick ='))).toContain('uploadDirFor(target).dir')
    expect(flat(between(src, 'const uploadDirFor =', 'const contextItems ='))).toContain(
      'targetsFor(target)'
    )
  })

  /**
   * 空白处右键也要能上传 —— 分发必须排在"没有目标就返回"之前。
   * 在 onContextClick 块内找，别撞上 targetsFor 里那句 `if (!target) return []`。
   */
  it('上传分发排在 if (!target) return 之前', () => {
    const body = blockAfter(src, 'const onContextClick =')
    const at = body.indexOf("key === 'uploadFolder'")
    const bail = body.indexOf('if (!target) return\n')
    expect(at).toBeGreaterThan(0)
    expect(bail).toBeGreaterThan(0)
    expect(at).toBeLessThan(bail)
  })
})

describe('状态事件合批', () => {
  const src = stripComments(read(TQ))

  it('旧的单条 transfer:state 已经不在 EventMap 里（两条 channel 一个事实迟早漂开）', () => {
    const events = channelsOf('EventMap')
    expect(events).toContain('transfer:states')
    expect(events).not.toContain('transfer:state')
  })

  /** 缓 id 而不是缓快照：一个任务在 100ms 内变三次，只该发最后那一份 */
  it('publish 只入缓冲、不直接 emit', () => {
    const publish = blockAfter(src, 'private publish(')
    expect(publish).not.toContain("emit('transfer:")
    expect(flat(publish)).toContain('this.pendingStates.add(task.id)')
  })

  it('两个触发器都在（到时间、或积压够多）', () => {
    const publish = flat(blockAfter(src, 'private publish('))
    expect(publish).toContain('TRANSFER_STATE_FLUSH_MAX')
    expect(publish).toContain('TRANSFER_STATE_FLUSH_MS')
  })

  /**
   * 进度事件不合批，可能抢在该任务首条状态事件前面出去；渲染侧按 id upsert，
   * 认不出的 id 会被静默丢掉。所以进度要先把积压的状态倒出去。
   */
  it('reportProgress 会先 flush 掉该任务待发的状态', () => {
    expect(flat(blockAfter(src, 'private reportProgress('))).toContain(
      'if (this.pendingStates.has(entry.task.id)) this.flushStates()'
    )
  })

  it('渲染侧订阅的是批，且 upsert 一次 setState', () => {
    const store = flat(stripComments(read(STORE)))
    expect(store).toContain("ofs.on('transfer:states'")
    expect(store).not.toContain("ofs.on('transfer:state'")
    expect(store).toContain('function upsertTasks(')
  })

  /**
   * 桩必须真的发出长度 > 1 的批，否则渲染侧那条批量 upsert 的路径在浏览器里
   * 从未被走到 —— 界面看着好好的，真机第一次批量上传才暴露。
   */
  it('mock 的逐条状态一律走 publishTask（保证真的发批）', () => {
    const mock = stripComments(read(MOCK))
    // 单条任务的状态变更只许经 publishTask；直接 emit 的只有量产开关那一处
    const leaf = between(mock, 'function mockLeaf(', 'function mockTransfer(')
    expect(leaf).toContain('publishTask(task)')
    expect(leaf).not.toContain("emit('transfer:states'")
    expect(mock).toContain("'app:pickPaths'")
    expect(mock).toContain('__ofsMockBulk')
  })

  /** 进度事件绝不能碰 tasks 数组，否则所有 useMemo([tasks]) 都被击穿 */
  it('进度事件只改 progress，不改 tasks', () => {
    const store = stripComments(read(STORE))
    const onProgress = store.slice(store.indexOf("ofs.on('transfer:progress'"))
    expect(onProgress).toContain('pendingProgress.set(taskId')
    expect(onProgress).not.toContain('tasks:')
  })

  it('列表不再每次渲染排一遍全表', () => {
    expect(stripComments(read(LIST))).not.toContain('.sort(')
  })
})

describe('上传目录展开', () => {
  const src = stripComments(read(TQ))
  const expand = blockAfter(src, 'private async expandUpload(')

  /**
   * 这一条是把上传展开从 start() 里搬出来的**全部理由**。
   * 展开只读本地 fs，不该占 maxConcurrentPerSession 那两个名额；
   * 有人在这里加一句 acquireTransferSftp，深目录树就又会被自己的传输饿住。
   */
  it('expandUpload 里不许出现 acquireTransferSftp', () => {
    expect(expand).not.toContain('acquireTransferSftp')
  })

  it('空目录用浏览句柄 mkdirp（不建就是静默少一个目录）', () => {
    const body = flat(expand)
    expect(body).toContain('kept.length === 0')
    expect(body).toContain('browseSftpSession()')
    expect(body).toContain('mkdirp(')
  })

  /** stat 会跟随软链接：一条指向祖先的链接就是无限展开 */
  it('用 lstat 且显式判 isSymbolicLink', () => {
    const body = flat(expand)
    expect(body).toContain('fs.lstat(')
    expect(body).toContain('isSymbolicLink()')
    expect(body).not.toContain('fs.stat(')
  })

  it('深度与任务数两道兜底都在（不依赖 isSymbolicLink 对 junction 的行为）', () => {
    const body = flat(expand)
    expect(body).toContain('EXPAND_MAX_DEPTH')
    expect(body).toContain('EXPAND_MAX_TASKS')
  })

  it('未分类的任务不许被 pump 起来（它可能是个目录）', () => {
    expect(flat(blockAfter(src, 'private pump('))).toContain('if (!entry.classified) continue')
  })

  /** 打包分支与展开的既有顺序不许被这次改动打乱（另有专门护栏，这里再钉一次入口） */
  it('expandIfDirectory 只剩下载方向', () => {
    expect(flat(blockAfter(src, 'private async expandIfDirectory('))).toContain(
      "if (task.kind !== 'download') return false"
    )
  })
})

describe('分组与级联', () => {
  const src = stripComments(read(TQ))

  it('parentId 不在 transfer:enqueue 的 zod 里（渲染进程伪造不了分组关系）', () => {
    const ipc = stripComments(read(SFTP_IPC))
    const schema = flat(between(ipc, "'transfer:enqueue'", "'transfer:control'"))
    expect(schema).toContain('.array(') // 确实切到了那张 schema
    expect(schema).not.toContain('parentId')
  })

  it('分组不再一入队完子任务就 done，交给 settleGroup 收尾', () => {
    const start = flat(blockAfter(src, 'private async start('))
    expect(start).toContain('if (await this.expandIfDirectory(entry, sftp)) { this.settleGroup(entry)')
  })

  /** 终态迁移的唯一出口，父分组重算挂在这里而不是散在各调用点 */
  it('setState 在终态时通知父分组', () => {
    expect(flat(blockAfter(src, 'private setState('))).toContain(
      'if (FINAL_STATES.has(state) && entry.parent) this.settleGroup(entry.parent)'
    )
  })

  it('control 级联到子孙，且从叶子往根做', () => {
    const control = flat(blockAfter(src, 'control(taskId: TaskId'))
    expect(control).toContain('this.selfAndDescendants(entry).reverse()')
  })

  /** 分组重来 = 子任务重来。让它再展开一次就是整棵树翻倍 */
  it('分组的 retry 不再走一遍展开', () => {
    const apply = flat(blockAfter(src, 'private applyOp('))
    expect(apply).toContain('if (task.isGroup)')
    expect(apply).toContain('this.settleGroup(entry)')
  })

  it('cancelAll 连 queued/paused 一起砍（留几万条 queued 是错账）', () => {
    const all = flat(blockAfter(src, 'cancelAll():'))
    expect(all).toContain('FINAL_STATES.has(entry.task.state)')
    expect(all).toContain("this.setState(entry, 'canceled')")
  })

  /** 字节汇总必须增量：几万条任务 × 10Hz 的全表扫描会吃掉 main */
  it('进度沿父链增量累加，不是全表扫描', () => {
    const roll = flat(blockAfter(src, 'private rollUpBytes('))
    expect(roll).toContain('for (let p = entry.parent; p; p = p.parent)')
    expect(flat(blockAfter(src, 'private syncRolledBytes('))).toContain('entry.rolledBytes')
  })
})

describe('队列界面', () => {
  const AGG = 'src/renderer/src/features/transfers/aggregate.ts'
  const VR = 'src/renderer/src/features/transfers/VirtualRows.tsx'
  const SIZE_HOOK = 'src/renderer/src/hooks/useElementSize.ts'
  const STATUSBAR = 'src/renderer/src/features/layout/StatusBar.tsx'

  /**
   * 界面缩放（App.tsx 给 documentElement 设了 zoom）会让 rect 与 scrollTop 落在
   * 两个坐标系里，混算的错位随缩放线性放大 —— 这是本片唯一"看着能用、缩放一下就坏"
   * 的地方，而且 100% 缩放下永远测不出来。
   */
  it('窗口化的数学不许碰 getBoundingClientRect', () => {
    // 必须先剥注释：两个文件的注释里都写着"绝不混 getBoundingClientRect"
    expect(stripComments(read(VR))).not.toContain('getBoundingClientRect')
    expect(stripComments(read(SIZE_HOOK))).not.toContain('getBoundingClientRect')
    expect(stripComments(read(SIZE_HOOK))).toContain('clientHeight')
  })

  /** 体积卡口只剩 ~76KB gzip，这条比 check:bundle 报错更早、信息更准 */
  it('没有引入第三方虚拟化库', () => {
    const pkg = read('package.json')
    for (const lib of ['react-window', 'react-virtuoso', 'rc-virtual-list', 'react-virtualized']) {
      expect(read(VR)).not.toContain(lib)
      expect(read(LIST)).not.toContain(lib)
      expect(pkg).not.toContain(`"${lib}"`)
    }
  })

  /**
   * aggregate.ts 只许依赖 @shared（类型 + 纯数据常量），它的测试才能零 mock 跑。
   * 一旦它 import 了 store 或 ipc，测一段算术就得挂一套 IPC mock ——
   * 那是把纯逻辑测试污染成"自己跟自己对"的第一步。
   */
  it('aggregate 只依赖 @shared，不碰 ipc / store / electron / node', () => {
    const src = stripComments(read(AGG))
    const imports = src.match(/from '([^']+)'/g) ?? []
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) {
      expect(spec, spec).toMatch(/from '@shared\//)
    }
  })

  /** 目录任务有 -1 和 0 两个形态，判 !== -1 会把展开后那种算成"0 字节的已知文件" */
  it('字节聚合判的是 size > 0，不是 !== -1', () => {
    // blockAfter 会撞上参数里那个内联对象类型的 `{`，所以按函数区间切
    const acc = flat(between(stripComments(read(AGG)), 'function accumulate(', 'export function selectTransferTotals'))
    expect(acc).toContain('snap.size > 0')
    expect(acc).not.toContain('!== -1')
  })

  /** ETA 公式只许有一份 */
  it('ETA 只在 aggregate 里算一次', () => {
    const hits = [AGG, LIST, STORE, STATUSBAR]
      .map((f) => (stripComments(read(f)).match(/\/ speedBps/g) ?? []).length)
      .reduce((a, b) => a + b, 0)
    expect(hits).toBe(1)
    expect(stripComments(read(AGG))).toContain('/ speedBps')
  })

  /** 分组逻辑只许一份：视图里再长出第二份就会与总计对不上 */
  it('分组只认 parentId，且只在 aggregate 里算', () => {
    expect(stripComments(read(AGG))).toContain('parentId')
    expect(stripComments(read(LIST))).not.toContain('parentId')
  })

  it('StatusBar 与列表读的是同一个 overlay（进度不再写 tasks）', () => {
    expect(stripComments(read(STATUSBAR))).toContain('snapOf(task, progress)')
  })

  /** 同名陷阱：useUiStore 里那个 transferDrawerOpen 是零消费者的死字段 */
  it('传输相关代码不许误接 useUiStore.transferDrawerOpen', () => {
    expect(stripComments(read(LIST))).not.toContain('transferDrawerOpen')
    expect(stripComments(read(STATUSBAR))).not.toContain('transferDrawerOpen')
  })

  it('全部取消走 controlAll，不是循环 control', () => {
    const src = stripComments(read(LIST))
    expect(src).toContain("controlAll('cancel')")
    expect(src).not.toMatch(/\.map\([^)]*control\(/)
  })

  /** 在飞的字节收不回来，这一步必须问 */
  it('全部取消有确认框，全部暂停没有', () => {
    const ask = flat(blockAfter(stripComments(read(LIST)), 'const askCancelAll ='))
    expect(ask).toContain('modal.confirm(')
    expect(ask).toContain('transfer.cancelAllConfirm')
  })

  /** 行高两处定义（CSS 与 JS）必须交叉引用，否则改一边就出缝 */
  it('行高在 CSS 与 JS 两处都有，且都留了交叉引用注释', () => {
    expect(read(LIST)).toContain('TransferList.module.css')
    expect(read('src/renderer/src/features/transfers/TransferList.module.css')).toContain('ROW_H')
  })
})

describe('落地后刷新的看门狗', () => {
  const src = stripComments(read(PANE))
  const body = blockAfter(src, 'const watchTransfers =')

  /** 固定 120 秒在批量上传下必然先到点：刷一次、退订，真正传完那一刻反而不刷 */
  it('换成空转判定 + 绝对上限，不再是一刀切的固定超时', () => {
    expect(src).not.toContain('SETTLE_WATCH_TIMEOUT_MS')
    expect(src).toContain('SETTLE_IDLE_TIMEOUT_MS')
    expect(src).toContain('SETTLE_MAX_WATCH_MS')
    expect(flat(body)).toContain('setInterval(')
  })

  /** 漏了 clearInterval 就是每次上传泄漏一个 5 秒心跳 */
  it('cleanup 里清掉心跳', () => {
    expect(flat(blockAfter(body, 'const cleanup ='))).toContain('clearInterval(timer)')
  })

  /**
   * 指纹必须走 overlay：进度事件不写 tasks，直接读 task.transferred 拿到的是陈旧值，
   * 于是跑十分钟的大文件会在 60 秒后被判成"空转"而提前退订。
   */
  it('活动指纹从进度 overlay 读，不读 task.transferred', () => {
    // blockAfter 会撞上返回类型标注 `{ active: number; bytes: number }`，按区间切
    const fp = flat(between(body, 'const fingerprint =', 'let watched'))
    expect(fp).toContain('snapOf(task, progress).transferred')
    expect(fp).not.toContain('bytes += task.transferred')
  })

  /** 既有那两半判据（本次 id 都露过面 + 会话无活动任务）缺一半都会错，不许简化 */
  it('原来那两半落地判据一个字没动', () => {
    const check = flat(blockAfter(body, 'const check ='))
    expect(check).toContain('seen.size < watched.length || fp.active > 0')
  })
})

describe('冲突裁决', () => {
  const PROBE = 'src/main/sftp/conflictProbe.ts'
  const PLAN = 'src/main/sftp/conflictPlan.ts'
  const MODAL = 'src/renderer/src/features/sftp/UploadConflictModal.tsx'
  const SETTINGS = 'src/renderer/src/features/settings/SettingsModal.tsx'

  it('探测 channel 在 InvokeMap 里，且只收基名', () => {
    expect(channelsOf('InvokeMap')).toContain('transfer:probeConflicts')
    const schema = flat(
      between(stripComments(read(SFTP_IPC)), "'transfer:probeConflicts'", "'transfer:enqueue'")
    )
    // remoteBaseName 挡住 `../`：探测本身只读，但拼错目录会让答案指向别处，
    // 而用户是照着那个答案做覆盖决定的
    expect(schema).toContain('remoteBaseName')
  })

  it('skipExisting 也不在 enqueue 的 zod 里（伪造它能让文件被静默跳过）', () => {
    const schema = flat(between(stripComments(read(SFTP_IPC)), "'transfer:enqueue'", "'transfer:control'"))
    expect(schema).not.toContain('skipExisting')
    // onConflict 是允许渲染进程给的（它就是用户的选择）
    expect(schema).toContain("onConflict: z.enum(['overwrite', 'skip', 'rename'])")
  })

  /** stat 对断链软链会说"不存在"，于是报无冲突、而落地那步的 rename 会失败 */
  it('探测用 lstat 而不是 stat/statSize', () => {
    const src = stripComments(read(PROBE))
    expect(src).toContain('sftpLstat(')
    expect(src).not.toContain('statSize(')
  })

  /** 为回答"这文件在不在"不该付一次 SSH 握手，也不该跟正在跑的传输抢通道 */
  it('探测走浏览句柄，不碰 acquireTransferSftp', () => {
    const src = stripComments(read(PROBE))
    expect(src).toContain('browseSftpSession()')
    expect(src).not.toContain('acquireTransferSftp')
  })

  it('探测有并发上限，且复用既有的 runConcurrently', () => {
    const src = stripComments(read(PROBE))
    expect(src).toContain('runConcurrently(')
    expect(src).toContain('PROBE_CONCURRENCY')
  })

  /** 探测失败绝不能当成"无冲突" —— 那就是静默覆盖 */
  it('探测失败回 probed:false，界面据此提示而不是直接传', () => {
    expect(flat(stripComments(read(PROBE)))).toContain('probed: false')
    const modal = stripComments(read(MODAL))
    expect(modal).toContain('if (!probe.probed)')
    expect(modal).toContain('uploadProbeFailed')
  })

  /**
   * skip 如果只靠 worker 在落地那一刻处置，那份文件会被完整传上去再扔掉 ——
   * 跳过一个 4GB 文件要先花 4GB 流量。
   */
  it('skip 在入队前就落实（不是传完再扔）', () => {
    const src = stripComments(read(PROBE))
    expect(src).toContain('export async function applyConflictPlan(')
    expect(flat(src)).toContain("i.onConflict === 'skip' || i.onConflict === 'rename'")
    expect(flat(stripComments(read(SFTP_IPC)))).toContain('await applyConflictPlan(')
  })

  it('纯函数那一层不碰 SFTP / fs / electron', () => {
    const src = stripComments(read(PLAN))
    for (const bad of ['ssh2', 'node:fs', 'electron', 'SftpManager', 'sftpLowLevel']) {
      expect(src).not.toContain(bad)
    }
  })

  /** 'ask' 兜底成 overwrite 是既有行为，改了会让"拖一个文件进去覆盖"静默失效 */
  it("effectiveAction 把 'ask'/'resume' 兜成 overwrite", () => {
    const fn = flat(between(stripComments(read(PLAN)), 'export function effectiveAction(', 'export interface'))
    expect(fn).toContain("return 'overwrite'")
  })

  it('worker 落地三分支都在，且删目标只在 overwrite 那一支', () => {
    const up = flat(blockAfter(stripComments(read(TW)), 'async function upload('))
    expect(up).toContain('effectiveAction(task.onConflict, getSettings().sftp.conflictPolicy)')
    expect(up).toContain("if (action === 'skip')")
    expect(up).toContain("if (action === 'rename') landed = await freeRemoteName(")
    // 删除目标必须在 else 分支里（在分支外就是无条件覆盖，回到改动前）
    expect(up).toContain('else await removeRemoteQuietly(sftp, remoteFinal)')
  })

  /**
   * 裁决要一路带到 worker，还要被子任务继承 —— 漏了继承，用户对一个目录选的
   * "全部跳过"只作用在目录本身，里面的文件照旧被覆盖，而且没有任何提示。
   */
  it('裁决带到任务上，且目录展开时子任务继承', () => {
    const tq = flat(stripComments(read(TQ)))
    expect(tq).toContain('...(item.onConflict ? { onConflict: item.onConflict } : {})')
    // 两个方向的展开都要传下去
    expect(flat(blockAfter(stripComments(read(TQ)), 'private async expandUpload('))).toContain(
      'onConflict: task.onConflict'
    )
    expect(flat(blockAfter(stripComments(read(TQ)), 'private async expandIfDirectory('))).toContain(
      'onConflict: task.onConflict'
    )
  })

  it('无冲突直通排在"进入询问态"之前（不许被改成总是问一下）', () => {
    const src = stripComments(read(MODAL))
    const direct = src.indexOf('probe.conflicts.length === 0')
    const ask = src.indexOf('setResult(probe)')
    expect(direct).toBeGreaterThan(0)
    expect(ask).toBeGreaterThan(0)
    expect(direct).toBeLessThan(ask)
  })

  /** 一次性裁决绝不能改用户的默认值 */
  it('框里不写设置', () => {
    const src = stripComments(read(MODAL))
    expect(src).not.toContain('patchSettings')
    expect(src).not.toContain("'settings:set'")
  })

  it('三选一各有独立文案，没有一个退化成"确定"', () => {
    for (const dict of [zh, en]) {
      const s = dict.translation.sftp as Record<string, string>
      const common = dict.translation.common as Record<string, string>
      for (const key of ['conflictOverwriteAll', 'conflictSkipAll', 'conflictRenameAll']) {
        expect(s[key]).toBeTruthy()
        expect(s[key]).not.toBe(common.ok)
      }
    }
  })

  /** 不写清楚重命名成什么样，"全部重命名"就是盲选 */
  it('重命名提示里写明了 (2) 这个形状', () => {
    expect((zh.translation.sftp as Record<string, string>).conflictRenameHint).toMatch(/\(2\)/)
    expect((en.translation.sftp as Record<string, string>).conflictRenameHint).toMatch(/\(2\)/)
  })

  /** 这个键此前在渲染进程里零命中 —— 也就是设置项从来没有过界面 */
  it('设置页终于有 conflictPolicy 控件', () => {
    const src = flat(stripComments(read(SETTINGS)))
    expect(src).toContain("t('settings.conflictPolicy')")
    expect(src).toContain('conflictPolicy: v')
  })

  it('终态集合只有 @shared 那一份（以前散在 12 处字面量里）', () => {
    const files = [TQ, STORE, LIST, PANE, 'src/renderer/src/features/transfers/aggregate.ts', MOCK]
    for (const f of files) {
      expect(stripComments(read(f)), f).not.toContain("'done', 'error', 'canceled'")
    }
    expect(stripComments(read('src/shared/constants.ts'))).toContain('TRANSFER_FINAL_STATES')
  })
})

describe('中止时的残留清理', () => {
  const src = stripComments(read(TW))

  /**
   * 中止是 abortIfRequested 在 runWindow **内部**抛的，不接住就会穿过后面那段清理 ——
   * 于是两个方向的 .part/.ofspart 清理长期都是死代码（集成测试当时用
   * `if (state === 'canceled')` 包着断言，一直走 else 分支，看不出来）。
   */
  it('两个方向都接住 TransferAborted，让清理跑得到', () => {
    for (const fn of ['async function upload(', 'async function download(']) {
      const body = flat(blockAfter(src, fn))
      expect(body).toContain('if (!(err instanceof TransferAborted)) throw err')
      expect(body).toContain('aborted = err')
      expect(body).toContain('if (aborted) throw aborted')
    }
  })

  it('取消删残留、暂停留着（续传要用）', () => {
    const up = flat(blockAfter(src, 'async function upload('))
    expect(up).toContain('if (state.canceled) { await removeRemoteQuietly(sftp, remotePart)')
    expect(up).toContain("if (state.paused) throw new TransferAborted('paused')")
  })
})
