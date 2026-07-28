import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog } from 'electron'
import type {
  ConnectionProfile,
  FinalShellImportOptions,
  FinalShellImportResult,
  FinalShellScan,
  ProfileDraft
} from '@shared/types'
import { listConnections, saveGroup, saveProfile } from '../store/connections'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('fsimport')

/**
 * 从 FinalShell 导入连接。
 *
 * ---
 *
 * ## 密码：**刻意不解**，而且这不是"还没做"
 *
 * FinalShell 的 `password` 字段形如 `bR0Y…o4U=`：base64 解出来是
 * **8 字节随机头 + N×8 字节密文**（DES 块），也就是"每条记录一个随机头 + 对称加密"。
 * 密钥推导里混了客户端内置的常量，而那个常量本项目没有。
 *
 * 试过 22 种不含常量的候选推导（头本身 / md5 / sha1 / 两者拼接 / java.util.Random(头) 派生，
 * 各配 DES-ECB 与 DES-CBC），**全部通不过 PKCS#5 padding 校验**。所以这条路上只有两种做法：
 *
 *  1. 拿一个猜的推导去解，解出垃圾也照样加密入库 —— 用户要等到第一次连接失败才发现，
 *     而那时已经分不清"密码错了"还是"导入错了"。**这条不做。**
 *  2. 承认解不出：连接照常导入，密码留空，首次连接时问一次。用户勾"记住密码"的那一下，
 *     密码就由本机密钥库（safeStorage/DPAPI）加密存下 —— 这正是"导入后加密存储"要的结果。
 *
 * 走的是第 2 条。哪一天拿到可验证的推导，只需要把 `decryptFinalShellPassword` 里那个
 * `deriveKey` 接上：`acceptDecryptedSecret` 那道校验已经在这儿了，**它不会放行垃圾**。
 *
 * ## 加密存储：靠既有的那条唯一入口
 *
 * 本模块**不碰 vault、也不自己写 profiles 表**，一律经 `saveProfile(draft)` ——
 * 明文密码只在 draft 里存在一瞬，`saveProfile` 内部 `vault.putSecret` 加密后只把引用落库。
 * 自己写库就等于绕过那个加密点，而绕过之后代码看着一样能跑。有护栏盯着这件事。
 */

/** 一次扫描最多认多少个文件 —— 选错目录（比如整个用户目录）时不至于把主进程读爆 */
const MAX_FILES = 5000
/** 单个连接配置文件的合理上限 */
const MAX_FILE_BYTES = 1024 * 1024
/** FinalShell 的 SSH 连接类型（它自己把 connection 拼成了 conection） */
const SSH_CONNECTION_TYPE = 100

// ---------------------------------------------------------------------------
// 密码
// ---------------------------------------------------------------------------

/**
 * 密文的结构解析。**只回答"这是不是 FinalShell 那种密文"**，不解密。
 *
 * 有它才能把"这条没有密码"与"这条有密码但我们解不开"分开报给用户 ——
 * 后者意味着他导入之后要重新输入一次，前者不需要，混在一起说等于什么都没说。
 */
export function looksLikeFinalShellSecret(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false
  let buf: Buffer
  try {
    buf = Buffer.from(raw, 'base64')
  } catch {
    return false
  }
  // 8 字节头 + 至少一个 8 字节块，且总长是 8 的整数倍
  if (buf.length < 16 || buf.length % 8 !== 0) return false
  // base64 往返不一致说明这串不是干净的 base64（Buffer.from 会静默丢掉非法字符）
  return buf.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')
}

/**
 * 候选明文的**准入校验**。这是"永远不会把垃圾存进库"那条保证的全部所在。
 *
 * 三条同时成立才收：去掉 PKCS#5 padding 之后是合法 UTF-8、全部可打印、长度合理。
 * 错密钥有 7/8 的概率当场撞在 padding 上，配上可打印判定之后误收概率低到可以忽略。
 *
 * 这个函数**现在就有用**：它与推导无关，是推导那天唯一的守门人，所以现在就测。
 */
export function acceptDecryptedSecret(raw: Buffer): string | null {
  if (raw.length === 0 || raw.length % 8 !== 0) return null
  const pad = raw[raw.length - 1]
  if (pad < 1 || pad > 8 || pad > raw.length) return null
  for (let i = raw.length - pad; i < raw.length; i++) {
    if (raw[i] !== pad) return null
  }
  const body = raw.subarray(0, raw.length - pad)
  if (body.length === 0 || body.length > 256) return null
  const text = body.toString('utf8')
  // 往返不一致 = 原字节不是合法 UTF-8（toString 会插 U+FFFD）
  if (Buffer.from(text, 'utf8').compare(body) !== 0) return null
  // 控制字符一律拒：密码里不会有 U+0000–U+001F / U+007F，而错密钥解出来的字节里遍地都是
  // 逐字符判而不是写一个含控制字符的正则字面量：那个正则里的字节是**真的控制字符**，
  // 它让整个源文件被 git 当成二进制、也没法被普通编辑器/工具安全地改
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return null
  }
  return text
}

