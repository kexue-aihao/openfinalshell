import type { ClientChannel } from 'ssh2'
import { EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_OUTPUT_BYTES } from '@shared/constants'
import { wrapShellScript } from './shellQuote'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('exec')

/**
 * 一次性远端命令。
 *
 * 在这个文件出现之前，全项目**只有** SshConnection.openMonitorChannel() 一个 exec 设施：
 * 它开一条常驻的裸 `sh` 通道、往 stdin 喂命令、按哨兵切帧，没有退出码、没有 stderr、
 * 也不是一次性的。快速删除要的东西正好相反 —— 一条命令、要退出码、要 stderr。
 *
 * 只暴露 execOnce 一个入口，所有远端命令都经 wrapShellScript 包成
 * `env LC_ALL=C LANG=C sh -c '<脚本>'`，见 shellQuote.ts 里那段说明。
 */

/** stderr 单独设一个小上限：它只用于给人看前几行，没必要跟 stdout 抢预算 */
const STDERR_CAP_BYTES = 16 * 1024
/**
 * 输出超过上限后仍然滚动保留的尾部长度。
 *
 * 这是为了不重犯 MonitorCollector 那个坑：那边缓冲超限时保留**尾部**，于是 BEGIN 哨兵
 * 被丢掉、整帧必然超时。这里的哨兵在**末尾**，所以正文保留头部（OFSLEFT 那些行都在前面），
 * 同时用这个滚动窗口单独盯住尾部 —— 于是"输出被截断"和"拿不到退出码"是两件独立的事。
 */
const SENTINEL_TAIL_CHARS = 512

/**
 * RC 哨兵。
 *
 * 为什么不直接用 `exit` 事件：按 SSH 规范服务器发 exit-status **是可选的**
 * （@types/ssh2 里那行注释原话就是 "may"），中途断连时更是一定没有。所以脚本自己在末尾
 * 打印一行退出码，`exit` 事件退化成兜底。两者都没有 → `code: null`。
 *
 * **null 一律当"未知"，永不当成功。**
 */
const RC_SENTINEL_PATTERN = '@@OFS:RC:(\\d+)@@'

/** 追加在每段脚本末尾。所以脚本自己**不要** `exit` —— 想指定状态就用 `(exit N)` 留在 `$?` 里 */
const RC_SENTINEL_TAIL = `\n__ofs_rc=$?\nprintf '\\n@@OFS:RC:%s@@\\n' "$__ofs_rc"\n`

export interface ExecResult {
  /** stdout，已剥掉 RC 哨兵那一行 */
  stdout: string
  stderr: string
  /** null = 没拿到退出码（服务器没发 exit-status 且哨兵也没出现，通常是中途断连） */
  code: number | null
  /** 输出超过上限被截断 —— 保留的是**头部** */
  truncated: boolean
}

/** execOnce 只需要连接能开一条 exec 通道；收窄成这一个方法让它不依赖整个 SshConnection */
export interface ExecCapable {
  execChannel(command: string): Promise<ClientChannel>
}

/**
 * 从 stdout 里取出退出码，并把哨兵行剥掉。纯函数。
 *
 * 取**最后**一个匹配：我们的哨兵是追加在脚本末尾的，所以正文里万一也出现同样的字样
 * （比如命令回显了一个含这串字符的文件名），赢的一定是我们那个。
 * 顺带只认 0–255 —— 超出这个范围的不可能是真的退出状态，当没看见比当成结果安全。
 */
export function parseRcSentinel(stdout: string): { body: string; code: number | null } {
  const re = new RegExp(RC_SENTINEL_PATTERN, 'g')
  let hit: { index: number; code: number } | null = null
  for (let m = re.exec(stdout); m; m = re.exec(stdout)) {
    const code = Number(m[1])
    if (code >= 0 && code <= 255) hit = { index: m.index, code }
  }
  if (!hit) return { body: stdout, code: null }
  // 哨兵前面那个换行是我们自己打的，一并去掉（只去一个，正文本来的空行要留着）
  return { body: stdout.slice(0, hit.index).replace(/\n$/, ''), code: hit.code }
}

export interface ExecOptions {
  timeoutMs?: number
  maxBytes?: number
}

/**
 * 发一段脚本、等它跑完、把 stdout/stderr/退出码带回来。
 *
 * 超时是**杀通道**而不是等 —— 一个永远不返回的 exec 会一直占着一个 session 通道，
 * 而 sshd 默认 MaxSessions 只有 10。
 */
export async function execOnce(
  conn: ExecCapable,
  script: string,
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? EXEC_MAX_OUTPUT_BYTES
  const channel = await conn.execChannel(wrapShellScript(`${script}${RC_SENTINEL_TAIL}`))

  return new Promise<ExecResult>((resolve, reject) => {
    let head = ''
    let tail = ''
    let stderr = ''
    let truncated = false
    let exitCode: number | null = null
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      log.warn(`exec timed out after ${timeoutMs}ms, killing channel`)
      channel.close()
      reject(new Error(`远端命令超时（${Math.round(timeoutMs / 1000)} 秒），已终止`))
    }, timeoutMs)

    channel.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (head.length < maxBytes) {
        head += text.slice(0, maxBytes - head.length)
        if (head.length >= maxBytes) truncated = true
      } else {
        truncated = true
      }
      tail = (tail + text).slice(-SENTINEL_TAIL_CHARS)
    })

    channel.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString('utf8')
    })

    channel.on('exit', (code: number | null) => {
      if (typeof code === 'number') exitCode = code
    })

    // 以 close 为终止条件而不是 exit：exit 可能永远不来，而 close 一定来
    channel.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 退出码只从尾窗取（它必然完整），正文的剥离单独走一遍 —— 于是"截断"不影响拿退出码
      const fromSentinel = parseRcSentinel(tail).code
      resolve({
        stdout: parseRcSentinel(head).body,
        stderr: stderr.slice(0, STDERR_CAP_BYTES),
        code: fromSentinel ?? exitCode,
        truncated
      })
    })
  })
}
