import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { watchLocalFile, type WatchHandle } from '../../src/main/sftp/localFileWatch'

/**
 * 用真实临时目录跑，不 mock fs —— 这个模块要防的坑（rename 覆盖、删了再建、
 * 兄弟噪音文件）全是真实文件系统的行为，mock 掉就等于把被测对象换成了自己的假设。
 */

const DEBOUNCE = 100
const POLL = 150

/**
 * 内容确认间隔（生产默认 250ms，这里压小只为让整套测试跑得快）。
 * 除了分段改写那条用例，其余用例都是"写完就不动了"，第一轮确认必然通过，
 * 这个值取多少都不影响结论，只影响每次回调多等多久。
 */
const CONFIRM = 80

/**
 * 负向断言（"不该触发"）的观察窗口：防抖 3 倍 + 200ms。
 * 为什么够：正向用例在同样参数下都在 100~150ms 内回调，本窗口是它的 3 倍以上；
 * 且窗口必须大于 POLL + DEBOUNCE（=250ms），否则 watchFile 那条轮询的事件还没
 * 送到我们就收工了，等于只测了 fs.watch 一条路。
 */
const QUIET_WINDOW_MS = DEBOUNCE * 3 + 200

/** 正向用例给足余量：rename 只报源名的平台要等一个轮询周期才补上 */
const FIRE_TIMEOUT_MS = 3000

function sha(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(10)
  }
  throw new Error(`waitFor 超时：${label}`)
}

interface Recorder {
  calls: Array<{ text: string; sha: string }>
  onChanged: (buf: Buffer, sha256: string) => void
}

function recorder(): Recorder {
  const calls: Array<{ text: string; sha: string }> = []
  return {
    calls,
    onChanged: (buf, sha256) => {
      calls.push({ text: buf.toString('utf8'), sha: sha256 })
    }
  }
}

