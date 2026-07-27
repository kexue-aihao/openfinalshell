import { MAX_EDIT_BYTES, type RemoteCharset } from '@shared/constants'
import type { RemoteFileSaveResult, RemoteSaveGates, SessionId } from '@shared/types'
import { getBaseline, rememberBaseline } from './editBaselines'
import { resolveRemoteTarget } from './remoteTextFile'
import { saveRemoteText } from './remoteTextWrite'
import { encodeFidelity, encodeRemoteText, type Eol } from './textCodec'
import { sshManager } from '../ssh/SshConnectionManager'

/**
 * 内置编辑器的保存：编码 → 三道硬拒 → `saveRemoteText`。
 *
 * 这个文件是**编排**，写回的语义一条都不在这里 —— 那些（原子替换、临时文件排他创建、
 * 非原子替换的备份顺序、冲突检测、截断闸门）全在 remoteTextWrite.ts。那一份当初是为了
 * 与外部编辑器共用才提出去的，那条路已经删掉，但分层留着：语义与编排分开，
 * 语义那半有自己的用例。这里只做编排的四件事：
 *   1. 把渲染进程给的字符串按指定编码/行尾/BOM 变回字节（那条路的字节来自本地文件）；
 *   2. 从注册表里取基线（那条路自己在 entry 上带着）；
 *   3. 三道"没有任何确认能让它变安全"的硬拒（见下）；
 *   4. 同一个文件的并发保存拒绝。
 *
 * **闸门与硬拒的分界**要说清楚，因为写错方向就是数据损失：
 *  - 闸门（conflict / nonAtomic / shrink）是"用户看过风险可以点确认越过"的，它们回
 *    RemoteFileSaveResult 的一个分支，界面弹确认框，用户点了就带着 gate 再调一次。
 *  - 硬拒是抛异常，**没有任何 gate 能越过**：编码存不下去、原始字节本来就解不干净、
 *    超过字节上限、基线不在了。这四件事的共同点是"确认也无法让它变正确"——
 *    用户点"仍然保存"并不能让一个 emoji 变成 GBK 里存在的字。
 */

/** 同一个文件正在保存中的 key 集合。见 saveRemoteTextFile 里那段说明 */
const inFlight = new Set<string>()

export interface SaveTextArgs {
  sessionId: SessionId
  /** 用户点开的那条路径（软链就是软链本身），也是注册表的 key */
  path: string
  text: string
  charset: RemoteCharset
  eol: Eol
  hasBom: boolean
  gates: RemoteSaveGates
}