/**
 * 解一条 FinalShell 密码。**当前恒返回 null**，理由见文件头。
 *
 * 留着这个函数而不是直接不写，是因为它标出了唯一的接入点：
 * 拿到可验证的密钥推导之后，在这里补 `deriveKey(head)` + DES 解密，
 * 然后**必须**把结果交给 `acceptDecryptedSecret` 过一遍。
 * 别在别处解、别跳过校验 —— 这两条各有一条护栏盯着。
 */
export function decryptFinalShellPassword(_cipherBase64: string): string | null {
  return null
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface FsRecord {
  id: string
  name: string
  parentId: string | null
  host?: string
  port?: number
  username?: string
  charset: string
  note?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  /** 有密码但解不出来 */
  lockedPassword: boolean
  /** FinalShell 里配了代理（proxy_id 指向它自己的代理记录，本项目解析不了） */
  hasProxy: boolean
  /** FinalShell 里用的是密钥认证（secret_key_id 指向它自己的密钥库） */
  usesKey: boolean
  /** 端口转发条数（格式未知，不导入，只报数） */
  forwards: number
  isSsh: boolean
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * 终端编码映射。FinalShell 写的是 `UTF-8` / `GBK` 这种大写带横线的写法，
 * 而本项目的 charset 直接交给 iconv-lite，认的是小写。
 * 认不出来的一律回落 utf-8 并记一条 note —— 静默用一个猜的编码会让整个终端变乱码。
 */
export function mapCharset(raw: unknown): { charset: string; unknown?: string } {
  const v = str(raw)
  if (!v) return { charset: 'utf-8' }
  const normalized = v.toLowerCase().replace(/[\s_]/g, '')
  const table: Record<string, string> = {
    'utf-8': 'utf-8',
    utf8: 'utf-8',
    gbk: 'gbk',
    gb2312: 'gbk',
    gb18030: 'gb18030',
    big5: 'big5',
    'iso-8859-1': 'latin1',
    iso88591: 'latin1',
    latin1: 'latin1'
  }
  const hit = table[normalized] ?? table[v.toLowerCase()]
  return hit ? { charset: hit } : { charset: 'utf-8', unknown: v }
}

/**
 * 解析一条 FinalShell 记录。认不出来返回 null（调用方计入 invalid）。
 *
 * 字段名按真实样本钉死。**没有证据的字段一律不猜**：
 * - `authentication_type` 的枚举含义不明（样本里 2 配着非空 password），所以判据不看它，
 *   而是看"有没有密码字段"和"有没有 secret_key_id"—— 这两个的含义是自明的。
 * - `port_forwarding_list` / `remote_port_forwarding` 的元素结构没有样本，只数条数。
 * - `proxy_id` 指向 FinalShell 自己的代理记录，没有样本，只记"有代理"。
 */
export function parseFinalShellRecord(raw: unknown): FsRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const name = str(r.name)
  if (!id || !name) return null

  const host = str(r.host)
  const port = num(r.port)
  const type = num(r.conection_type) ?? num(r.connection_type)
  // 有主机+端口的才算连接；没有的当分组（FinalShell 的文件夹也是一条记录）
  const isConnection = host !== undefined && port !== undefined
  const forwardList = Array.isArray(r.port_forwarding_list) ? r.port_forwarding_list.length : 0
  const remoteForwards =
    typeof r.remote_port_forwarding === 'object' && r.remote_port_forwarding !== null
      ? Object.keys(r.remote_port_forwarding as Record<string, unknown>).length
      : 0

  return {
    id,
    name,
    parentId: str(r.parent_id) ?? null,
    host,
    port,
    username: str(r.user_name) ?? str(r.userName),
    charset: mapCharset(r.terminal_encoding).charset,
    note: str(r.description),
    createdAt: num(r.create_time) ?? Date.now(),
    updatedAt: num(r.modified_time) ?? Date.now(),
    lastUsedAt: num(r.access_time),
    lockedPassword: looksLikeFinalShellSecret(r.password),
    hasProxy: str(r.proxy_id) !== undefined,
    usesKey: str(r.secret_key_id) !== undefined,
    forwards: forwardList + remoteForwards,
    // 类型缺失时按"是 SSH"处理：老版本可能没这个字段，而有 host/port/user 的记录
    // 绝大多数就是 SSH。误收一条的代价是用户删掉它，误拒一条的代价是他不知道少了什么
    isSsh: isConnection && (type === undefined || type === SSH_CONNECTION_TYPE)
  }
}

export interface ParsedFinalShell {
  connections: FsRecord[]
  groups: FsRecord[]
  invalid: number
  notSsh: number
  unknownCharsets: Set<string>
}

/** 把一堆记录分成"连接"与"分组"，并把不支持的计数 */
export function classifyFinalShellRecords(records: unknown[]): ParsedFinalShell {
  const out: ParsedFinalShell = {
    connections: [],
    groups: [],
    invalid: 0,
    notSsh: 0,
    unknownCharsets: new Set()
  }
  for (const raw of records) {
    const rec = parseFinalShellRecord(raw)
    if (!rec) {
      out.invalid++
      continue
    }
    const charset = mapCharset((raw as Record<string, unknown>).terminal_encoding)
    if (charset.unknown) out.unknownCharsets.add(charset.unknown)

    if (rec.host === undefined || rec.port === undefined) {
      out.groups.push(rec)
      continue
    }
    if (!rec.isSsh) {
      out.notSsh++
      continue
    }
    out.connections.push(rec)
  }
  return out
}

/** 扫描目录里的 JSON。FinalShell 的连接配置在 `conn` 下，选它的根目录也认 */
async function readRecords(dir: string): Promise<{ records: unknown[]; files: number }> {
  const roots = [dir, join(dir, 'conn')]
  const records: unknown[] = []
  let files = 0

  for (const root of roots) {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files >= MAX_FILES) break
      if (!entry.toLowerCase().endsWith('.json')) continue
      const path = join(root, entry)
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
        files++
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
        // 一个文件里可能是一条记录，也可能是一个数组
        if (Array.isArray(parsed)) records.push(...parsed)
        else records.push(parsed)
      } catch {
        // 读不了/不是 JSON 的文件直接跳过：FinalShell 目录里还有别的东西
      }
    }
  }
  return { records, files }
}

