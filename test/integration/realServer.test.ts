/**
 * 真实服务器验收测试（默认跳过）。
 *
 * 内置 fixture 是按本客户端的预期实现的，存在循环论证风险；这套用例连真实 OpenSSH，
 * 专门覆盖 fixture 覆盖不到的差异点：真实 longname 格式、真实 /proc 与 df 输出、
 * hostkey 算法协商、sshd 的 MaxSessions、GBK 转码、真实隧道。
 *
 * 凭据只从环境变量读，不写进代码库：
 *   $env:OFS_TEST_HOST='1.2.3.4'; $env:OFS_TEST_PORT='22'
 *   $env:OFS_TEST_USER='root';    $env:OFS_TEST_PASSWORD='...'
 *   npx vitest run test/integration/realServer.test.ts
 *
 * 会在远端 /tmp 下创建并删除一个临时文件，其余操作只读，不改服务器配置。
 */
import { connect } from 'node:net'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ForwardRule, MonitorSnapshot, ProfileDraft } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { patchSettings } from '../../src/main/services/settings'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { readdir, realpath, remove } from '../../src/main/sftp/SftpManager'
import { transferQueue } from '../../src/main/sftp/TransferQueue'
import { monitorManager } from '../../src/main/monitor/MonitorManager'
import { forwardManager } from '../../src/main/forward/ForwardManager'

const HOST = process.env.OFS_TEST_HOST
const PORT = Number(process.env.OFS_TEST_PORT ?? 22)
const USER = process.env.OFS_TEST_USER ?? 'root'
const PASSWORD = process.env.OFS_TEST_PASSWORD
const CHARSET = process.env.OFS_TEST_CHARSET ?? 'utf-8'

/** 未提供凭据时整体跳过，保证 npm test 在任何机器上都能跑 */
const enabled = Boolean(HOST && PASSWORD)
const suite = enabled ? describe : describe.skip

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}
async function waitFor(pred: () => boolean, ms = 25000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

let sessionId = ''
let profileId = ''
let localDir = ''
/** 观测到的服务器信息，测试结束后汇总打印 */
const observed: Record<string, string> = {}

/**
 * 在会话里跑一条命令并取纯净输出。
 * 用裸 `sh` exec 通道（无 PTY → 无提示符、无回显、无括号粘贴转义），
 * 交互式 shell 的输出会混入提示符与 ANSI 序列，不适合当数据源。
 */
async function runCommand(cmd: string, timeoutMs = 20000): Promise<string> {
  const conn = sshManager.get(sessionId)
  const channel = await conn.openMonitorChannel()
  const marker = `__OFS_DONE_${Math.random().toString(36).slice(2)}__`
  let out = ''
  channel.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  channel.write(`${cmd}\necho ${marker}\n`)
  try {
    await waitFor(() => out.includes(marker), timeoutMs, `command: ${cmd}`)
  } finally {
    channel.close()
  }
  return out.slice(0, out.indexOf(marker)).replace(/\r/g, '').trim()
}

/** 取命令输出的最后一行（多数命令只关心这个） */
async function runCommandLine(cmd: string): Promise<string> {
  const out = await runCommand(cmd)
  return out.split('\n').filter((l) => l.trim()).at(-1)?.trim() ?? ''
}

beforeAll(async () => {
  if (!enabled) return
  localDir = mkdtempSync(join(tmpdir(), 'ofs-real-'))
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  patchSettings({
    sftp: {
      downloadDir: localDir,
      maxConcurrentPerSession: 2,
      maxConcurrentGlobal: 4,
      conflictPolicy: 'ask',
      showHiddenFiles: true,
      doubleClickAction: 'download'
    }
  })

  // 自动信任 hostkey，并记录算法与指纹供人工核对
  const trust = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') {
        const payload = p.payload as { keyType: string; fingerprintSha256: string }
        observed.hostkeyType = payload.keyType
        observed.hostkeyFingerprint = payload.fingerprintSha256
        promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
      }
    }
  }, 20)

  const draft: ProfileDraft = {
    name: 'real-server-acceptance',
    groupId: null,
    host: HOST!,
    port: PORT,
    username: USER,
    auth: { method: 'password', password: PASSWORD },
    terminal: { charset: CHARSET, termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 20000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: true,
      compress: false
    }
  }
  const profile = saveProfile(draft)
  profileId = profile.id
  ;({ sessionId } = await sshManager.open(profile.id))
  clearInterval(trust)
}, 60000)

afterAll(async () => {
  if (!enabled) return
  forwardManager.stopAll()
  transferQueue.cancelAll()
  monitorManager.stopAll()
  if (sessionId) sshManager.close(sessionId)
  if (profileId) deleteProfile(profileId)
  console.log('\n===== 真实服务器观测结果 =====')
  for (const [k, v] of Object.entries(observed)) console.log(`${k}: ${v}`)
  console.log('==============================\n')
})

