import { createServer, Socket, type Server } from 'node:net'
import { hostname } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { app } from 'electron'
import type {
  ImportApplyOptions,
  ImportResult,
  LanSyncDevice,
  LanSyncReceiveState,
  LanSyncSendState
} from '@shared/types'
import { emit } from '../ipc/registry'
import { metaGet, metaSet } from '../store/Database'
import { buildExportEnvelope } from '../services/exportData'
import { applyImport, inspectImportFromText } from '../services/importData'
import { t } from '../services/i18n'
import { scopedLogger } from '../utils/logger'
import {
  FrameReader,
  HANDSHAKE_MAX_FRAME_BYTES,
  MAX_FRAME_BYTES,
  SYNC_PROTO,
  encodeFrame,
  type SyncFrame
} from './protocol'
import { localIPv4s, scanDevices, startResponder } from './discovery'
import {
  channelPass,
  computeTranscript,
  confirmMac,
  createEcdhPair,
  derivePairKey,
  generatePairingCode,
  macEquals
} from './pairing'

const log = scopedLogger('lansync')

/** 握手每一步的帧等待上限（跨洋也够）；payload 传输另设 60s 空闲超时 */
const HANDSHAKE_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 10_000
const IDLE_TIMEOUT_MS = 60_000
/** 接收态空转多久无成功握手就自动关（不留遗忘的开放端口） */
const RECEIVE_IDLE_LIMIT_MS = 10 * 60_000

interface ReceiveSession {
  server: Server
  responder: { close: () => void }
  code: string
  sessionId: string
  ecdh: ReturnType<typeof createEcdhPair>
  salt: Buffer
  /** 当前正在握手/传输的连接（单飞行：第二条连入直接 busy 拒绝） */
  socket: Socket | null
  /** 已 confirm 通过，进入 receiving 之后为 true —— 决定断开时是否烧码 */
  confirmed: boolean
  /** 已解析待用户确认的这份数据（token 来自 inspectImportFromText） */
  incomingToken: string | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

interface SendSession {
  socket: Socket
  cancelled: boolean
  /** 结算 send() 返回的 Promise（executor 内的 done）。cancel/stopAll 用它收尾，避免 IPC 永久挂起 */
  settle?: (err?: Error) => void
}

/**
 * 局域网同步的收发状态机（单例，形态对标 ForwardManager）。
 *
 * 两条独立的会话：接收（常驻监听 + 应答发现）与发送（一次性拨出）。状态经
 * emit('sync:receiveState'/'sync:sendState') 推主窗口 —— 都是低频、面板在主窗口，
 * 不用 broadcast。
 *
 * 安全语义的几处硬约定（护栏盯着）：
 * - 发送恒 encryptAll:true —— 线上绝不出现明文信封；
 * - confirm 之前的异常断开**不烧码**（端口扫描器/半开连接不该逼用户重读码），
 *   confirm 之后的失败才烧码换新；
 * - 单飞行握手：第二条连入回 error{busy} 立即关；
 * - 接收态空转 10 分钟自动停。
 */
class LanSyncManager {
  private receive: ReceiveSession | null = null
  private sendSession: SendSession | null = null
  private receiveState: LanSyncReceiveState = { phase: 'idle' }
  private sendState: LanSyncSendState = { phase: 'idle' }
  /** startReceive 跨 await 的重入闸：守卫 `if (this.receive)` 跨不过 listen 那个让出点 */
  private starting = false

  // ---- 设备标识 ----

  private deviceId(): string {
    let id = metaGet('lansync.deviceId')
    if (!id) {
      id = randomUUID()
      metaSet('lansync.deviceId', id)
    }
    return id
  }

  private deviceName(): string {
    return hostname() || 'unknown'
  }

  // ---- 状态推送 ----

  private setReceive(patch: Partial<LanSyncReceiveState>): void {
    this.receiveState = { ...this.receiveState, ...patch }
    emit('sync:receiveState', this.receiveState)
  }

  private setSend(patch: Partial<LanSyncSendState>): void {
    this.sendState = { ...this.sendState, ...patch }
    emit('sync:sendState', this.sendState)
  }

  receiveStatus(): LanSyncReceiveState {
    return this.receiveState
  }

