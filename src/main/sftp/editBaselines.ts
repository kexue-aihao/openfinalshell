import type { RemoteCharset } from '@shared/constants'
import type { SessionId } from '@shared/types'
import type { SaveBaseline } from './remoteTextWrite'

/**
 * 内置编辑器的"打开时远端是什么样"的注册表。**只在 main 侧，一个字节都不下发。**
 *
 * 为什么必须有这么一份状态，而 `sftp:fileView` 那条路是刻意无状态的：
 * 冲突检测问的是"远端在**我打开它之后**变过没有"，这句话里的"我打开它的那一刻"
 * 只能被记住，没法在保存时重新算出来。
 *
 * 为什么不让渲染进程持有基线、保存时回传（那样这个文件就不用存在）：
 * 基线是冲突检测的**全部依据**。一旦它能被回传，渲染进程的任何一个 bug ——
 * 一次错误的浅拷贝、一次"重试时顺手用当前值填一下" —— 都能构造出
 * "基线正好等于远端现状"，于是检测永远说"没变过"，用户永远静默盖掉别人的改动。
 * 而这类 bug 不会有任何症状：它只在别人同时改了同一个文件时才造成损失，
 * 而那正是没人在测试里覆盖的那一天。
 *
 * 为什么单独成一个模块而不是塞进 fileSave.ts：`SshConnectionManager.close()` 要清它
 * （照 clearProbeCache 那条），而 fileSave 要 `sshManager.get()` 拿 SFTP 通道 ——
 * 放一起就是 SshConnectionManager ⇄ fileSave 的静态环。这个文件除了类型什么都不 import，
 * 于是两边都能安全地引它。
 */

/** 一个打开着的文件在 main 侧被记住的全部东西 */
export interface EditBaseline {
  /**
   * 软链解析后的真身。保存时会**重新解析一次**并与这个值比 —— 不一致意味着
   * 这条路径此刻指向的是另一个文件，那时候保存必须停下来（见 fileSave 的说明）。
   */
  resolvedPath: string
  /** 传给 saveRemoteText 的那份（sha / size / mtime / mode） */
  save: SaveBaseline
  /**
   * 打开时那份字节能不能无损地"解码→编码"回原样。
   *
   * false 意味着编辑器里的字符串已经是那份字节的**有损渲染**（非法字节序列被替换字符顶了），
   * 保存必然把用户从未看见过的字节永久改写掉。这一条**没有任何确认能让它变安全**，
   * 所以它不是闸门、是硬拒（见 fileSave）。记在这里而不是让渲染进程报，
   * 是因为 main 才是知道原始字节的那一侧。
   */
  lossless: boolean
  /** 打开时用的编码。只用于报错文案（换编码另存是合法操作，不拿它做校验） */
  charset: RemoteCharset
}

/**
 * 注册表容量上限。
 *
 * 渲染进程那侧有 MAX_OPEN_VIEWS = 10 的闸门，但 main 不该相信它 —— `sftp:fileView`
 * 是渲染进程可以任意次调用的 channel，而每条基线都常驻。
 *
 * 满了按插入顺序淘汰最老的一条，这**是安全的**：基线不在 = 保存硬拒并让用户重新打开
 * （见 fileSave 里 missingBaseline 的处理），绝不会退化成"跳过冲突检测直接写"。
 * 淘汰的代价是一次"请重新打开该文件"，而它只可能发生在同时开着 200 个文件之后。
 */
export const MAX_TRACKED_BASELINES = 200

const keyOf = (sessionId: SessionId, path: string): string => `${sessionId}::${path}`

/** sessionId::用户点开的那条路径 → 基线。Map 的插入顺序就是淘汰顺序 */
const baselines = new Map<string, EditBaseline>()

/**
 * 记住（或刷新）一条基线。fileView 每次成功读完都调一次 ——
 * 包含"换个编码重读"，那时字节没变、基线也就没变，只是 lossless / charset 跟着更新。
 */
export function rememberBaseline(
  sessionId: SessionId,
  path: string,
  baseline: EditBaseline
): void {
  const key = keyOf(sessionId, path)
  // 先删再插：让刷新过的条目回到 Map 末尾，于是淘汰的总是真正最久没被碰过的那条
  baselines.delete(key)
  baselines.set(key, baseline)
  while (baselines.size > MAX_TRACKED_BASELINES) {
    const oldest = baselines.keys().next()
    if (oldest.done) break
    baselines.delete(oldest.value)
  }
}

export function getBaseline(sessionId: SessionId, path: string): EditBaseline | undefined {
  return baselines.get(keyOf(sessionId, path))
}

/** 会话关掉：它名下的基线全部作废（照 SshConnectionManager.close 里 clearProbeCache 那条） */
export function forgetSessionBaselines(sessionId: SessionId): void {
  const prefix = `${sessionId}::`
  for (const key of [...baselines.keys()]) {
    if (key.startsWith(prefix)) baselines.delete(key)
  }
}

/** 单个文件被关掉（渲染进程关标签）。不清也只是占一条，但没必要留着 */
export function forgetBaseline(sessionId: SessionId, path: string): void {
  baselines.delete(keyOf(sessionId, path))
}

/** 只给单测用：把注册表清空，免得用例之间互相看见对方的基线 */
export function resetBaselinesForTest(): void {
  baselines.clear()
}

/** 只给单测用：当前记着多少条（验淘汰） */
export function trackedBaselineCount(): number {
  return baselines.size
}
