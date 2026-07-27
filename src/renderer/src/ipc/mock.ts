import { MAIN_ONLY_SETTINGS_PATHS, type EventMap, type OfsApi } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type {
  ConnectionGroup,
  ConnectionProfile,
  ForwardRule,
  ForwardRuntime,
  ProfileDraft,
  RemoteEditEntry,
  SftpEntry,
  Snippet,
  SnippetGroup,
  TransferEnqueueItem,
  TransferTask
} from '@shared/types'

/**
 * DEV-only：在普通浏览器里打开 renderer（无 preload）时的 mock IPC。
 * 提供一个自回显的假终端，用于在没有 Electron 的情况下调试 UI 与终端渲染。
 * 生产构建下 window.ofs 恒存在，不会走到这里。
 */
export function createMockOfs(): OfsApi {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const profiles: ConnectionProfile[] = []
  const groups: ConnectionGroup[] = []
  // 与 main/store/snippets.ts 的默认值保持一致，便于纯 UI 调试
  const snippetGroups: SnippetGroup[] = [{ id: 'default', name: '常用', order: 0 }]
  const snippets: Snippet[] = [
    { id: 's1', groupId: 'default', name: '磁盘占用', command: 'df -h', autoEnter: true, order: 0 },
    { id: 's2', groupId: 'default', name: '内存', command: 'free -h', autoEnter: true, order: 1 },
    {
      id: 's3',
      groupId: 'default',
      name: '占用最高的进程',
      command: 'ps aux --sort=-%cpu | head -n 11',
      autoEnter: true,
      order: 2
    },
    { id: 's4', groupId: 'default', name: '监听端口', command: 'ss -tulnp', autoEnter: true, order: 3 }
  ]
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const encoder = new TextEncoder()

  const emit = <K extends keyof EventMap>(channel: K, payload: EventMap[K]): void => {
    for (const fn of listeners.get(channel) ?? []) fn(payload)
  }
  const writeTerm = (termId: string, text: string): void =>
    emit('term:data', { termId, data: encoder.encode(text) })

  const toProfile = (draft: ProfileDraft): ConnectionProfile => ({
    id: draft.id ?? crypto.randomUUID(),
    name: draft.name,
    groupId: draft.groupId,
    color: draft.color,
    host: draft.host,
    port: draft.port,
    username: draft.username,
    auth: {
      method: draft.auth.method,
      passwordRef: draft.auth.password ? 'mock-ref' : undefined,
      privateKeyPath: draft.auth.privateKeyPath
    },
    terminal: draft.terminal,
    options: draft.options,
    note: draft.note,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  /** sessionId → 该会话的 profile 描述，用于假终端提示符 */
  const sessions = new Map<string, { label: string }>()
  const terms = new Map<string, { sessionId: string; line: string }>()

  // --- 假 SFTP 目录树（mockDirs/mockFiles 只装运行时新建的，避免与固定列表重复） ---
  const mockDirs = new Set<string>()
  const mockFiles = new Set<string>()
  const mockRenames = new Map<string, string>()
  const mockDeleted = new Set<string>()
  const mockTasks: TransferTask[] = []

  const mockFile = (
    dir: string,
    name: string,
    size: number,
    mode = 0o644,
    type: SftpEntry['type'] = 'file'
  ): SftpEntry => ({
    name,
    path: dir === '/' ? `/${name}` : `${dir}/${name}`,
    type,
    size,
    mode,
    modeStr: `${type === 'dir' ? 'd' : '-'}rw-r--r--`,
    owner: 'test',
    group: 'test',
    mtime: 1_750_000_000_000
  })

  function mockReaddir(path: string): SftpEntry[] {
    const dir = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    const list: SftpEntry[] =
      dir === '/home/test'
        ? [
            { ...mockFile(dir, 'logs', 4096, 0o755, 'dir'), modeStr: 'drwxr-xr-x' },
            { ...mockFile(dir, 'www', 4096, 0o755, 'dir'), modeStr: 'drwxr-xr-x' },
            mockFile(dir, '.bashrc', 3771),
            mockFile(dir, 'notes.md', 2048),
            mockFile(dir, 'app.tar.gz', 15_728_640),
            mockFile(dir, 'server.log', 1_048_576),
            { ...mockFile(dir, 'run.sh', 512, 0o755), modeStr: '-rwxr-xr-x' }
          ]
        : dir === '/home/test/logs'
          ? // 条目较多，用于验证虚拟表格（改成 10000 可压测大目录渲染）
            Array.from({ length: 500 }, (_, i) => mockFile(dir, `app-${i + 1}.log`, (i + 1) * 4096))
          : dir === '/home/test/www'
            ? [mockFile(dir, 'index.html', 1024), mockFile(dir, 'style.css', 512)]
            : dir === '/'
              ? [
                  { ...mockFile('/', 'home', 4096, 0o755, 'dir'), modeStr: 'drwxr-xr-x' },
                  { ...mockFile('/', 'etc', 4096, 0o755, 'dir'), modeStr: 'drwxr-xr-x' },
                  { ...mockFile('/', 'var', 4096, 0o755, 'dir'), modeStr: 'drwxr-xr-x' }
                ]
              : []
    /** 只取直接子项：新建的路径是全路径，深层的不该出现在本目录列表里 */
    const directChildren = (all: Set<string>): string[] =>
      [...all].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
    const extras = directChildren(mockDirs).map((d) => ({
      ...mockFile(dir, d.slice(dir.length + 1), 4096, 0o755, 'dir' as const),
      modeStr: 'drwxr-xr-x'
    }))
    // touch 出来的空文件也要露脸，否则「新建 > 文件」在浏览器里点了跟没点一样
    const newFiles = directChildren(mockFiles).map((f) => mockFile(dir, f.slice(dir.length + 1), 0))
    return [...list, ...extras, ...newFiles]
      .filter((e) => !mockDeleted.has(e.path))
      .map((e) => {
        const renamed = mockRenames.get(e.path)
        return renamed ? { ...e, name: renamed.split('/').pop()!, path: renamed } : e
      })
  }

  /**
   * 假远端编辑：内存里假装每一步都成功，够界面把 downloading→editing→uploading→editing
   * 这条状态链跑通。真实现里这些状态之间是 SFTP 往返 + 本地文件监视，
   * 这里全用 setTimeout 兑现 —— 否则浏览器调试模式下永远只看得到终态，
   * 骨架屏/进度提示这类只在中间态出现的 UI 根本没法验。
   */
  const mockEdits = new Map<string, RemoteEditEntry>()

  const emitEdit = (e: RemoteEditEntry): void => {
    const halted = e.state === 'conflict' || e.state === 'blocked' || e.state === 'error'
    emit('sftp:editState', {
      editId: e.id,
      sessionId: e.sessionId,
      remotePath: e.remotePath,
      state: e.state,
      error: halted ? e.message : undefined,
      warning: halted ? undefined : e.message,
      eolWarning: e.eolWarning
    })
  }

  /** 只有还在册的编辑才许改状态：停止编辑之后那些在飞的 setTimeout 不该让一行凭空复活 */
  const laterEdit = (id: string, ms: number, mutate: (e: RemoteEditEntry) => void): void => {
    setTimeout(() => {
      const e = mockEdits.get(id)
      if (!e) return
      mutate(e)
      emitEdit(e)
    }, ms)
  }

  // --- 假端口转发 ---
  const mockForwards: ForwardRule[] = []
  const mockForwardRuntimes = new Map<string, ForwardRuntime>()

  // --- 假监控：周期推送带随机波动的快照 ---
  const monitorTimers = new Map<string, ReturnType<typeof setInterval>>()

  function startMockMonitor(sessionId: string): void {
    if (monitorTimers.has(sessionId)) return
    let tick = 0
    const push = (): void => {
      tick += 1
      const wave = (base: number, amp: number): number =>
        Math.max(0, Math.min(100, base + Math.sin(tick / 3) * amp + (Math.random() - 0.5) * 6))
      const totalKb = 8039152
      const usedKb = Math.round(totalKb * (wave(48, 8) / 100))
      emit('monitor:data', {
        sessionId,
        snapshot: {
          ts: Date.now(),
          uptimeSec: 123456 + tick * 2,
          cpu: {
            usagePct: Number(wave(42, 22).toFixed(1)),
            perCore: [wave(40, 25), wave(45, 20), wave(35, 28), wave(50, 18)].map(
              (v) => Number(v.toFixed(1))
            ),
            loadAvg: [0.52, 0.31, 0.24]
          },
          mem: {
            totalKb,
            availableKb: totalKb - usedKb,
            usedKb,
            swapTotalKb: 2097148,
            swapUsedKb: 97148
          },
          net: [
            {
              iface: 'eth0',
              rxBps: Math.round(wave(35, 30) * 40000),
              txBps: Math.round(wave(20, 15) * 20000),
              rxTotalBytes: tick * 1_048_576,
              txTotalBytes: tick * 524_288
            }
          ],
          // 每 5 tick 带一次磁盘容量（与真实采集节奏一致）
          diskFs:
            tick % 5 === 1
              ? [
                  { fs: '/dev/sda1', mount: '/', totalKb: 41020640, usedKb: 12594192, usePct: 30.7 },
                  { fs: '/dev/sda2', mount: '/data', totalKb: 98298648, usedKb: 93383712, usePct: 95.0 }
                ]
              : null,
          diskIo: [
            { dev: 'sda', readBps: Math.round(wave(10, 10) * 100000), writeBps: Math.round(wave(6, 6) * 80000) }
          ],
          topProcs:
            tick % 5 === 1
              ? [
                  { pid: 1234, name: 'node', cpuPct: Number(wave(30, 15).toFixed(1)), memPct: 3.1 },
                  { pid: 2345, name: 'nginx', cpuPct: Number(wave(8, 6).toFixed(1)), memPct: 1.5 },
                  { pid: 3456, name: 'sshd', cpuPct: 1.0, memPct: 0.2 }
                ]
              : undefined,
          // conns 每 tick 都有（sockstat 是 O(1)），明细跟 df 同档低频
          conns: {
            socketsUsed: 330 + Math.round(wave(20, 18)),
            tcpInuse: 42 + Math.round(wave(12, 10)),
            tcpOrphan: 0,
            tcpTw: 3 + Math.round(wave(6, 5)),
            udpInuse: 6
          },
          tcpStates:
            tick % 5 === 1
              ? {
                  ESTABLISHED: 31 + Math.round(wave(10, 8)),
                  LISTEN: 9,
                  TIME_WAIT: 3 + Math.round(wave(6, 5)),
                  CLOSE_WAIT: 1
                }
              : undefined
        }
      })
    }
    emit('monitor:state', { sessionId, state: 'running' })
    push()
    monitorTimers.set(sessionId, setInterval(push, 1000))
  }

  /** 模拟传输：分 10 步推进进度 */
  function mockTransfer(item: TransferEnqueueItem): TransferTask {
    const task: TransferTask = {
      id: crypto.randomUUID(),
      sessionId: item.sessionId,
      kind: item.kind,
      localPath: item.localPath,
      remotePath: item.remotePath,
      size: 5 * 1024 * 1024,
      transferred: 0,
      state: 'running',
      speedBps: 1024 * 1024,
      createdAt: Date.now()
    }
    mockTasks.push(task)
    emit('transfer:state', { task: { ...task } })
    let step = 0
    const iv = setInterval(() => {
      step += 1
      task.transferred = Math.min(task.size, Math.round((task.size * step) / 10))
      emit('transfer:progress', {
        taskId: task.id,
        transferred: task.transferred,
        total: task.size,
        speedBps: task.speedBps
      })
      if (step >= 10) {
        clearInterval(iv)
        task.state = 'done'
        task.speedBps = 0
        emit('transfer:state', { task: { ...task } })
      }
    }, 250)
    return task
  }

  const handlers: Record<string, (...args: never[]) => unknown> = {
    'settings:get': () => settings,
    /**
     * 与 main 侧一致：MAIN_ONLY_SETTINGS_PATHS 里的键（现在只有 sftp.externalEditorPath）
     * 从这条 channel 进来一律不生效 —— 它最终会成为 main 侧 spawn 的可执行文件，
     * 只能由 sftp:pickEditor 写。桩上也照做，否则设置页在浏览器里"能改"、
     * 到了 Electron 里静默不生效，这类差异最难查。
     */
    'settings:set': (patch: never) => {
      const next = structuredClone(patch as unknown as Record<string, unknown>)
      for (const path of MAIN_ONLY_SETTINGS_PATHS) {
        const [section, key] = path.split('.')
        const incoming = next[section]
        if (typeof incoming !== 'object' || incoming === null) continue
        // 覆回库里那份值而不是单纯删键：下面是浅合并（Object.assign），
        // 只删键会把这一项整个抹掉，而 main 侧 patchSettings 是深合并 —— 覆回旧值才是同一个结果
        const stored = (settings as unknown as Record<string, Record<string, unknown>>)[section]
        ;(incoming as Record<string, unknown>)[key] = stored?.[key]
      }
      return Object.assign(settings, next)
    },
    'app:getVersions': () => ({ app: '0.1.0-mock', electron: 'browser', node: '-', chrome: '-' }),
    // 浏览器里没有原生对话框，返回假路径让传输流程可走通
    'app:pickPath': (arg: never) => {
      const { mode } = arg as unknown as { mode: string }
      return mode === 'openDirectory' ? 'C:\\Users\\demo\\Downloads' : 'C:\\Users\\demo\\demo-file.bin'
    },
    'app:openExternal': () => undefined,
    'app:openPath': () => undefined,
    'vault:isAvailable': () => false,

    'conn:list': () => ({ profiles, groups }),
    'conn:save': (draft: never) => {
      const p = toProfile(draft as unknown as ProfileDraft)
      const idx = profiles.findIndex((x) => x.id === p.id)
      if (idx >= 0) profiles[idx] = p
      else profiles.push(p)
      return p
    },
    'conn:delete': (id: never) => {
      const idx = profiles.findIndex((x) => x.id === (id as unknown as string))
      if (idx >= 0) profiles.splice(idx, 1)
    },
    'conn:duplicate': (id: never) => {
      const src = profiles.find((x) => x.id === (id as unknown as string))
      if (!src) throw new Error('连接不存在')
      const copy = { ...structuredClone(src), id: crypto.randomUUID(), name: `${src.name} (副本)` }
      profiles.push(copy)
      return copy
    },
    'group:save': (group: never) => {
      const g = group as unknown as ConnectionGroup
      const idx = groups.findIndex((x) => x.id === g.id)
      if (idx >= 0) groups[idx] = g
      else groups.push(g)
    },
    'group:delete': (id: never) => {
      const idx = groups.findIndex((x) => x.id === (id as unknown as string))
      if (idx >= 0) groups.splice(idx, 1)
    },

    // --- 假会话：立刻 ready ---
    'session:open': (profileId: never) => {
      const p = profiles.find((x) => x.id === (profileId as unknown as string))
      if (!p) throw new Error('连接配置不存在')
      const sessionId = crypto.randomUUID()
      sessions.set(sessionId, { label: `${p.username}@${p.host}` })
      setTimeout(() => emit('session:state', { sessionId, state: 'ready' }), 150)
      return { sessionId }
    },
    'session:close': (sessionId: never) => {
      sessions.delete(sessionId as unknown as string)
    },
    'session:reconnect': () => undefined,
    'session:promptReply': () => undefined,

    // --- 假终端：本地回显 + 少量内建命令 ---
    'term:open': (arg: never) => {
      const { sessionId } = arg as unknown as { sessionId: string }
      const termId = crypto.randomUUID()
      terms.set(termId, { sessionId, line: '' })
      const label = sessions.get(sessionId)?.label ?? 'mock'
      setTimeout(() => {
        writeTerm(
          termId,
          `\x1b[36m浏览器调试模式\x1b[0m：这是本地模拟终端，未连接真实服务器。\r\n` +
            `可用命令：\x1b[33mecho\x1b[0m <文本> · \x1b[33mcolors\x1b[0m · \x1b[33mclear\x1b[0m\r\n` +
            `\x1b[32m${label}\x1b[0m:\x1b[34m~\x1b[0m$ `
        )
      }, 60)
      return { termId }
    },
    'term:resize': () => undefined,
    'term:close': (termId: never) => {
      terms.delete(termId as unknown as string)
    },
    'term:exec': (arg: never) => {
      const { termId, command } = arg as unknown as { termId: string; command: string }
      writeTerm(termId, command)
    },

    // --- 假 SFTP：内存目录树，够验证浏览与传输 UI ---
    'sftp:readdir': (arg: never) => {
      const { path } = arg as unknown as { path: string }
      return mockReaddir(path)
    },
    'sftp:realpath': () => '/home/test',
    'sftp:mkdir': (arg: never) => {
      const { path } = arg as unknown as { path: string }
      mockDirs.add(path)
    },
    'sftp:rename': (arg: never) => {
      const { from, to } = arg as unknown as { from: string; to: string }
      mockRenames.set(from, to)
    },
    'sftp:delete': (arg: never) => {
      const { path } = arg as unknown as { path: string }
      mockDeleted.add(path)
    },
    'sftp:chmod': () => undefined,

    /**
     * 快速删除。**刻意不在这里重实现 main 侧的守卫与命令构造** ——
     * 那些的正主是 test/unit/fastDelete.test.ts（纯函数、精确字符串比对）。
     * 这里重写一遍只会得到一个"自己跟自己对"的假绿：以前 externalEditorPath
     * 那条护栏就是这么空转的（渲染进程 mock 里的重实现绿着，main 侧整个删掉照样绿）。
     * 所以 mock 只负责让界面能走完一遍流程，命令原文明确标成占位。
     */
    'sftp:fastDeletePreview': (arg: never) => {
      const { paths } = arg as unknown as { paths: string[] }
      return { command: `rm -rf -- ${paths.join(' ')}   # mock`, count: paths.length, batches: 1 }
    },
    'sftp:fastDelete': (arg: never) => {
      const { paths } = arg as unknown as { paths: string[] }
      for (const p of paths) mockDeleted.add(p)
      return { exitCode: 0, leftover: [], stderr: '' }
    },
    'sftp:touch': (arg: never) => {
      const { path } = arg as unknown as { path: string }
      // 走一遍 mockReaddir 而不是只查 mockFiles：固定目录树里的条目也算已存在
      const parent = path.slice(0, path.lastIndexOf('/')) || '/'
      if (mockReaddir(parent).some((e) => e.path === path)) {
        throw new Error(`同名文件或目录已存在：${path}`)
      }
      mockDeleted.delete(path)
      mockFiles.add(path)
    },

    /**
     * 内置编辑器的只读打开。mock 里回一段**够把语法着色与状态条都验到**的假内容：
     * 有注释、有键值、有中文、有全角空格（那个要被 highlightSpecialChars 标出来）。
     * 编码/行尾/BOM 一律报最常见的组合 —— 这里的目的只是让界面能走完一遍，
     * 真正的解码语义由 test/unit/textCodec.test.ts 覆盖（那才是它该被验的地方）。
     */
    'sftp:fileView': (arg: never) => {
      const { path, charset } = arg as unknown as { path: string; charset?: string }
      const text = [
        '# mock 内容 —— 浏览器 mock 模式下没有真远端',
        `path = ${path}`,
        'listen 443 ssl;',
        'server_name 例子.测试;',
        '# 下一行第二个词前面是一个全角空格，应该被标出来：',
        'key =　value',
        ''
      ].join('\n')
      return {
        requestedPath: path,
        resolvedPath: path,
        text,
        charset: (charset ?? 'utf8') as never,
        eol: 'lf' as const,
        hasBom: false,
        mixedEol: false,
        lossless: true,
        bytes: new TextEncoder().encode(text).length,
        mode: 0o644
      }
    },

    /**
     * 保存。mock 里没有远端可写，所以只回一个 saved 让界面能走完一遍流程。
     *
     * **刻意不模拟三个闸门**（conflict / nonAtomic / shrink）：那三条分支的价值全在
     * "远端真的变过了""这台服务器真的没有 posix-rename"，在 mock 里全靠编，
     * 编出来的绿只会让人以为验过了。它们由 test/unit/fileSave.test.ts 对着内存假服务器覆盖。
     */
    'sftp:fileSave': (arg: never) => {
      const { text, charset, eol, hasBom } = arg as unknown as {
        text: string
        charset: string
        eol: 'lf' | 'crlf'
        hasBom: boolean
      }
      const body = eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text
      // 字节数按 UTF-8 估（mock 里没有 iconv）；charset 只是拿来确认参数真的传到了
      const bytes = new TextEncoder().encode(body).length + (hasBom && charset === 'utf8' ? 3 : 0)
      return { kind: 'saved' as const, bytes, mode: 0o644 }
    },

    'sftp:editOpen': (arg: never) => {
      const { sessionId, path } = arg as unknown as { sessionId: string; path: string }
      // 与 main 侧一致：同一会话同一路径重复打开复用同一条编辑
      const dup = [...mockEdits.values()].find(
        (e) => e.sessionId === sessionId && e.remotePath === path
      )
      if (dup) return dup
      const id = crypto.randomUUID()
      const entry: RemoteEditEntry = {
        id,
        sessionId,
        remotePath: path,
        resolvedPath: path,
        // 形状照着 main 侧派生出来的样子摆（<temp>\ofs-edit-XXXXXX\<16hex>\<basename>）；
        // 浏览器里当然没有这个文件
        localPath: `C:\\Users\\demo\\AppData\\Local\\Temp\\ofs-edit-a1b2c3\\${id.slice(0, 16)}\\${path.split('/').pop() ?? 'file'}`,
        state: 'downloading',
        size: 2048,
        createdAt: Date.now()
      }
      mockEdits.set(id, entry)
      laterEdit(id, 400, (e) => {
        e.state = 'editing'
      })
      return entry
    },
    'sftp:editList': (arg: never) => {
      const { sessionId } = arg as unknown as { sessionId: string }
      return [...mockEdits.values()].filter((e) => e.sessionId === sessionId)
    },
    'sftp:editSave': (arg: never) => {
      const { editId, force } = arg as unknown as { editId: string; force?: boolean }
      // 与 main 侧同样拒缺省 force：这个约束要在浏览器调试时就炸出来，不能留到 Electron 里
      if (force !== true) {
        throw new Error('普通存盘由本地文件监视自动触发；此接口只用于用户确认后的"仍然覆盖"')
      }
      const entry = mockEdits.get(editId)
      if (!entry) throw new Error('该编辑已结束')
      entry.state = 'uploading'
      entry.message = undefined
      emitEdit(entry)
      laterEdit(editId, 500, (e) => {
        e.state = 'editing'
        e.savedAt = Date.now()
      })
      return entry
    },
    /**
     * 重试与"仍然覆盖"是两条不同的路：这条**不需要** force（它保留冲突检测），
     * 桩上照样分成两个 handler，免得界面把两颗按钮接到同一个 channel 上还能跑。
     */
    'sftp:editRetry': (arg: never) => {
      const { editId } = arg as unknown as { editId: string }
      const entry = mockEdits.get(editId)
      if (!entry) throw new Error('该编辑已结束')
      entry.state = 'uploading'
      entry.message = undefined
      emitEdit(entry)
      laterEdit(editId, 500, (e) => {
        e.state = 'editing'
        e.savedAt = Date.now()
      })
      return entry
    },
    'sftp:editStop': (arg: never) => {
      const { editId } = arg as unknown as { editId: string }
      const entry = mockEdits.get(editId)
      if (!entry) return
      mockEdits.delete(editId)
      // 先删再发：closed 是这条编辑的最后一条事件，之后不该再有任何状态
      emitEdit({ ...entry, state: 'closed' })
    },
    /**
     * 外部编辑器：真实现里对话框、校验、落库全在 main 侧，渲染进程只拿回一个字符串 ——
     * 这里也照这个形状来（浏览器里没有原生对话框，给个固定的假 exe）。
     * 桩同样要 emit settings:changed：界面不能靠自己 settings:set 写这个字段
     * （main 侧会把它剥掉），只能等这条事件回来，那条依赖必须在浏览器调试时就成立。
     */
    'sftp:pickEditor': () => {
      const picked = 'C:\\Program Files\\Notepad++\\notepad++.exe'
      settings.sftp.externalEditorPath = picked
      emit('settings:changed', structuredClone(settings))
      return picked
    },
    'sftp:clearEditor': () => {
      settings.sftp.externalEditorPath = ''
      emit('settings:changed', structuredClone(settings))
    },

    'snippet:list': () => ({ groups: snippetGroups, snippets }),
    'snippet:save': (s: never) => {
      const snip = s as unknown as Snippet
      const idx = snippets.findIndex((x) => x.id === snip.id)
      if (idx >= 0) snippets[idx] = snip
      else snippets.push(snip)
    },
    'snippet:delete': (id: never) => {
      const idx = snippets.findIndex((x) => x.id === (id as unknown as string))
      if (idx >= 0) snippets.splice(idx, 1)
    },
    'snippetGroup:save': (g: never) => {
      const grp = g as unknown as SnippetGroup
      const idx = snippetGroups.findIndex((x) => x.id === grp.id)
      if (idx >= 0) snippetGroups[idx] = grp
      else snippetGroups.push(grp)
    },
    'snippetGroup:delete': (id: never) => {
      const idx = snippetGroups.findIndex((x) => x.id === (id as unknown as string))
      if (idx >= 0) snippetGroups.splice(idx, 1)
    },
    'forward:list': (profileId: never) => {
      const pid = profileId as unknown as string | null
      const list = pid === null ? mockForwards : mockForwards.filter((r) => r.profileId === pid)
      return list.map((r) => ({ ...r, runtime: mockForwardRuntimes.get(r.id) }))
    },
    'forward:save': (rule: never) => {
      const r = rule as unknown as ForwardRule
      const idx = mockForwards.findIndex((x) => x.id === r.id)
      if (idx >= 0) mockForwards[idx] = r
      else mockForwards.push(r)
    },
    'forward:delete': (id: never) => {
      const forwardId = id as unknown as string
      const idx = mockForwards.findIndex((x) => x.id === forwardId)
      if (idx >= 0) mockForwards.splice(idx, 1)
      mockForwardRuntimes.delete(forwardId)
    },
    'forward:control': (arg: never) => {
      const { forwardId, op } = arg as unknown as { forwardId: string; op: 'start' | 'stop' }
      const runtime: ForwardRuntime = {
        forwardId,
        state: op === 'start' ? 'active' : 'stopped',
        activeConns: op === 'start' ? 1 : 0,
        totalBytes: op === 'start' ? 4096 : 0
      }
      mockForwardRuntimes.set(forwardId, runtime)
      emit('forward:state', { runtime })
    },
    'transfer:list': () => mockTasks,
    'transfer:enqueue': (items: never) =>
      (items as unknown as TransferEnqueueItem[]).map((item) => mockTransfer(item).id),
    'transfer:control': (arg: never) => {
      const { taskId, op } = arg as unknown as { taskId: string; op: string }
      const task = mockTasks.find((t) => t.id === taskId)
      if (!task) return
      task.state = op === 'cancel' ? 'canceled' : op === 'pause' ? 'paused' : 'running'
      emit('transfer:state', { task: { ...task } })
    },
    'transfer:clearFinished': () => {
      for (let i = mockTasks.length - 1; i >= 0; i--) {
        if (['done', 'error', 'canceled'].includes(mockTasks[i].state)) mockTasks.splice(i, 1)
      }
    },
    'monitor:start': (arg: never) => {
      const { sessionId } = arg as unknown as { sessionId: string }
      startMockMonitor(sessionId)
      return {
        hostname: 'fixture-host',
        kernel: '5.15.0-91-generic',
        arch: 'x86_64',
        distro: 'Ubuntu 22.04.3 LTS',
        cpuCores: 4,
        ips: ['192.168.1.10']
      }
    },
    'monitor:stop': (sessionId: never) => {
      const iv = monitorTimers.get(sessionId as unknown as string)
      if (iv) {
        clearInterval(iv)
        monitorTimers.delete(sessionId as unknown as string)
      }
    },
    'monitor:setInterval': () => undefined
  }

  const handleInput = (termId: string, data: string): void => {
    const term = terms.get(termId)
    if (!term) return
    const prompt = (): void =>
      writeTerm(termId, `\x1b[32m${sessions.get(term.sessionId)?.label ?? 'mock'}\x1b[0m:\x1b[34m~\x1b[0m$ `)

    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        writeTerm(termId, '\r\n')
        const cmd = term.line.trim()
        term.line = ''
        if (cmd === 'clear') {
          writeTerm(termId, '\x1b[2J\x1b[H')
        } else if (cmd === 'colors') {
          let out = ''
          for (let i = 0; i < 8; i++) out += `\x1b[4${i}m  \x1b[0m`
          writeTerm(termId, `${out}\r\n`)
        } else if (cmd.startsWith('echo ')) {
          writeTerm(termId, `${cmd.slice(5)}\r\n`)
        } else if (cmd !== '') {
          writeTerm(termId, `sh: ${cmd}: command not found\r\n`)
        }
        prompt()
      } else if (ch === '\x7f') {
        if (term.line.length > 0) {
          term.line = term.line.slice(0, -1)
          writeTerm(termId, '\b \b')
        }
      } else if (ch === '\x03') {
        writeTerm(termId, '^C\r\n')
        term.line = ''
        prompt()
      } else {
        term.line += ch
        writeTerm(termId, ch)
      }
    }
  }

  return {
    invoke: (channel, ...args) => {
      const h = handlers[channel]
      if (!h) {
        return Promise.reject(
          new Error(`浏览器调试模式不支持 ${channel}（该能力需要 Electron 主进程）`)
        )
      }
      try {
        // 真实 IPC 会对返回值做结构化克隆；这里同样克隆，避免 mock 泄漏内部引用
        const result = h(...(args as never[]))
        return Promise.resolve((result === undefined ? undefined : structuredClone(result)) as never)
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
    },
    send: (channel, payload) => {
      if (channel === 'term:input') {
        const p = payload as { termId: string; data: string }
        handleInput(p.termId, p.data)
      }
    },
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener as (payload: unknown) => void)
      listeners.set(channel, set)
      return () => set.delete(listener as (payload: unknown) => void)
    },
    getPathForFile: (file) => file.name // 浏览器里拿不到真实路径
  }
}
