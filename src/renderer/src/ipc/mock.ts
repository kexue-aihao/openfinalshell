import { MAIN_ONLY_SETTINGS_PATHS, type EventMap, type OfsApi } from '@shared/ipc'
import { DEFAULT_SETTINGS, TRANSFER_FINAL_STATES } from '@shared/constants'
import enUSLocale from '@shared/locales/en-US.json'
import type {
  CommandHistoryEntry,
  ConnectionGroup,
  ConnectionProfile,
  ForwardRule,
  ForwardRuntime,
  ProfileDraft,
  SavedPrivateKey,
  SavedPrivateKeyDraft,
  SavedProxy,
  SavedProxyDraft,
  SftpEntry,
  Snippet,
  SnippetGroup,
  TransferEnqueueItem,
  TransferTask,
  TrustedHostkey
} from '@shared/types'

/**
 * DEV-only：在普通浏览器里打开 renderer（无 preload）时的 mock IPC。
 * 提供一个自回显的假终端，用于在没有 Electron 的情况下调试 UI 与终端渲染。
 * 生产构建下 window.ofs 恒存在，不会走到这里。
 */
export function createMockOfs(): OfsApi {
  const settings = structuredClone(DEFAULT_SETTINGS)
  // 预置几台机器，方便浏览器 mock 下看连接树的位置标记（旗/局域网自动/颜色回退）
  const now = Date.now()
  const mkProfile = (over: Partial<ConnectionProfile>): ConnectionProfile => ({
    id: crypto.randomUUID(),
    name: 'demo',
    groupId: null,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth: { method: 'password', passwordRef: 'mock-ref' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 15000,
      legacyAlgorithms: false,
      autoReconnect: true,
      monitorEnabled: true,
      compress: false
    },
    createdAt: now,
    updatedAt: now,
    ...over
  })
  const profiles: ConnectionProfile[] = [
    mkProfile({ name: 'ByteVirt-JP1', host: 'jp1.example.org', flag: 'JP' }),
    mkProfile({ name: 'ByteVirt-US', host: '155.117.155.225', flag: 'US' }),
    mkProfile({ name: 'NAS', host: '192.168.1.10' }), // 私网 → 自动局域网标记
    mkProfile({ name: '旧配色机', host: '203.0.113.9', color: '#52c41a' }) // 无 flag → 回退颜色点
  ]
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
  /** 假命令历史：预置两条，好让浮层在浏览器里一打开就有东西可看 */
  const mockHistory: CommandHistoryEntry[] = [
    { command: 'systemctl status nginx', lastUsedAt: Date.now() - 60_000, useCount: 3 },
    { command: 'tail -f /var/log/nginx/error.log', lastUsedAt: Date.now() - 120_000, useCount: 1 }
  ]
  /** 假已信任主机：一条 IPv4 + 一条 IPv6，撤销交互在浏览器里可直接调 */
  const mockKnownHosts: TrustedHostkey[] = [
    {
      key: '192.168.1.10:22:ssh-ed25519',
      host: '192.168.1.10',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:mockmockmockmockmockmockmockmockmockmockmoc',
      addedAt: Date.now() - 86_400_000
    },
    {
      key: '::1:2222:rsa-sha2-512',
      host: '::1',
      port: 2222,
      keyType: 'rsa-sha2-512',
      fingerprintSha256: 'SHA256:v6demov6demov6demov6demov6demov6demov6demov',
      addedAt: Date.now() - 3_600_000
    }
  ]
  const mockProxies: SavedProxy[] = [
    {
      id: 'p-clash',
      name: '本机 Clash',
      type: 'socks5',
      host: '127.0.0.1',
      port: 7890,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ]
  const mockKeys: SavedPrivateKey[] = [
    {
      id: 'k-ed25519',
      name: 'id_ed25519',
      path: 'C:\Users\you\.ssh\id_ed25519',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
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
    flag: draft.flag,
    host: draft.host,
    port: draft.port,
    username: draft.username,
    auth: {
      method: draft.auth.method,
      passwordRef: draft.auth.password ? 'mock-ref' : undefined,
      privateKeyId: draft.auth.privateKeyId
    },
    terminal: draft.terminal,
    options: draft.options,
    proxyMode: draft.proxyMode,
    proxyId: draft.proxyId,
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
              : undefined,
          // wave 内部钳在 [0,100]，直接用永远到不了红档（≥200）——乘出去让三档配色
          // （<100 绿 / <200 黄 / 其余红）都能在浏览器里周期性看到
          latencyMs: Math.round(wave(45, 45) * 3)
        }
      })
    }
    emit('monitor:state', { sessionId, state: 'running' })
    push()
    monitorTimers.set(sessionId, setInterval(push, 1000))
  }

  /**
   * 状态变更走合批，与 main 侧同形（缓 id、到点取快照发一批）。
   *
   * 桩**必须真的发出长度 > 1 的批**，否则渲染侧那条批量 upsert 的代码路径在浏览器里
   * 从未被走到过 —— 一次入队 3 个文件在 mock 下也只发 3 条长度 1 的批，
   * 界面看着好好的，真机上第一次批量上传才暴露。
   */
  const pendingStates = new Set<string>()
  let stateFlushTimer: ReturnType<typeof setTimeout> | null = null
  function publishTask(task: TransferTask): void {
    pendingStates.add(task.id)
    stateFlushTimer ??= setTimeout(() => {
      stateFlushTimer = null
      const tasks = [...pendingStates]
        .map((id) => mockTasks.find((t) => t.id === id))
        .filter((t): t is TransferTask => Boolean(t))
        .map((t) => ({ ...t }))
      pendingStates.clear()
      if (tasks.length > 0) emit('transfer:states', { tasks })
    }, 50)
  }

  /** 一条叶子任务：按 size 决定步数，边推进度边跑 */
  function mockLeaf(
    item: TransferEnqueueItem & { parentId?: string },
    size: number,
    steps: number,
    failAt?: number
  ): TransferTask {
    const task: TransferTask = {
      id: crypto.randomUUID(),
      sessionId: item.sessionId,
      kind: item.kind,
      localPath: item.localPath,
      remotePath: item.remotePath,
      size,
      transferred: 0,
      state: 'running',
      speedBps: size > 0 ? Math.max(1, Math.round(size / (steps * 0.25))) : 0,
      createdAt: Date.now(),
      ...(item.parentId ? { parentId: item.parentId } : {})
    }
    mockTasks.push(task)
    publishTask(task)
    if (size === 0 || steps <= 0) {
      task.state = 'done'
      task.speedBps = 0
      publishTask(task)
      return task
    }
    let step = 0
    const iv = setInterval(() => {
      step += 1
      task.transferred = Math.min(size, Math.round((size * step) / steps))
      emit('transfer:progress', {
        taskId: task.id,
        transferred: task.transferred,
        total: size,
        speedBps: task.speedBps
      })
      if (failAt !== undefined && step >= failAt) {
        clearInterval(iv)
        task.state = 'error'
        task.error = '模拟失败：权限不足'
        task.speedBps = 0
        publishTask(task)
        return
      }
      if (step >= steps) {
        clearInterval(iv)
        task.state = 'done'
        task.speedBps = 0
        publishTask(task)
      }
    }, 250)
    return task
  }

  /**
   * 模拟一次入队。
   *
   * **basename 里不含 `.` 的当成目录**，于是浏览器里也能调出真实形态：
   * 父任务 size = -1 → scanning → 展开出若干子任务（带 parentId、大小各异、
   * 其中一条会失败、一条是空文件）→ 父任务等子任务跑完才终态。
   * 没有这一层，分组折叠与总进度在 mock 下根本长不出来（`# mock` 语义，不是真判据）。
   */
  function mockTransfer(item: TransferEnqueueItem): TransferTask {
    const base = item.localPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    if (base.includes('.')) return mockLeaf(item, 5 * 1024 * 1024, 10)

    // # mock 目录：形状照 main（先入队子任务，再让父任务收尾）
    const group: TransferTask = {
      id: crypto.randomUUID(),
      sessionId: item.sessionId,
      kind: item.kind,
      localPath: item.localPath,
      remotePath: item.remotePath,
      size: -1,
      transferred: 0,
      state: 'running',
      phase: 'scanning',
      isGroup: true,
      speedBps: 0,
      createdAt: Date.now()
    }
    mockTasks.push(group)
    publishTask(group)

    setTimeout(() => {
      group.phase = undefined
      group.size = 0
      const kids = [
        { name: 'a.bin', size: 8 * 1024 * 1024, steps: 30 },
        { name: 'b.log', size: 512 * 1024, steps: 4 },
        { name: 'c.txt', size: 0, steps: 0 },
        { name: 'd.tar.gz', size: 3 * 1024 * 1024, steps: 12 },
        { name: 'e.conf', size: 96 * 1024, steps: 4, failAt: 2 },
        { name: 'f.dat', size: 2 * 1024 * 1024, steps: 8 }
      ]
      group.childTotal = kids.length
      for (const kid of kids) {
        const child = mockLeaf(
          {
            sessionId: item.sessionId,
            kind: item.kind,
            localPath: `${item.localPath}/${kid.name}`,
            remotePath: `${item.remotePath}/${kid.name}`,
            parentId: group.id
          },
          kid.size,
          kid.steps,
          kid.failAt
        )
        group.size += child.size
      }
      publishTask(group)

      // 父任务活到最后一个子任务终态为止（与 main 同形）
      const watch = setInterval(() => {
        const kidsNow = mockTasks.filter((t) => t.parentId === group.id)
        const finished = kidsNow.filter((t) => TRANSFER_FINAL_STATES.has(t.state))
        group.childDone = kidsNow.filter((t) => t.state === 'done').length
        group.childFailed = kidsNow.filter((t) => t.state === 'error').length
        group.transferred = kidsNow.reduce((sum, t) => sum + t.transferred, 0)
        if (finished.length < kidsNow.length) {
          publishTask(group)
          return
        }
        clearInterval(watch)
        group.state = (group.childFailed ?? 0) > 0 ? 'error' : 'done'
        if (group.state === 'error') group.error = `${group.childFailed} 个文件失败`
        publishTask(group)
      }, 250)
    }, 400)

    return group
  }

  const handlers: Record<string, (...args: never[]) => unknown> = {
    'settings:get': () => settings,
    /**
     * 与 main 侧一致：MAIN_ONLY_SETTINGS_PATHS 里的键从这条 channel 进来一律不生效。
     * 桩上也照做，否则设置页在浏览器里"能改"、到了 Electron 里静默不生效，
     * 这类差异最难查。
     *
     * ⚠️ 那张表**目前是空的**（唯一那条 sftp.externalEditorPath 随外部编辑器删掉了），
     * 所以这个循环此刻一圈都不转。留着是为了机制别在两处漂开，见那张表的注释。
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
    // 浏览器 mock 里默认当"更新到当前版本"，方便直接预览更新弹窗
    'app:getStartupNotice': () => ({ kind: 'update', fromVersion: '0.11.0', toVersion: '0.12.0' }),
    // 浏览器 mock 没有主进程语言包，任何语言都回 en-US（UI 调试足够）
    'i18n:bundle': () => enUSLocale as unknown as Record<string, unknown>,
    // 浏览器里没有原生对话框，返回假路径让传输流程可走通
    'app:pickPath': (arg: never) => {
      const { mode } = arg as unknown as { mode: string }
      return mode === 'openDirectory' ? 'C:\\Users\\demo\\Downloads' : 'C:\\Users\\demo\\demo-file.bin'
    },
    // 多选：文件回三条（其中一条与 app:pickPath 同名，方便造出"远端已存在"的场景），
    // 文件夹回一条 —— 真机上能不能多选文件夹取决于 shell，别在 mock 里假定它行
    'app:pickPaths': (arg: never) => {
      const { mode } = arg as unknown as { mode: string }
      return mode === 'openDirectory'
        ? ['C:\\Users\\demo\\demo-dir']
        : [
            'C:\\Users\\demo\\demo-file.bin',
            'C:\\Users\\demo\\notes.txt',
            'C:\\Users\\demo\\archive.tar.gz'
          ]
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
    'conn:knownHosts': () => mockKnownHosts.slice(),
    'conn:knownHostsDelete': (key: never) => {
      const idx = mockKnownHosts.findIndex((x) => x.key === (key as unknown as string))
      if (idx >= 0) mockKnownHosts.splice(idx, 1)
    },
    // # mock：浏览器里没有系统远程桌面，装个样子让 UI 流程能走完
    'conn:launchRdp': () => undefined,
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
     * 这里重写一遍只会得到一个"自己跟自己对"的假绿 —— 渲染进程 mock 里的重实现绿着，
     * main 侧整个删掉照样绿。（这不是假想：外部编辑器那条护栏就曾经这么空转过。）
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
     * 独立编辑器窗口的三条通道。浏览器 mock 里没有第二个窗口：
     * openFile 走缺省的"不支持"报错（那正是这条能力在浏览器里的真话）；
     * 但直接打开 `#/editor` 调试编辑器窗口的 UI 时，ready 回一个样例文件 ——
     * 配合下面的 fileView，一打开就是一个成型的编辑器（标签/状态条/着色全活）。
     */
    'editor:ready': () => [
      { sessionId: 's1' as never, path: '/etc/nginx/nginx.conf', origin: 'mock-server' }
    ],
    'editor:closeNow': () => undefined,

    /**
     * 局域网同步：浏览器 mock 里没有真网络。接收回一个"等待中"的假状态（好让面板
     * 把配对码/地址那套 UI 画出来调样式），扫描回两台假设备，发送/应用一律 no-op。
     */
    'sync:receiveStart': () => ({
      phase: 'waiting',
      code: '284917',
      tcpPort: 52133,
      addresses: ['192.168.1.23', '10.8.0.2']
    }),
    'sync:receiveStop': () => undefined,
    'sync:receiveStatus': () => ({ phase: 'idle' }),
    'sync:scan': () => [
      { deviceId: 'dev-2', deviceName: 'MacBook-Pro', appVersion: '0.17.1', address: '192.168.1.31', tcpPort: 52140 },
      { deviceId: 'dev-3', deviceName: 'ThinkPad-X1', appVersion: '0.17.1', address: '192.168.1.44', tcpPort: 52155 }
    ],
    'sync:send': () => undefined,
    'sync:sendCancel': () => undefined,
    'sync:dismiss': () => undefined,

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

    // FinalShell 导入：浏览器里没有文件对话框，给一份固定的扫描结果把两步界面走通
    'app:finalshellScan': () => ({
      token: 'mock-fs-token',
      dir: 'C:\\Users\\me\\AppData\\Local\\finalshell',
      counts: { profiles: 2, groups: 1, invalid: 1, notSsh: 1, lockedPasswords: 2 },
      samples: [
        { name: 'Hytron-HK1', host: '203.0.113.7', port: 50035, username: 'root' },
        { name: '备份机', host: '203.0.113.9', port: 22, username: 'ubuntu' }
      ],
      notes: [
        '2 条连接在 FinalShell 里存了密码。那些密码用 FinalShell 自己的密钥加密，本项目不猜它的密钥，所以不会跟过来 —— 首次连接时输入一次并勾选"记住密码"，即由本机密钥库加密保存。'
      ]
    }),
    'app:finalshellImport': () => ({
      profiles: 2,
      groups: 1,
      skipped: 0,
      invalid: 1,
      secrets: 0,
      notes: ['导入的连接没有密码：FinalShell 的密码用它自己的密钥加密，本项目不猜那个密钥。']
    }),

    // 命令历史：进程内一份，够验"记录 → 去重计数 → 过滤 → 回填 → 清空"整条界面链路
    'history:list': () => [...mockHistory].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
    'history:push': (arg: never) => {
      const { command } = arg as unknown as { command: string }
      const existing = mockHistory.find((e) => e.command === command)
      if (existing) {
        existing.useCount += 1
        existing.lastUsedAt = Date.now()
      } else {
        mockHistory.push({ command, lastUsedAt: Date.now(), useCount: 1 })
      }
    },
    'history:clear': () => {
      mockHistory.length = 0
    },

    // 浏览器调试模式没有 autoUpdater，恒定报"已是最新" —— 免安装那条分支要真产物才验得到
    'update:check': () => ({ status: 'none' as const, capability: 'install' as const, current: '0.1.0-mock' }),
    'update:download': () => {},
    'update:install': () => ({ error: '浏览器调试模式不支持安装更新' }),

    // 已保存的代理与私钥：预置各一条，好让连接抽屉里那两个下拉框在浏览器里就有东西可选
    'proxy:list': () => mockProxies,
    'proxy:save': (draft: never) => {
      const d = draft as unknown as SavedProxyDraft
      const now = Date.now()
      const idx = mockProxies.findIndex((x) => x.id === d.id)
      const saved: SavedProxy = {
        id: d.id ?? crypto.randomUUID(),
        name: d.name,
        type: d.type,
        host: d.host,
        port: d.port,
        username: d.username,
        passwordRef: d.password ? 'mock-proxy-ref' : mockProxies[idx]?.passwordRef,
        createdAt: mockProxies[idx]?.createdAt ?? now,
        updatedAt: now
      }
      if (idx >= 0) mockProxies[idx] = saved
      else mockProxies.push(saved)
      return saved
    },
    'proxy:delete': (id: never) => {
      const target = id as unknown as string
      // 被引用时不删 —— 与 main 侧同一条语义，好让那个"列出被谁引用"的弹框在浏览器里也能验
      const usedBy = profiles.filter((p) => p.proxyId === target).map((p) => p.name)
      if (usedBy.length > 0) return { deleted: false as const, usedBy }
      const idx = mockProxies.findIndex((x) => x.id === target)
      if (idx >= 0) mockProxies.splice(idx, 1)
      return { deleted: true as const }
    },
    'key:list': () => mockKeys,
    'key:save': (draft: never) => {
      const d = draft as unknown as SavedPrivateKeyDraft
      const now = Date.now()
      const idx = mockKeys.findIndex((x) => x.id === d.id)
      const saved: SavedPrivateKey = {
        id: d.id ?? crypto.randomUUID(),
        name: d.name,
        path: d.path,
        passphraseRef: d.passphrase ? 'mock-pass-ref' : mockKeys[idx]?.passphraseRef,
        materialRef: d.storeManagedCopy
          ? 'mock-material-ref'
          : d.clearManagedCopy
            ? undefined
            : mockKeys[idx]?.materialRef,
        sourceFingerprint: mockKeys[idx]?.sourceFingerprint,
        note: d.note,
        createdAt: mockKeys[idx]?.createdAt ?? now,
        updatedAt: now
      }
      if (idx >= 0) mockKeys[idx] = saved
      else mockKeys.push(saved)
      return saved
    },
    'key:delete': (id: never) => {
      const target = id as unknown as string
      const usedBy = profiles.filter((p) => p.auth.privateKeyId === target).map((p) => p.name)
      if (usedBy.length > 0) return { deleted: false as const, usedBy }
      const idx = mockKeys.findIndex((x) => x.id === target)
      if (idx >= 0) mockKeys.splice(idx, 1)
      return { deleted: true as const }
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
    /*
     * # mock：判据故意假到一眼能认出来（名字里带 demo- 就算冲突），**不重实现真判据**。
     * 它只为了让浏览器里"有冲突"与"无冲突"两条路都能走一遍。
     */
    'transfer:probeConflicts': (arg: never) => {
      const { names } = arg as unknown as { names: string[] }
      const hit = names.filter((n) => n.startsWith('demo-'))
      return {
        conflicts: hit.map((name) => ({
          name,
          kind: name.includes('.') ? ('file' as const) : ('dir' as const),
          size: 1234567,
          mtime: 0
        })),
        total: names.length,
        probed: true
      }
    },
    'transfer:list': () => mockTasks,
    'transfer:enqueue': (items: never) =>
      (items as unknown as TransferEnqueueItem[]).map((item) => mockTransfer(item).id),
    'transfer:control': (arg: never) => {
      const { taskId, op } = arg as unknown as { taskId: string; op: string }
      const task = mockTasks.find((t) => t.id === taskId)
      if (!task) return
      task.state = op === 'cancel' ? 'canceled' : op === 'pause' ? 'paused' : 'running'
      publishTask(task)
    },
    'transfer:controlAll': (arg: never) => {
      const { op } = arg as unknown as { op: string }
      let affected = 0
      for (const task of mockTasks) {
        if (TRANSFER_FINAL_STATES.has(task.state)) continue
        task.state = op === 'cancel' ? 'canceled' : op === 'pause' ? 'paused' : 'running'
        publishTask(task)
        affected += 1
      }
      return { affected }
    },
    'transfer:clearFinished': () => {
      for (let i = mockTasks.length - 1; i >= 0; i--) {
        if (TRANSFER_FINAL_STATES.has(mockTasks[i].state)) mockTasks.splice(i, 1)
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

  /**
   * 量产开关：`__ofsMockBulk(2000)` 造 n 条任务（按 50 条一组分成若干分组）。
   *
   * 没有它，"上千行的队列界面会不会卡"在浏览器里根本调不出来 —— 而那正是虚拟化
   * 要解决的问题。只在 mock 模式下挂，产物里不存在（api.ts 有 window.ofs + DEV 双闸门）。
   */
  ;(globalThis as unknown as Record<string, unknown>).__ofsMockBulk = (n = 2000): number => {
    const states: Array<TransferTask['state']> = ['running', 'queued', 'done', 'error', 'paused']
    const groups = Math.ceil(n / 50)
    let made = 0
    for (let g = 0; g < groups; g++) {
      const group: TransferTask = {
        id: crypto.randomUUID(),
        sessionId: 'bulk',
        kind: 'upload',
        localPath: `C:\\bulk\\dir-${g}`,
        remotePath: `/bulk/dir-${g}`,
        size: 0,
        transferred: 0,
        state: 'running',
        isGroup: true,
        speedBps: 0,
        createdAt: Date.now() + g
      }
      mockTasks.push(group)
      const count = Math.min(50, n - made)
      group.childTotal = count
      for (let i = 0; i < count; i++) {
        const size = 1024 * (64 + ((i * 7919) % 4096))
        const state = states[(g + i) % states.length]
        const transferred = state === 'done' ? size : Math.round(size * (((i * 31) % 100) / 100))
        mockTasks.push({
          id: crypto.randomUUID(),
          sessionId: 'bulk',
          kind: 'upload',
          localPath: `C:\\bulk\\dir-${g}\\f${String(i).padStart(3, '0')}.bin`,
          remotePath: `/bulk/dir-${g}/f${String(i).padStart(3, '0')}.bin`,
          size,
          transferred,
          state,
          speedBps: state === 'running' ? 512 * 1024 : 0,
          createdAt: Date.now() + g * 100 + i,
          parentId: group.id
        })
        group.size += size
        group.transferred += transferred
        made += 1
      }
      group.childDone = 0
      emit('transfer:states', { tasks: mockTasks.slice(-count - 1).map((t) => ({ ...t })) })
    }
    // 一条没有父亲的散件：真实队列里两种行都有，而 single 行的行高与分组行不同
    const solo: TransferTask = {
      id: crypto.randomUUID(),
      sessionId: 'bulk',
      kind: 'download',
      localPath: 'C:\\bulk\\solo.iso',
      remotePath: '/bulk/solo.iso',
      size: 700 * 1024 * 1024,
      transferred: 123 * 1024 * 1024,
      state: 'running',
      speedBps: 3 * 1024 * 1024,
      createdAt: Date.now() + groups + 1
    }
    mockTasks.push(solo)
    emit('transfer:states', { tasks: [{ ...solo }] })
    return made
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