describe('watchLocalFile', () => {
  let dir: string
  let file: string
  let handle: WatchHandle | null = null
  let rec: Recorder

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ofs-watch-'))
    file = join(dir, 'nginx.conf')
    writeFileSync(file, 'v0')
    rec = recorder()
  })

  afterEach(() => {
    // 先 close 再删目录：Windows 上带活 watcher 的目录删除会被句柄挡住
    handle?.close()
    handle = null
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  function start(opts?: { debounceMs?: number; confirmIntervalMs?: number }): void {
    handle = watchLocalFile(file, sha('v0'), rec.onChanged, {
      debounceMs: opts?.debounceMs ?? DEBOUNCE,
      confirmIntervalMs: opts?.confirmIntervalMs ?? CONFIRM,
      pollIntervalMs: POLL
    })
  }

  it('原地覆盖同名文件 → 回调一次，内容与哈希正确', async () => {
    start()
    writeFileSync(file, 'v1')
    await waitFor(() => rec.calls.length > 0, FIRE_TIMEOUT_MS, '原地覆盖未触发')
    expect(rec.calls[0].text).toBe('v1')
    // 哈希在测试里独立算，顺带钉住"sha256 + hex 小写"这个格式
    expect(rec.calls[0].sha).toBe(sha('v1'))
    // fs.watch 与 watchFile 两条路都会报这次改动，靠哈希去重后只能有一次
    await sleep(QUIET_WINDOW_MS)
    expect(rec.calls).toHaveLength(1)
  })

  it('写临时文件再 rename 覆盖（VS Code / MoveFileEx）→ 回调一次，内容正确', async () => {
    start()
    const staging = join(dir, 'nginx.conf.tmp-vscode')
    writeFileSync(staging, 'v2')
    renameSync(staging, file)
    await waitFor(() => rec.calls.length > 0, FIRE_TIMEOUT_MS, 'rename 覆盖未触发')
    expect(rec.calls[0].text).toBe('v2')
    await sleep(QUIET_WINDOW_MS)
    expect(rec.calls).toHaveLength(1)
  })

  /**
   * 原地分段改写。vim backupcopy=yes / PowerShell Set-Content / 部分 Java、Delphi
   * 编辑器走的就是这条路：open 'w' 截断 → 写前半 → 停顿 → 写后半 → close。
   * 停顿一旦跨过防抖窗口，"前后各 stat 一次"就完全失效：那一刻写者确实没在写，
   * 两次 stat 的 size 一致，NTFS 对持有句柄的文件连 last-write-time 都懒更新、
   * mtimeMs 也一致 —— 只靠 stat 的实现会把截断态的半个文件当成一次存盘，
   * 原子替换到远端，正在 `nginx -s reload` 的服务读到的就是残缺配置。
   *
   * 每档三个数的关系就是这条用例的全部：debounce < gap（旧实现的防抖挡不住，
   * 半截内容会被当成一次存盘读走）< confirm（确认间隔盖得住这个停顿，
   * 所以**新**实现在两档下都必须绿）。
   *
   * 为什么同一件事要跑两档 gap：它能不能报红，本来取决于**第一次目录事件何时到达** ——
   * 旧实现是"防抖到期读一次、读到新内容就回调"，在 gap=140/debounce=60 这档只有事件
   * 早于 t=80ms 到达时才读得到半截内容；被拖慢的 CI 上事件晚于 140ms 到，它读到的
   * 已经是完整两段，这条护栏就成了假绿。gap=400 那档把旧实现的"蒙对窗口"推到
   * 事件必须晚于 340ms 才行 —— 事件到达时刻的抖动不再决定这条护栏的成败。
   */
  for (const { gapMs, confirmIntervalMs } of [
    { gapMs: 140, confirmIntervalMs: 300 },
    { gapMs: 400, confirmIntervalMs: 900 }
  ]) {
    it(`原地分段改写、两段之间停顿 ${gapMs}ms（大于防抖窗口）→ 只回调一次，且内容是完整两段`, async () => {
      const debounceMs = 60
      start({ debounceMs, confirmIntervalMs })

      const fd = openSync(file, 'w') // 'w' 就地截断，此刻文件已经是空的了
      try {
        writeSync(fd, 'first half\n')
        await sleep(gapMs)
        writeSync(fd, 'second half\n')
      } finally {
        closeSync(fd)
      }

      await waitFor(() => rec.calls.length > 0, FIRE_TIMEOUT_MS, '分段改写未触发')
      // 半截内容一次都不许上线 —— 事后被完整版盖回来也不算数，中间那一瞬服务已经读过了
      expect(rec.calls[0].text).toBe('first half\nsecond half\n')
      expect(rec.calls[0].sha).toBe(sha('first half\nsecond half\n'))
      // 只此一次：确认逻辑不能把一次存盘拆成"半截 + 完整"两次回调
      await sleep(confirmIntervalMs * 2 + QUIET_WINDOW_MS)
      expect(rec.calls.map((c) => c.text)).toEqual(['first half\nsecond half\n'])
    })
  }

  it('先删除再重建 → 回调一次，内容正确', async () => {
    start()
    rmSync(file)
    writeFileSync(file, 'v3')
    await waitFor(() => rec.calls.length > 0, FIRE_TIMEOUT_MS, '删除重建未触发')
    expect(rec.calls[0].text).toBe('v3')
  })

  it('重建晚于防抖窗口（读到 ENOENT）→ 不报错、watcher 也不能因此报废', async () => {
    start()
    rmSync(file)
    // 空窗跨过防抖，所以读取那一刻文件确实不存在 —— 实现要么重试要么静默等下一次事件，
    // 但绝不能把异常抛出定时器（主进程里那就是 uncaughtException）或把自己关掉
    await sleep(DEBOUNCE + 60)
    expect(rec.calls).toHaveLength(0)
    writeFileSync(file, 'v3b')
    await waitFor(() => rec.calls.length > 0, FIRE_TIMEOUT_MS, 'ENOENT 之后没能恢复')
    expect(rec.calls[0].text).toBe('v3b')
    // 再存一次，确认那次 ENOENT 没把 watcher 一起带走
    await sleep(DEBOUNCE * 2)
    writeFileSync(file, 'v3c')
    await waitFor(() => rec.calls.length >= 2, FIRE_TIMEOUT_MS, 'ENOENT 之后 watcher 废了')
    expect(rec.calls[1].text).toBe('v3c')
  })

  it('同目录兄弟噪音文件变化 → 不触发', async () => {
    start()
    writeFileSync(join(dir, 'nginx.conf~'), 'backup')
    writeFileSync(join(dir, '4913'), '')
    writeFileSync(join(dir, 'x.tmp-abc'), 'staging')
    writeFileSync(join(dir, '.nginx.conf.swp'), 'swap')
    await sleep(QUIET_WINDOW_MS)
    expect(rec.calls).toHaveLength(0)
  })

  it('持续的噪音文件写入不得把已到手的存盘一直往后推', async () => {
    // 光断言"噪音不触发"是不够的：那条哈希比对本身就挡住了，噪音名单形同虚设也能过。
    // 真正的危害是噪音不停地重置防抖窗口，让一次真实存盘迟迟等不到上传 ——
    // 所以这里改成断言"到手的时间"：目标写完后噪音继续写 1.2s，回调必须早于 900ms 到。
    const bigDebounce = 400
    start({ debounceMs: bigDebounce })
    const startedAt = Date.now()
    writeFileSync(file, 'v-noise-race')
    const noise = setInterval(() => {
      writeFileSync(join(dir, 'nginx.conf~'), String(Date.now()))
    }, 80)
    try {
      await waitFor(() => rec.calls.length > 0, FIRE_TIMEOUT_MS, '噪音夹击下未触发')
    } finally {
      clearInterval(noise)
    }
    expect(rec.calls[0].text).toBe('v-noise-race')
    expect(Date.now() - startedAt).toBeLessThan(900)
  })

  it('同内容重写 → 不触发（只信哈希的直接收益）', async () => {
    start()
    writeFileSync(file, 'v0')
    await sleep(QUIET_WINDOW_MS)
    expect(rec.calls).toHaveLength(0)
  })

  it('只改 mtime → 不触发', async () => {
    start()
    const future = new Date(Date.now() + 10_000)
    utimesSync(file, future, future)
    await sleep(QUIET_WINDOW_MS)
    expect(rec.calls).toHaveLength(0)
  })

  it('防抖窗口内连写两次 → 只回调一次，且内容是第二次的', async () => {
    // 两次写之间必须留一个真实间隔（且明显小于窗口）：紧挨着的两次同步写会被事件
    // 投递本身合并掉，那样即使实现完全没有防抖也能过 —— 等于没测。
    const bigDebounce = 400
    start({ debounceMs: bigDebounce })
    writeFileSync(file, 'first')
    await sleep(120)
    writeFileSync(file, 'second-longer')
    await waitFor(() => rec.calls.length > 0, FIRE_TIMEOUT_MS, '连写未触发')
    expect(rec.calls[0].text).toBe('second-longer')
    await sleep(bigDebounce * 3 + 200)
    expect(rec.calls).toHaveLength(1)
  })

  it('close() 之后再写 → 不触发', async () => {
    start()
    handle?.close()
    writeFileSync(file, 'after-close')
    await sleep(QUIET_WINDOW_MS)
    expect(rec.calls).toHaveLength(0)
  })

  it('写完立刻 close（防抖还在途）→ 不触发', async () => {
    start()
    writeFileSync(file, 'racing')
    handle?.close()
    await sleep(QUIET_WINDOW_MS)
    expect(rec.calls).toHaveLength(0)
  })

  /**
   * close() 不许留悬挂句柄。断言方式是 process.getActiveResourcesInfo() 的**增量**：
   * close 前后两次采样之间只有一句同步的 close()，定时器不可能在两条同步语句之间到期，
   * 所以增量是精确的，不受 vitest 自己那些定时器的干扰（它们在两次采样里都在）。
   * 直接数绝对值才会飘。
   */
  function resourceCount(kind: RegExp): number {
    return process.getActiveResourcesInfo().filter((k) => kind.test(k)).length
  }

  it('close() 把定时器、StatWatcher、FSEventWrap 全部清干净', async () => {
    const baselineFsEvent = resourceCount(/FSEvent/)
    // 窗口开大，保证 close 的时候防抖确实还在途
    start({ debounceMs: 300 })
    // 两条路都要真的挂上：目录 watcher 是 FSEventWrap，轮询兜底是 StatWatcher
    expect(resourceCount(/FSEvent/)).toBe(baselineFsEvent + 1)
    expect(resourceCount(/StatWatcher/)).toBeGreaterThanOrEqual(1)

    writeFileSync(file, 'pending')
    // 200ms：目录事件几毫秒就到，轮询最迟 POLL(150ms) 也到了，而 300ms 的窗口还没到期
    await sleep(200)

    const before = { t: resourceCount(/Timeout/), s: resourceCount(/StatWatcher/) }
    handle?.close()
    const after = { t: resourceCount(/Timeout/), s: resourceCount(/StatWatcher/) }
    expect(before.t - after.t).toBe(1) // 在途的防抖定时器被清掉了
    expect(before.s - after.s).toBe(1) // watchFile 被 unwatchFile 撤了

    // FSEventWrap 是异步关闭的，给一个事件循环轮次
    await sleep(50)
    expect(resourceCount(/FSEvent/)).toBe(baselineFsEvent)
  })

  it('间隔大于防抖窗口的两次不同内容保存 → 回调两次', async () => {
    start()
    writeFileSync(file, 'v9a')
    await waitFor(() => rec.calls.length >= 1, FIRE_TIMEOUT_MS, '第一次保存未触发')
    await sleep(DEBOUNCE * 2)
    writeFileSync(file, 'v9b')
    await waitFor(() => rec.calls.length >= 2, FIRE_TIMEOUT_MS, '第二次保存未触发')
    expect(rec.calls.map((c) => c.text)).toEqual(['v9a', 'v9b'])
  })
})