// ---------------------------------------------------------------------------
// 第一步：扫描，暂存等用户确认
// ---------------------------------------------------------------------------

interface Pending {
  token: string
  dir: string
  parsed: ParsedFinalShell
}

/** 单槽暂存，与 importData 同一条规矩：渲染进程只拿 token */
let pending: Pending | null = null
let applying = false

export async function scanFinalShell(opts: { dir?: string } = {}): Promise<FinalShellScan | null> {
  let dir = opts.dir
  if (!dir) {
    const r = await dialog.showOpenDialog({
      title: '选择 FinalShell 数据目录（含 conn 子目录）',
      properties: ['openDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    dir = r.filePaths[0]
  }

  const { records, files } = await readRecords(dir)
  if (files === 0) {
    throw new Error('这个目录里没有找到任何 .json 配置文件，请选择 FinalShell 的数据目录（里面应有 conn 子目录）')
  }
  const parsed = classifyFinalShellRecords(records)
  if (parsed.connections.length === 0) {
    throw new Error(
      `读到 ${files} 个 JSON 文件，但里面没有可导入的 SSH 连接（跳过 ${parsed.invalid} 条结构不完整、${parsed.notSsh} 条非 SSH）`
    )
  }

  const locked = parsed.connections.filter((c) => c.lockedPassword).length
  const withProxy = parsed.connections.filter((c) => c.hasProxy).length
  const withKey = parsed.connections.filter((c) => c.usesKey).length
  const forwards = parsed.connections.reduce((sum, c) => sum + c.forwards, 0)

  const notes: string[] = []
  if (locked > 0) {
    notes.push(
      `${locked} 条连接在 FinalShell 里存了密码。那些密码用 FinalShell 自己的密钥加密，本项目不猜它的密钥，所以不会跟过来 —— 首次连接时输入一次并勾选"记住密码"，即由本机密钥库加密保存。`
    )
  }
  if (withKey > 0) {
    notes.push(
      `${withKey} 条连接用的是密钥认证。私钥存在 FinalShell 自己的密钥库里，导入后请在连接编辑里指定私钥文件。`
    )
  }
  if (withProxy > 0) {
    notes.push(`${withProxy} 条连接配了代理，代理配置需要在本项目里重新填一次。`)
  }
  if (forwards > 0) {
    notes.push(`${forwards} 条端口转发规则未导入（FinalShell 的转发格式本项目没有样本可对照）。`)
  }
  if (parsed.unknownCharsets.size > 0) {
    notes.push(
      `以下终端编码本项目认不出来，已按 UTF-8 导入：${[...parsed.unknownCharsets].join('、')}`
    )
  }

  pending = { token: randomUUID(), dir, parsed }
  log.info(
    `finalshell scan ${dir}: ${files} files → ${parsed.connections.length} ssh, ${parsed.groups.length} groups, invalid=${parsed.invalid}, notSsh=${parsed.notSsh}, locked=${locked}`
  )

  return {
    token: pending.token,
    dir,
    counts: {
      profiles: parsed.connections.length,
      groups: parsed.groups.length,
      invalid: parsed.invalid,
      notSsh: parsed.notSsh,
      lockedPasswords: locked
    },
    samples: parsed.connections.slice(0, 8).map((c) => ({
      name: c.name,
      host: c.host!,
      port: c.port!,
      username: c.username ?? 'root'
    })),
    notes
  }
}

// ---------------------------------------------------------------------------
// 第二步：写入
// ---------------------------------------------------------------------------

/** 判重：id 是新生成的，所以只能按"主机+端口+用户名"认同一台机器 */
function sameTarget(a: ConnectionProfile, host: string, port: number, username: string): boolean {
  return a.host === host && a.port === port && a.username === username
}

export function applyFinalShellImport(opts: FinalShellImportOptions): FinalShellImportResult {
  if (!pending || pending.token !== opts.token) {
    throw new Error('导入会话已失效，请重新选择目录')
  }
  if (applying) throw new Error('上一次导入还在进行中')

  const { parsed } = pending
  const result: FinalShellImportResult = {
    profiles: 0,
    groups: 0,
    skipped: 0,
    invalid: parsed.invalid,
    secrets: 0,
    notes: []
  }

  applying = true
  try {
    const existing = listConnections().profiles

    /*
     * 分组：FinalShell 的 id 不复用（它是 16 位随机串，本项目的 id 是 UUID，
     * 混在一起以后没法区分谁是哪来的），所以建一张 旧 id → 新 id 的映射，
     * 连接的 parent_id 靠它翻译。找不到父的（分组记录不在这个目录里）落到根，
     * 并在 notes 里说一声 —— 静默丢掉分组结构会让用户以为导入不完整。
     */
    const groupIdMap = new Map<string, string>()
    for (const g of parsed.groups) {
      groupIdMap.set(g.id, randomUUID())
    }
    let orphanGroups = 0
    for (const g of parsed.groups) {
      const parentId = g.parentId ? (groupIdMap.get(g.parentId) ?? null) : null
      if (g.parentId && parentId === null) orphanGroups++
      saveGroup({
        id: groupIdMap.get(g.id)!,
        name: g.name,
        parentId,
        order: g.updatedAt
      })
      result.groups++
    }

    let orphanConnections = 0
    for (const c of parsed.connections) {
      const host = c.host!
      const port = c.port!
      const username = c.username ?? 'root'

      if (opts.conflict === 'skip' && existing.some((p) => sameTarget(p, host, port, username))) {
        result.skipped++
        continue
      }
      const groupId = c.parentId ? (groupIdMap.get(c.parentId) ?? null) : null
      if (c.parentId && groupId === null) orphanConnections++

      /*
       * 走 saveProfile 而不是自己拼 ConnectionProfile 写库 —— 那是本项目唯一的加密入口：
       * draft.auth.password 是明文，saveProfile 内部 vault.putSecret 加密后只把引用落库。
       * 这里 password 一律不给（解不出来，见文件头），所以首次连接会问一次；
       * 用户勾"记住密码"的那一下走的也是这个函数。
       */
      const draft: ProfileDraft = {
        name: c.name,
        groupId,
        host,
        port,
        username,
        auth: { method: 'password' },
        terminal: { charset: c.charset, termType: 'xterm-256color' },
        options: {
          keepaliveInterval: 15_000,
          readyTimeout: 20_000,
          legacyAlgorithms: false,
          autoReconnect: true,
          monitorEnabled: true,
          compress: false
        },
        note: c.note
      }
      saveProfile(draft)
      result.profiles++
    }

    if (orphanGroups + orphanConnections > 0) {
      result.notes.push(
        `${orphanGroups + orphanConnections} 条记录的上级分组不在所选目录里，已放到根目录下。`
      )
    }
    if (parsed.connections.some((c) => c.lockedPassword)) {
      result.notes.push(
        '导入的连接没有密码：FinalShell 的密码用它自己的密钥加密，本项目不猜那个密钥。首次连接时输入并勾选"记住密码"，密码就由本机密钥库加密保存。'
      )
    }
    if (parsed.notSsh > 0) {
      result.notes.push(`跳过 ${parsed.notSsh} 条非 SSH 连接（本项目只做 SSH）。`)
    }
    log.info(
      `finalshell import: ${result.profiles} profiles, ${result.groups} groups, skipped=${result.skipped}`
    )
    return result
  } finally {
    applying = false
    pending = null
  }
}

/** 测试用：把暂存清掉，免得用例之间互相影响 */
export function resetFinalShellPending(): void {
  pending = null
  applying = false
}