  // ---- 接收端 ----

  /** 进入接收态。幂等：已在接收态（或正在启动）则原样返回现状（不重开端口、不换码） */
  async startReceive(): Promise<LanSyncReceiveState> {
    // `if (this.receive)` 跨不过下面的 await listen —— 两次快速 invoke 会各建一套 server 泄漏。
    // starting 是同步置位的重入闸，堵住 listen 那个让出窗口。
    if (this.receive || this.starting) return this.receiveState
    this.starting = true
    try {
      const server = createServer((socket) => this.onIncomingConnection(socket))
      await new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') reject(new Error(t('err.net.portInUse', { addr: '0.0.0.0', port: 0 })))
          else if (err.code === 'EACCES') reject(new Error(t('err.net.listenPermission', { addr: '0.0.0.0', port: 0 })))
          else reject(new Error(err.message))
        })
        // 随机端口：发现报文里带回去，也支持手输
        server.listen(0, '0.0.0.0', () => {
          server.removeAllListeners('error')
          server.on('error', (err) => log.warn(`receive server error: ${err.message}`))
          resolve()
        })
      })

      const addr = server.address()
      const tcpPort = typeof addr === 'object' && addr ? addr.port : 0
      const sessionId = randomUUID()
      const responder = startResponder(() => ({
        deviceId: this.deviceId(),
        deviceName: this.deviceName(),
        appVersion: app.getVersion(),
        tcpPort,
        sessionId: this.receive?.sessionId ?? sessionId
      }))

      this.receive = {
        server,
        responder,
        code: generatePairingCode(),
        sessionId,
        ecdh: createEcdhPair(),
        salt: randomBytes(16),
        socket: null,
        confirmed: false,
        incomingToken: null,
        idleTimer: null
      }
      this.armIdleTimer()
      this.receiveState = {
        phase: 'waiting',
        code: this.receive.code,
        tcpPort,
        addresses: localIPv4s()
      }
      emit('sync:receiveState', this.receiveState)
      log.info(`receive mode on: port ${tcpPort}`)
      return this.receiveState
    } finally {
      this.starting = false
    }
  }

  stopReceive(): void {
    if (!this.receive) return
    const r = this.receive
    this.receive = null
    if (r.idleTimer) clearTimeout(r.idleTimer)
    r.responder.close()
    r.socket?.destroy()
    try {
      r.server.close()
    } catch {
      /* ignore */
    }
    this.receiveState = { phase: 'idle' }
    emit('sync:receiveState', this.receiveState)
    log.info('receive mode off')
  }

  /**
   * 接收态生命上限：**只在 startReceive 时武装一次**，不随收到的帧重置 ——
   * 否则攻击者持续发帧就能无限续命这个本该"没人成功配对就自动关"的端口
   * （旧实现把它放在 onReceiveFrame 顶部，每帧重置，被未认证流量续命）。
   * 到点时若正处于传输/等用户确认（receiving/incoming/applying），说明有真事在办，
   * 宽限重排一次而不是把已收数据连窗口一起拆掉。
   */
  private armIdleTimer(): void {
    if (!this.receive) return
    if (this.receive.idleTimer) clearTimeout(this.receive.idleTimer)
    const timer = setTimeout(() => this.onIdleTimeout(), RECEIVE_IDLE_LIMIT_MS)
    timer.unref?.()
    this.receive.idleTimer = timer
  }

  private onIdleTimeout(): void {
    const phase = this.receiveState.phase
    if (phase === 'receiving' || phase === 'incoming' || phase === 'applying') {
      this.armIdleTimer() // 有真事在办，别拆，宽限一轮
      return
    }
    log.info('receive mode idle timeout')
    this.stopReceive()
  }

  /** 换一个配对码 + 新 sessionId + 新 ECDH（confirm 后失败、或用户拒绝后调） */
  private rotateCode(): void {
    if (!this.receive) return
    this.receive.code = generatePairingCode()
    this.receive.sessionId = randomUUID()
    this.receive.ecdh = createEcdhPair()
    this.receive.salt = randomBytes(16)
    this.receive.confirmed = false
    this.receive.incomingToken = null
    this.setReceive({ phase: 'waiting', code: this.receive.code, from: undefined, preview: undefined })
  }

  private onIncomingConnection(socket: Socket): void {
    const r = this.receive
    if (!r) {
      socket.destroy()
      return
    }
    // 单飞行：已有连接在处理，第二条直接 busy 拒绝
    if (r.socket) {
      safeSend(socket, { kind: 'error', code: 'err.sync.busy' })
      socket.destroy()
      return
    }
    r.socket = socket
    this.setReceive({ phase: 'handshake', from: { deviceName: '', address: socket.remoteAddress ?? '' } })

    let senderPubDer: Buffer | null = null
    let transcript: Buffer | null = null
    let pairKey: Buffer | null = null

    // 握手期用小帧上限：未认证对端不能声称一个接近 64MiB 的帧逼我们缓冲。confirm 成功后升
    const reader = new FrameReader(
      (frame) =>
        this.onReceiveFrame(socket, frame, {
          getSenderPub: () => senderPubDer,
          setSenderPub: (b) => (senderPubDer = b),
          getTranscript: () => transcript,
          setTranscript: (b) => (transcript = b),
          getPairKey: () => pairKey,
          setPairKey: (b) => (pairKey = b),
          raiseLimit: () => reader.setMaxBytes(MAX_FRAME_BYTES)
        }),
      HANDSHAKE_MAX_FRAME_BYTES
    )

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS)
    socket.on('timeout', () => {
      safeSend(socket, { kind: 'error', code: 'err.sync.timeout' })
      socket.destroy()
    })
    socket.on('data', (chunk) => {
      try {
        reader.feed(chunk)
      } catch (err) {
        log.warn(`receive frame error: ${(err as Error).message}`)
        socket.destroy() // 帧边界不可信，断连
      }
    })
    socket.on('error', (err) => log.warn(`receive socket error: ${err.message}`))
    socket.on('close', () => this.onReceiveSocketClosed(socket))
  }

  private onReceiveFrame(
    socket: Socket,
    frame: SyncFrame,
    ctx: {
      getSenderPub: () => Buffer | null
      setSenderPub: (b: Buffer) => void
      getTranscript: () => Buffer | null
      setTranscript: (b: Buffer) => void
      getPairKey: () => Buffer | null
      setPairKey: (b: Buffer) => void
      raiseLimit: () => void
    }
  ): void {
    const r = this.receive
    if (!r || r.socket !== socket) return
    // 注意：**不**在这里 armIdleTimer —— 生命上限只在 startReceive 武装一次，
    // 否则未认证对端持续发帧就能给本该自停的端口无限续命（见 armIdleTimer 注释）。

    if (frame.kind === 'hello') {
      // 每连接只处理**首个** hello。重复 hello 直接按协议错误断连 —— 这是防"未认证对端用
      // 重复 hello 触发无上限 scrypt"的关键守卫（senderPub 同步置位，后续 hello 全被拦）。
      if (ctx.getSenderPub()) {
        safeSend(socket, { kind: 'error', code: 'err.sync.protocol' })
        socket.destroy()
        return
      }
      if (frame.proto !== SYNC_PROTO) {
        safeSend(socket, { kind: 'error', code: 'err.sync.protocol' })
        socket.destroy()
        return
      }
      const senderPub = Buffer.from(frame.senderPub, 'base64')
      ctx.setSenderPub(senderPub) // 同步置位：立刻堵死重复 hello，早于 scrypt
      const transcript = computeTranscript(senderPub, r.ecdh.publicDer, r.salt, r.sessionId)
      ctx.setTranscript(transcript)
      // 异步派生（走线程池，不阻塞主线程）；就绪后才回 hello-ack。期间连接换了/断了就丢弃
      derivePairKey({
        ownPrivate: r.ecdh.privateKey,
        peerPublicDer: senderPub,
        code: r.code,
        salt: r.salt,
        transcript
      })
        .then((key) => {
          if (!this.receive || this.receive.socket !== socket) return
          ctx.setPairKey(key)
          this.setReceive({ from: { deviceName: frame.deviceName, address: socket.remoteAddress ?? '' } })
          safeSend(socket, {
            kind: 'hello-ack',
            deviceId: this.deviceId(),
            deviceName: this.deviceName(),
            appVersion: app.getVersion(),
            receiverPub: r.ecdh.publicDer.toString('base64'),
            salt: r.salt.toString('base64'),
            sessionId: r.sessionId
          })
        })
        .catch((err) => {
          log.warn(`derive pair key failed: ${(err as Error).message}`)
          safeSend(socket, { kind: 'error', code: 'err.sync.protocol' })
          socket.destroy()
        })
      return
    }

    if (frame.kind === 'confirm-s') {
      const key = ctx.getPairKey()
      const transcript = ctx.getTranscript()
      if (!key || !transcript) {
        socket.destroy()
        return
      }
      const expected = confirmMac(key, 'sender', transcript)
      if (!macEquals(Buffer.from(frame.mac, 'base64'), expected)) {
        // 码不对：这是一次失败的在线猜测 —— 烧码、告知、断开
        safeSend(socket, { kind: 'error', code: 'err.sync.codeMismatch' })
        socket.destroy()
        this.rotateCode()
        return
      }
      // 互证的另一半，发送端验过才会发 payload
      safeSend(socket, { kind: 'confirm-r', mac: confirmMac(key, 'receiver', transcript).toString('base64') })
      r.confirmed = true
      ctx.raiseLimit() // 认证通过，现在才允许接收接近 64MiB 的 payload 帧
      socket.setTimeout(IDLE_TIMEOUT_MS)
      this.setReceive({ phase: 'receiving' })
      return
    }

    if (frame.kind === 'payload') {
      if (!r.confirmed) {
        socket.destroy()
        return
      }
      const key = ctx.getPairKey()!
      try {
        const preview = inspectImportFromText(frame.envelope, {
          source: this.receiveState.from?.deviceName || (socket.remoteAddress ?? 'lan'),
          passphrase: channelPass(key)
        })
        r.incomingToken = preview.token
        safeSend(socket, { kind: 'received' })
        this.setReceive({ phase: 'incoming', preview })
      } catch (err) {
        log.warn(`inspect incoming failed: ${(err as Error).message}`)
        safeSend(socket, { kind: 'error', code: 'err.sync.protocol' })
        socket.destroy()
        this.rotateCode()
      }
      return
    }

    // 其它帧类型（hello-ack/confirm-r/applied/...）不该由发送端发给接收端
  }

  private onReceiveSocketClosed(socket: Socket): void {
    const r = this.receive
    if (!r || r.socket !== socket) return
    r.socket = null
    // 数据已收齐/正在入库/已完成的这些用户可见终态，不能被发送端断开惊扰 ——
    // 尤其 done：发送端收到 applied 后必然关连接，若这里回滚就把导入结果摘要冲掉了
    // （incoming 等用户点确认，applying 正在写库，done 已完成）。
    const phase = this.receiveState.phase
    if (phase === 'incoming' || phase === 'applying' || phase === 'done') return
    // confirm 之前断开（端口扫描器、半开连接）——不烧码，静静回到 waiting
    // confirm 之后断开（传输中途断线）——码已被这次会话消费，烧掉换新
    if (r.confirmed) this.rotateCode()
    else this.setReceive({ phase: 'waiting', from: undefined })
    r.confirmed = false
  }

  /** 用户在确认框点「导入」。落库 + 回发 applied 帧 */
  async applyIncoming(opts: ImportApplyOptions): Promise<ImportResult> {
    const r = this.receive
    if (!r || r.incomingToken !== opts.token) {
      throw new Error(t('err.data.importSessionExpiredFile'))
    }
    this.setReceive({ phase: 'applying' })
    let result: ImportResult
    try {
      result = await applyImport(opts)
    } catch (err) {
      this.setReceive({ phase: 'incoming' }) // 退回确认态，可重试
      throw err
    }
    // 回执给发送端（socket 可能已断，safeSend 静默吞）
    if (r.socket) {
      safeSend(r.socket, {
        kind: 'applied',
        profiles: result.profiles,
        snippets: result.snippets,
        forwards: result.forwards,
        knownHosts: result.knownHosts,
        secrets: result.secrets,
        skipped: result.skipped
      })
    }
    r.incomingToken = null
    // 消费掉本次会话：confirmed 复位，避免发送端断开后残留 true 让下一条连接跳过 confirm-s
    r.confirmed = false
    this.setReceive({ phase: 'done', result, preview: undefined })
    return result
  }

  /** 用户点「拒绝」。回知发送端并回到等待 */
  dismissIncoming(token: string): void {
    const r = this.receive
    if (!r || r.incomingToken !== token) return
    // 先把 socket 从单飞行槽摘下再收尾：不摘的话新连接会在旧连接 idle 超时前一直吃 busy。
    // 用 end() 而非 destroy()：让 rejected 帧先冲出去
    const s = r.socket
    r.socket = null
    if (s) {
      safeSend(s, { kind: 'rejected' })
      s.end()
    }
    this.rotateCode()
  }

  // ---- 发送端 ----

  scan(): Promise<LanSyncDevice[]> {
    return scanDevices(this.deviceId())
  }

  async send(opts: { target: { host: string; port: number }; code: string; includeSecrets: boolean }): Promise<void> {
    if (this.sendSession) throw new Error(t('err.sync.sendInProgress'))

    const ecdh = createEcdhPair()
    const socket = new Socket()
    this.sendSession = { socket, cancelled: false }
    this.sendState = { phase: 'connecting', peer: { deviceName: '', address: opts.target.host } }
    emit('sync:sendState', this.sendState)
    // 无论怎么结束（成功/失败/对端断开），连接一断就释放发送位，否则下一次 send 会撞
    // sendInProgress。identity 守卫避免与 closeSend() 里主动置空打架
    socket.on('close', () => {
      if (this.sendSession?.socket === socket) this.sendSession = null
    })

    let transcript: Buffer | null = null
    let pairKey: Buffer | null = null

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) {
          this.setSend({ phase: 'error', error: err.message })
          // 同步释放发送位：调用方常在 await 抛出后立刻重试，等 'close' 事件（下一 tick）
          // 才释放就会撞上 sendInProgress。resolve（delivered）路径保留会话等 applied/rejected
          if (this.sendSession?.socket === socket) this.sendSession = null
          reject(err)
        } else {
          resolve()
        }
      }
      // 让 closeSend/cancelSend/stopAll 能结算这个 Promise —— 否则 delivered 之前取消，
      // socket.destroy() 只发 'close' 不发 'error'，done 永不被调用，sync:send 的 IPC 永久挂起
      if (this.sendSession) this.sendSession.settle = done
      const fail = (code: string): void => {
        socket.destroy()
        done(new Error(t(code)))
      }

      socket.setTimeout(CONNECT_TIMEOUT_MS)
      socket.once('timeout', () => fail('err.sync.timeout'))
      socket.on('error', (err) => {
        log.warn(`send socket error: ${err.message}`)
        if (!settled) done(new Error(t('err.sync.connectFailed')))
      })

      const reader = new FrameReader((frame) => {
        if (this.sendSession?.cancelled) return
        this.armSendTimers(socket)

        if (frame.kind === 'hello-ack') {
          // 首个 hello-ack 才处理：transcript 同步置位当"已在处理"标记，重复 hello-ack 忽略
          // （对称防未认证对端用重复 hello-ack 冻结发送端）
          if (transcript) return
          const receiverPub = Buffer.from(frame.receiverPub, 'base64')
          const salt = Buffer.from(frame.salt, 'base64')
          transcript = computeTranscript(ecdh.publicDer, receiverPub, salt, frame.sessionId)
          const tr = transcript
          this.setSend({ phase: 'confirming', peer: { deviceName: frame.deviceName, address: opts.target.host } })
          derivePairKey({ ownPrivate: ecdh.privateKey, peerPublicDer: receiverPub, code: opts.code, salt, transcript: tr })
            .then((key) => {
              if (settled || this.sendSession?.socket !== socket) return
              pairKey = key
              safeSend(socket, { kind: 'confirm-s', mac: confirmMac(key, 'sender', tr).toString('base64') })
            })
            .catch(() => fail('err.sync.protocol'))
          return
        }

        if (frame.kind === 'confirm-r') {
          if (!pairKey || !transcript) return fail('err.sync.protocol')
          const expected = confirmMac(pairKey, 'receiver', transcript)
          if (!macEquals(Buffer.from(frame.mac, 'base64'), expected)) return fail('err.sync.codeMismatch')
          // 互证通过 → 发 payload（标准 v2 信封，seal 口令 = 通道密钥）
          const built = buildExportEnvelope({
            includeSecrets: opts.includeSecrets,
            encryptAll: true,
            passphrase: channelPass(pairKey)
          })
          this.setSend({ phase: 'sending', totalBytes: built.bytes, sentBytes: 0 })
          safeSend(socket, { kind: 'payload', envelope: built.text })
          return
        }

        if (frame.kind === 'received') {
          this.setSend({ phase: 'delivered' })
          // 送达后进入"等对方确认"的长等待：切到 payload 空闲超时（此前每帧都被 armSendTimers
          // 压回 30s，而用户在确认框上读多选/单选很容易超过 30s，30s 会误杀连接、卡在 delivered
          // 收不到 applied）。接收端的用户决策窗口是 RECEIVE_IDLE_LIMIT_MS，这里对齐它
          socket.setTimeout(RECEIVE_IDLE_LIMIT_MS)
          done() // resolve：送达即完成，导入结果随后经 applied/rejected 推回
          return
        }

        if (frame.kind === 'applied') {
          this.setSend({
            phase: 'applied',
            remoteResult: {
              profiles: frame.profiles,
              snippets: frame.snippets,
              forwards: frame.forwards,
              knownHosts: frame.knownHosts,
              secrets: frame.secrets,
              skipped: frame.skipped
            }
          })
          this.closeSend()
          return
        }

        if (frame.kind === 'rejected') {
          this.setSend({ phase: 'rejected' })
          this.closeSend()
          return
        }

        if (frame.kind === 'error') {
          // 对端用 i18n 键报错；本地 t() 渲染（未知键回退 remoteError）
          const msg = safeTranslate(frame.code, frame.params)
          if (!settled) done(new Error(msg))
          else this.setSend({ phase: 'error', error: msg })
          socket.destroy()
        }
      }, MAX_FRAME_BYTES)

      socket.on('data', (chunk) => {
        try {
          reader.feed(chunk)
        } catch (e) {
          log.warn(`send frame error: ${(e as Error).message}`)
          fail('err.sync.protocol')
        }
      })

      socket.connect(opts.target.port, opts.target.host, () => {
        this.armSendTimers(socket)
        safeSend(socket, {
          kind: 'hello',
          magic: 'OFSSYNC1',
          proto: SYNC_PROTO,
          deviceId: this.deviceId(),
          deviceName: this.deviceName(),
          appVersion: app.getVersion(),
          senderPub: ecdh.publicDer.toString('base64')
        })
      })
    })
  }

  private armSendTimers(socket: Socket): void {
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS)
  }

  cancelSend(): void {
    if (!this.sendSession) return
    this.sendSession.cancelled = true
    this.closeSend()
    this.setSend({ phase: 'idle' })
  }

  private closeSend(): void {
    if (!this.sendSession) return
    const s = this.sendSession
    this.sendSession = null
    // 先结算再销毁：destroy() 只发 'close' 不发 'error'，若不在这里调 settle，
    // delivered 之前取消/退出时 send() 的 Promise 永不结算，sync:send 的 IPC 永久挂起。
    // settle=done：已结算过（如 delivered 已 resolve）则内部 settled 守卫使其为 no-op
    s.settle?.()
    try {
      s.socket.destroy()
    } catch {
      /* ignore */
    }
  }

  // ---- 生命周期 ----

  stopAll(): void {
    this.stopReceive()
    this.closeSend()
  }
}

/** 发帧：socket 已坏就静默吞（对端先断是常态，不该炸自己） */
function safeSend(socket: Socket, frame: SyncFrame): void {
  try {
    if (!socket.destroyed) socket.write(encodeFrame(frame))
  } catch {
    /* ignore */
  }
}

/** 渲染对端传来的 i18n 键；不认识的键回退 remoteError（防版本错配） */
function safeTranslate(code: string, params?: Record<string, string | number>): string {
  const msg = t(code, params)
  // t() 对未知键返回键本身；据此回退
  return msg === code ? t('err.sync.remoteError', { code }) : msg
}

export const lanSyncManager = new LanSyncManager()