suite('真实服务器：连接与终端', () => {
  it('密码认证成功，记录 hostkey 算法与指纹', () => {
    expect(sessionId).toBeTruthy()
    expect(eventsOf('session:state').at(-1)?.state).toBe('ready')
    // 首次连接必须弹过 hostkey 确认（TOFU 生效）
    expect(observed.hostkeyType).toBeTruthy()
    expect(observed.hostkeyFingerprint).toMatch(/^SHA256:/)
  })

  it('shell 回显中文与 emoji（真实 locale 下）', async () => {
    const out = await runCommand('echo 真机验收-中文-🚀')
    expect(out).toContain('真机验收-中文-🚀')
  })

  it('pty 尺寸与 resize 同步到服务器', async () => {
    const conn = sshManager.get(sessionId)
    const shell = await conn.openShell(120, 40)
    const termId = shell.termId
    const read = (): string =>
      eventsOf('term:data')
        .filter((e) => e.termId === termId)
        .map((e) => Buffer.from(e.data).toString('utf8'))
        .join('')
    shell.write('stty size\n')
    await waitFor(() => /40\s+120/.test(read()), 15000, 'initial stty size')

    shell.resize(100, 30)
    await new Promise((r) => setTimeout(r, 400))
    shell.write('stty size\n')
    await waitFor(() => /30\s+100/.test(read()), 15000, 'resized stty size')
    shell.close()
  })

  it('记录服务器基本信息', async () => {
    observed.uname = await runCommandLine('uname -srmo')
    observed.sshdVersion = await runCommandLine('ssh -V 2>&1 | head -1')
    observed.defaultShell = await runCommandLine('getent passwd "$(id -un)" | cut -d: -f7')
    observed.locale = await runCommandLine('locale 2>/dev/null | grep ^LANG= || echo LANG=unset')
    expect(observed.uname).toMatch(/^Linux/)
  })
})