export async function saveRemoteTextFile(args: SaveTextArgs): Promise<RemoteFileSaveResult> {
  const { sessionId, path, text, charset, eol, hasBom, gates } = args

  /**
   * 基线不在 = 硬拒，**绝不退化成"跳过冲突检测直接写"**。
   *
   * 会走到这里的真实情形：会话关过又开（close 清了注册表）、注册表满了淘汰了最老的一条、
   * 或者渲染进程拿着一个从没 fileView 过的路径调进来。三种情形的共同点是
   * "我们不知道你打开它时它是什么样"，而那正是冲突检测的全部依据。
   * 让用户重新打开一次是唯一诚实的出口。
   */
  const baseline = getBaseline(sessionId, path)
  if (!baseline) {
    throw new Error(
      `该文件的打开状态已失效（会话可能重连或关闭过），请关掉这个标签重新打开后再保存：${path}`
    )
  }

  /**
   * 原始字节解不干净 → 硬拒。
   *
   * lossless 为 false 意味着编辑器里的字符串已经是那份字节的**有损渲染**：非法字节序列
   * 被替换字符顶掉了。此时保存必然把用户从未看见过的字节永久改写掉，而他连"改写了什么"
   * 都无从知道。这不是闸门 —— 一次确认换不来那些字节回来。正确的出口是换个编码重开
   * （状态栏上就能切），或者干脆别用文本编辑器编辑它。
   */
  if (!baseline.lossless) {
    throw new Error(
      `这个文件用 ${baseline.charset} 解不干净（含非法字节序列），保存会永久改写那些字节。` +
        `请在状态栏换一个编码重新打开，确认内容正常后再编辑：${path}`
    )
  }

  /**
   * 用户打的字存不下去 → 硬拒。iconv 对表示不了的字符不报错，悄悄换成 `?`，
   * 于是"在 GBK 配置里粘一个 emoji"这条路上用户看到的是保存成功。见 encodeFidelity。
   */
  const fidelity = encodeFidelity(text, charset)
  if (!fidelity.ok) {
    const listed = fidelity.chars.join(' ')
    throw new Error(
      `有 ${fidelity.distinct} 种字符无法用 ${charset} 表示，保存会把它们变成问号` +
        `${listed ? `（${listed}）` : ''}。请删掉它们，或在状态栏把编码切成 utf8 后再保存。`
    )
  }

  const buf = encodeRemoteText(text, charset, { eol, hasBom })

  /**
   * 字节上限在**编码之后**判，不看 text.length：一个 700K 字符的中文文件按 UTF-8
   * 是 2.1MB，按 GBK 是 1.4MB —— 只有编码后的长度才是要写上去的那个数。
   * 打开那侧的同一道门在 remoteTextFile.ts（那边判的是 stat.size）。
   */
  if (buf.length > MAX_EDIT_BYTES) {
    throw new Error(
      `内容已超过上限，拒绝保存：${buf.length} 字节 > ${MAX_EDIT_BYTES} 字节（${path}）`
    )
  }

  /**
   * 同一个文件的并发保存**拒绝而不是排队**。
   *
   * 排队是错的，而且错得很隐蔽：第二次保存的基线是第一次保存**之前**记下的，
   * 排到它执行时远端已经被第一次写过了 —— 冲突检测于是会报"远端在你编辑期间被改过"，
   * 而那个"别人"就是我们自己。用户看到一个假冲突，点了"仍然覆盖"，从此他被训练成
   * 见到冲突框就点确认。拒绝则是一句能看懂的话："上一次保存还在进行中"。
   *
   * key 用「会话 + 用户点开的那条路径」，与注册表和渲染进程的标签 key 一致，
   * 挡住的正是真实场景（按住 Ctrl+S、或者自动保存与手动保存撞上）。
   * 两条不同的软链指向同一个真身时挡不住 —— 那要等 realpath 回来才知道，
   * 而它和"两台机器上的两个人同时改一个文件"是同一类问题，冲突检测才是该管它的地方。
   */
  const key = `${sessionId}::${path}`
  if (inFlight.has(key)) {
    throw new Error(`上一次保存还在进行中，请稍候：${path}`)
  }
  inFlight.add(key)
  try {
    const sftp = await sshManager.get(sessionId).browseSftpSession()

    /**
     * 软链重新解析一次，并与打开时记下的真身比。
     *
     * 不一致 → 硬拒，**不是** conflict。区别是实质性的：conflict 的确认框问的是
     * "远端这个文件被改过了，仍然覆盖吗"，用户点"是"授权的是覆盖**他正在编辑的那个文件**；
     * 而软链被重新指向意味着这条路径此刻通向的是**另一个文件**，把缓冲区写过去
     * 从来不在他授权的范围里。/etc/nginx/sites-enabled/ 下换站点正是靠改软链做的。
     */
    const resolvedPath = await resolveRemoteTarget(sftp, path)
    if (resolvedPath !== baseline.resolvedPath) {
      throw new Error(
        `这条路径现在指向的是另一个文件（打开时是 ${baseline.resolvedPath}，` +
          `现在是 ${resolvedPath}），已停止保存。请重新打开后确认内容再存：${path}`
      )
    }

    const outcome = await saveRemoteText(sftp, resolvedPath, buf, baseline.save, gates)

    if (outcome.kind !== 'saved') {
      // 一个字节都没写，基线保持原样 —— 用户带着 gate 再调一次时比的还是"他打开时那份"
      return outcome
    }

    /**
     * 写成了：基线推进到刚写上去的这份，否则**连续两次保存的第二次必然被判成冲突**
     * （远端确实变了，只不过是我们自己改的）。lossless 跟着置 true：
     * 现在远端那份字节就是我们刚从这个字符串编出来的，往返当然是无损的。
     */
    rememberBaseline(sessionId, path, {
      resolvedPath,
      save: outcome.baseline,
      lossless: true,
      charset
    })
    return {
      kind: 'saved',
      bytes: outcome.bytes,
      mode: outcome.mode,
      warning: outcome.warning
    }
  } finally {
    inFlight.delete(key)
  }
}