suite('真实服务器：SFTP', () => {
  it('readdir 解析真实 longname 的属主与权限', async () => {
    const home = await realpath(sessionId, '.')
    observed.home = home
    const entries = await readdir(sessionId, '/etc')
    expect(entries.length).toBeGreaterThan(10)

    // longname 解析：真实 sftp-server 的格式必须能取出属主
    const withOwner = entries.filter((e) => e.owner && e.owner !== '')
    expect(withOwner.length).toBeGreaterThan(0)
    observed.sftpOwnerSample = `${withOwner[0].name} → owner=${withOwner[0].owner} group=${withOwner[0].group}`

    // 权限串格式必须是 10 位
    for (const e of entries.slice(0, 20)) {
      expect(e.modeStr).toMatch(/^[-dlbcps][rwxsStT-]{9}$/)
    }
    // 目录识别
    expect(entries.some((e) => e.type === 'dir')).toBe(true)
    // 至少有一个常见文件
    expect(entries.some((e) => e.name === 'hostname' || e.name === 'passwd')).toBe(true)
  })

  it('符号链接被识别并解析目标类型', async () => {
    const entries = await readdir(sessionId, '/etc')
    const links = entries.filter((e) => e.type === 'symlink')
    observed.sftpSymlinks = String(links.length)
    for (const link of links.slice(0, 5)) {
      // follow stat 后应给出目标类型（断链为 other）
      expect(link.targetType).toBeTruthy()
    }
  })

  it('上传后下载往返，内容与大小一致，无 .part 残留', async () => {
    const payload = Buffer.alloc(512 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const localSrc = join(localDir, 'acceptance-upload.bin')
    const localBack = join(localDir, 'acceptance-download.bin')
    const remotePath = `/tmp/ofs-acceptance-${Date.now()}.bin`
    await fs.writeFile(localSrc, payload)

    const [upId] = transferQueue.enqueue([
      { sessionId, kind: 'upload', localPath: localSrc, remotePath }
    ])
    await waitFor(
      () => ['done', 'error'].includes(transferQueue.list().find((t) => t.id === upId)?.state ?? ''),
      60000,
      'upload finished'
    )
    const up = transferQueue.list().find((t) => t.id === upId)!
    expect(up.error ?? '').toBe('')
    expect(up.state).toBe('done')

    const [downId] = transferQueue.enqueue([
      { sessionId, kind: 'download', localPath: localBack, remotePath }
    ])
    await waitFor(
      () => ['done', 'error'].includes(transferQueue.list().find((t) => t.id === downId)?.state ?? ''),
      60000,
      'download finished'
    )
    const down = transferQueue.list().find((t) => t.id === downId)!
    expect(down.state).toBe('done')

    const back = await fs.readFile(localBack)
    expect(back.length).toBe(payload.length)
    expect(back.equals(payload)).toBe(true)

    // 上传文件不能是全局可写（SFTP open 不给 mode 时服务器会建出 0666）
    const uploaded = (await readdir(sessionId, '/tmp')).find((e) => e.path === remotePath)
    expect(uploaded).toBeTruthy()
    observed.uploadedMode = `${uploaded!.modeStr} (${(uploaded!.mode & 0o777).toString(8)})`
    expect(uploaded!.mode & 0o002).toBe(0) // 其他用户不可写

    // 传输速率仅作观测，不做断言
    observed.transferSpeed = `${(512 / 1024).toFixed(2)}MB 往返完成`

    await remove(sessionId, remotePath, false)
    const tmpList = await readdir(sessionId, '/tmp')
    expect(tmpList.some((e) => e.path === remotePath)).toBe(false)
    expect(tmpList.some((e) => e.name.endsWith('.ofspart'))).toBe(false)
  }, 180000)
})

suite('真实服务器：监控采集', () => {
  it('静态信息与真实系统一致', async () => {
    const info = await monitorManager.start(sessionId, 2000)
    expect(info).not.toBeNull()
    observed.monitorDistro = info!.distro
    observed.monitorKernel = `${info!.kernel} (${info!.arch})`
    observed.monitorCores = String(info!.cpuCores)
    observed.monitorIps = info!.ips.join(', ')

    const nproc = await runCommandLine('nproc')
    expect(info!.cpuCores).toBe(Number(nproc))

    const hostname = await runCommandLine('hostname')
    expect(info!.hostname).toBe(hostname)
  }, 60000)

  it('快照数值与 free/df 独立读数吻合', async () => {
    await waitFor(() => eventsOf('monitor:data').length >= 2, 30000, 'two snapshots')
    const snap = eventsOf('monitor:data').at(-1)!.snapshot as MonitorSnapshot

    // 内存总量对照 /proc/meminfo
    const memTotalLine = await runCommandLine('grep MemTotal /proc/meminfo')
    const memTotalKb = Number(/MemTotal:\s+(\d+)/.exec(memTotalLine)?.[1] ?? 0)
    expect(memTotalKb).toBeGreaterThan(0)
    expect(snap.mem.totalKb).toBe(memTotalKb)
    observed.monitorMem = `${(snap.mem.usedKb / 1024 / 1024).toFixed(2)}GB / ${(memTotalKb / 1024 / 1024).toFixed(2)}GB`

    // CPU 使用率必须在合理区间
    expect(snap.cpu.usagePct).toBeGreaterThanOrEqual(0)
    expect(snap.cpu.usagePct).toBeLessThanOrEqual(100)
    expect(snap.cpu.perCore.length).toBe(Number(observed.monitorCores))
    observed.monitorCpu = `${snap.cpu.usagePct}% (load ${snap.cpu.loadAvg.join('/')})`

    // 网卡：至少解析出一个非 lo 网卡
    expect(snap.net.length).toBeGreaterThan(0)
    observed.monitorNet = snap.net.map((n) => n.iface).join(', ')

    // df：等到带磁盘容量的那一帧
    await waitFor(
      () => eventsOf('monitor:data').some((e) => e.snapshot.diskFs !== null),
      40000,
      'snapshot with df'
    )
    const withDf = eventsOf('monitor:data').find((e) => e.snapshot.diskFs !== null)!.snapshot
    expect(withDf.diskFs!.length).toBeGreaterThan(0)
    const rootFs = withDf.diskFs!.find((f) => f.mount === '/')
    expect(rootFs).toBeTruthy()
    observed.monitorDisk = withDf
      .diskFs!.map((f) => `${f.mount} ${f.usePct}%`)
      .join(', ')

    // 与 df -kP 独立读数对照根分区容量（容量恒定，允许 2% 误差以防解析到别的行）
    const dfOut = await runCommandLine('df -kP / | tail -1')
    const dfTotal = Number(dfOut.split(/\s+/)[1])
    if (Number.isFinite(dfTotal) && dfTotal > 0) {
      expect(Math.abs(rootFs!.totalKb - dfTotal) / dfTotal).toBeLessThan(0.02)
    }

    // 磁盘 IO 与进程 Top 属 best-effort，仅观测
    observed.monitorDiskIo = snap.diskIo.map((d) => d.dev).join(', ') || '(none)'
    observed.monitorTopProc = withDf.topProcs?.[0]
      ? `${withDf.topProcs[0].name} ${withDf.topProcs[0].cpuPct}%`
      : '(none)'
  }, 120000)
})

suite('真实服务器：端口转发', () => {
  /** 连本地端口读取 SSH banner —— 隧道打通的证据 */
  function readBanner(port: number, preamble?: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        if (preamble) socket.write(preamble)
      })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`banner timeout on ${port}`))
      }, 15000)
      let buf = Buffer.alloc(0)
      let socksPhase = preamble ? 'greeting' : 'done'
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (socksPhase === 'greeting') {
          if (buf.length < 2) return
          buf = buf.subarray(2)
          socksPhase = 'reply'
        }
        if (socksPhase === 'reply') {
          if (buf.length < 10) return
          if (buf[1] !== 0x00) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error(`socks connect rejected rep=${buf[1]}`))
            return
          }
          buf = buf.subarray(10)
          socksPhase = 'done'
        }
        if (socksPhase === 'done' && buf.includes(0x0a)) {
          clearTimeout(timer)
          const text = buf.toString('utf8')
          socket.destroy()
          resolve(text)
        }
      })
      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  const rule = (o: Partial<ForwardRule>): ForwardRule => ({
    id: crypto.randomUUID(),
    profileId,
    type: 'local',
    label: 'acceptance',
    bindAddr: '127.0.0.1',
    bindPort: 24101,
    autoStart: false,
    ...o
  })

  it('本地转发 -L：隧道到服务器自己的 sshd，读到 SSH banner', async () => {
    const r = rule({ type: 'local', bindPort: 24101, dstHost: '127.0.0.1', dstPort: PORT })
    await forwardManager.start(r, sessionId)
    expect(forwardManager.runtimeOf(r.id)?.state).toBe('active')
    const banner = await readBanner(24101)
    expect(banner).toMatch(/^SSH-2\.0-/)
    observed.serverSshBanner = banner.trim().split('\n')[0]
    forwardManager.stop(r.id)
  }, 60000)

  it('动态转发 SOCKS5：经代理连到 sshd，读到 banner', async () => {
    const r = rule({ type: 'dynamic', bindPort: 24102 })
    await forwardManager.start(r, sessionId)
    const preamble = Buffer.from([
      0x05, 0x01, 0x00,
      0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, (PORT >> 8) & 0xff, PORT & 0xff
    ])
    const banner = await readBanner(24102, preamble)
    expect(banner).toMatch(/^SSH-2\.0-/)
    forwardManager.stop(r.id)
  }, 60000)

  it('远程转发 -R：服务器侧监听回连本地（需 bash 的 /dev/tcp）', async () => {
    const localPort = 24103
    const remotePort = 24104
    // 本地起一个应答服务
    const { createServer } = await import('node:net')
    const echo = createServer((socket) => socket.end('OFS-REVERSE-OK\n'))
    await new Promise<void>((resolve) => echo.listen(localPort, '127.0.0.1', resolve))

    const r = rule({
      type: 'remote',
      bindAddr: '127.0.0.1',
      bindPort: remotePort,
      dstHost: '127.0.0.1',
      dstPort: localPort
    })
    try {
      await forwardManager.start(r, sessionId)
      expect(forwardManager.runtimeOf(r.id)?.state).toBe('active')
      const out = await runCommand(
        `exec 3<>/dev/tcp/127.0.0.1/${remotePort} 2>/dev/null && head -1 <&3 || echo NO_DEV_TCP`
      )
      if (out.includes('NO_DEV_TCP')) {
        observed.remoteForward = '跳过（服务器 shell 无 /dev/tcp 支持）'
      } else {
        expect(out).toContain('OFS-REVERSE-OK')
        observed.remoteForward = '通'
      }
    } catch (err) {
      // 远端可能禁止端口转发（AllowTcpForwarding no），记录而不失败整轮
      observed.remoteForward = `失败：${err instanceof Error ? err.message : String(err)}`
      throw err
    } finally {
      forwardManager.stop(r.id)
      echo.close()
    }
  }, 90000)
})

suite('真实服务器：通道预算', () => {
  it('探测可并发的 shell 通道数（sshd MaxSessions）', async () => {
    const conn = sshManager.get(sessionId)
    const opened: Array<{ close: () => void }> = []
    let failure = ''
    try {
      for (let i = 0; i < 12; i++) {
        try {
          opened.push(await conn.openShell(80, 24))
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err)
          break
        }
      }
      observed.maxConcurrentShells = `${opened.length}${failure ? `（第 ${opened.length + 1} 个失败：${failure.slice(0, 60)}）` : '（未触及上限）'}`
      // 至少要能开出监控+SFTP+若干终端所需的通道
      expect(opened.length).toBeGreaterThanOrEqual(3)
    } finally {
      for (const shell of opened) shell.close()
    }
  }, 90000)
})
