import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeServer } from '../fakeSftpServer'
import { sha256Hex } from '../../src/main/sftp/localFileWatch'
import {
  createRemoteEditManager,
  launchEditor,
  type RemoteEditInfo,
  type RemoteEditManager
} from '../../src/main/sftp/RemoteEditManager'

/**
 * 编排层的单测：远端换成内存假服务器（test/fakeSftpServer.ts，按 ssh2 的回调签名实现），
 * 本地临时目录用真文件系统。假服务器为什么要"像真的一样难伺候"，说明在那个文件里。
 *
 * 存盘事件默认用一个手动触发的假 watcher（真 watcher 的行为归 localFileWatch 的单测），
 * 但最后有一条用真 watcher 跑的全链用例，专门钉"落地文件被改 → 真的会写回远端"这条接线。
 * openEditor 一律 no-op：单测绝不许真弹一个记事本出来。
 */

// ---------------- 手动触发的假 watcher ----------------

interface FakeWatch {
  handles: Array<{ path: string; closed: boolean; onChanged: (buf: Buffer, sha: string) => void }>
  watch: (
    filePath: string,
    initialSha256: string,
    onChanged: (buf: Buffer, sha256: string) => void
  ) => { close(): void }
  /** 模拟一次存盘：写本地文件 + 触发回调（真 watcher 就是这个顺序） */
  save(info: RemoteEditInfo, text: string): Promise<void>
}

function fakeWatch(): FakeWatch {
  const handles: FakeWatch['handles'] = []
  return {
    handles,
    watch: (filePath, _initialSha256, onChanged) => {
      const entry = { path: filePath, closed: false, onChanged }
      handles.push(entry)
      return {
        close: (): void => {
          entry.closed = true
        }
      }
    },
    save: async (info, text) => {
      await fsp.writeFile(info.localPath, text)
      const buf = Buffer.from(text)
      const live = handles.filter((h) => h.path === info.localPath && !h.closed)
      if (live.length === 0) throw new Error(`没有活着的 watcher 盯着 ${info.localPath}`)
      for (const h of live) h.onChanged(buf, sha256Hex(buf))
    }
  }
}

// ---------------- 测试脚手架 ----------------

interface Harness {
  m: RemoteEditManager
  server: FakeServer
  watcher: FakeWatch
  events: RemoteEditInfo[]
  editorOpens: string[]
  root: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitInfo(
  events: RemoteEditInfo[],
  id: string,
  pred: (info: RemoteEditInfo) => boolean,
  label: string,
  timeoutMs = 4000
): Promise<RemoteEditInfo> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = [...events].reverse().find((e) => e.id === id && pred(e))
    if (hit) return hit
    if (Date.now() > deadline) {
      const seen = events
        .filter((e) => e.id === id)
        .map((e) => `${e.state}${e.message ? `(${e.message})` : ''}`)
      throw new Error(`等不到状态：${label}；实际收到 ${seen.join(' → ')}`)
    }
    await sleep(5)
  }
}

/** 存盘成功的判据：回到 editing 且 savedAt 比上一次新 */
function savedAfter(since: number): (info: RemoteEditInfo) => boolean {
  return (info) => info.state === 'editing' && info.savedAt !== undefined && info.savedAt >= since
}

/**
 * 一个**确实已经退出**的进程的 pid，给"pid 指向死进程的临时根要被删掉"那条用例用。
 *
 * 为什么不直接编一个大数字（999999 之类）：那个数字完全可能正好有主，用例就会时绿时红，
 * 而它要钉的恰恰是"探活的结论对不对"。起一个立刻退出的 node 再拿它的 pid ——
 * spawnSync 返回时子进程已经退出并被回收，此后 kill(pid, 0) 必然是 ESRCH
 * （pid 要在这几十毫秒里被系统复用才会出错，那个窗口小到可以忽略）。
 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''])
  if (typeof r.pid !== 'number' || r.pid <= 0) {
    throw new Error('拿不到已退出子进程的 pid，这条用例证明不了任何事')
  }
  return r.pid
}

describe('RemoteEditManager', () => {
  let h: Harness

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'ofs-edit-'))
    const server = new FakeServer()
    const watcher = fakeWatch()
    const events: RemoteEditInfo[] = []
    const editorOpens: string[] = []
    const m = createRemoteEditManager({
      getSftp: async () => server.sftp,
      openEditor: async (absPath) => {
        editorOpens.push(absPath)
      },
      tempRoot: () => root,
      watch: watcher.watch
    })
    m.onState((info) => events.push(info))
    h = { m, server, watcher, events, editorOpens, root }
  })

  afterEach(async () => {
    await h.m.stopAll()
    rmSync(h.root, { recursive: true, force: true })
  })

  // ---------------- 打开 ----------------

  it('打开 → 临时文件内容与远端一致，路径在 main 侧派生的临时根下', async () => {
    h.server.putFile('/etc/app.conf', 'listen 80;\n')
    const info = await h.m.open('s1', '/etc/app.conf')

    expect(info.state).toBe('editing')
    expect(readFileSync(info.localPath, 'utf8')).toBe('listen 80;\n')
    /**
     * 落地路径必须是**解过短名**的长路径。本机 os.tmpdir() 就是 8.3 短名
     * （C:\Users\ADMINI~1\...），短名顺着 join 传染下去，任何拿路径做字符串比较/去重的
     * 地方都会各踩一遍（短名与长名不相等）。所以这里比的是 realpath 后的根，
     * 并额外确认路径里不再有 ~1 —— 少了那一次 realpathSync.native 这条会报红。
     */
    expect(info.localPath.startsWith(realpathSync.native(h.root))).toBe(true)
    if (process.platform === 'win32') expect(info.localPath).not.toContain('~1')
    // 临时目录里只能有这一个文件 —— localFileWatch 盯目录的前提
    expect(await fsp.readdir(dirname(info.localPath))).toHaveLength(1)
    expect(h.editorOpens).toEqual([info.localPath])
    expect(h.m.list()).toHaveLength(1)
  })

  it('同一路径重复打开复用同一条编辑，只是把编辑器再唤一次', async () => {
    h.server.putFile('/etc/app.conf', 'a\n')
    const first = await h.m.open('s1', '/etc/app.conf')
    // 反斜杠/重复分隔符都要规范化到同一条 key，否则会开出第二条编辑
    const again = await h.m.open('s1', '/etc//app.conf')

    expect(again.id).toBe(first.id)
    expect(again.localPath).toBe(first.localPath)
    expect(h.m.list()).toHaveLength(1)
    expect(h.editorOpens).toEqual([first.localPath, first.localPath])
    // 复用不该再挂第二个 watcher
    expect(h.watcher.handles).toHaveLength(1)
  })

  it('不同会话的同一路径是两条独立编辑（临时目录也不同）', async () => {
    h.server.putFile('/etc/app.conf', 'a\n')
    const a = await h.m.open('s1', '/etc/app.conf')
    const b = await h.m.open('s2', '/etc/app.conf')
    expect(b.id).not.toBe(a.id)
    expect(dirname(b.localPath)).not.toBe(dirname(a.localPath))
  })

  // ---------------- 保存 ----------------

  it('保存 → 远端内容被替换，且走的是 posix-rename（不是先删后改名）', async () => {
    h.server.putFile('/etc/app.conf', 'old\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    const t0 = Date.now()

    await h.watcher.save(info, 'new\n')
    const saved = await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')

    expect(h.server.contentOf('/etc/app.conf')).toBe('new\n')
    expect(saved.size).toBe(4)
    // 就位动作必须是 posix-rename，且落在目标上
    const renames = h.server.calls.filter((c) => c.startsWith('posix-rename'))
    expect(renames).toHaveLength(1)
    expect(renames[0].endsWith('-> /etc/app.conf')).toBe(true)
    // 目标既没被删过，也没被普通 rename 碰过
    expect(h.server.calls).not.toContain('unlink /etc/app.conf')
    expect(h.server.calls.filter((c) => c.startsWith('rename '))).toEqual([])
    // 临时名必须与目标同目录（跨文件系统 rename 会失败）
    expect(renames[0]).toMatch(/^posix-rename \/etc\/\.app\.conf\.ofsedit-[0-9a-f]{8} -> /)
    // 收工时目录里只剩目标文件，没有临时残留
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
  })

  it('连续两次存盘都能写回（baseline 会跟着推进，第二次不会误判成冲突）', async () => {
    h.server.putFile('/etc/app.conf', 'v0\n')
    const info = await h.m.open('s1', '/etc/app.conf')

    const t0 = Date.now()
    await h.watcher.save(info, 'v1\n')
    const first = await waitInfo(h.events, info.id, savedAfter(t0), '第一次存盘')
    await h.watcher.save(info, 'v2\n')
    await waitInfo(h.events, info.id, savedAfter((first.savedAt ?? t0) + 1), '第二次存盘')

    expect(h.server.contentOf('/etc/app.conf')).toBe('v2\n')
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toHaveLength(2)
  })

  /**
   * 本文件最重要的一条。写回中间有六到八次 await，用户完全可以在这期间再按一次 Ctrl+S。
   * 实现里那句无条件 `entry.pending = null` 会把第二份内容抹掉：排在队尾的第二个 job
   * 一跑就发现没内容可写、直接返回，远端永远停在 v1。
   * 而且**不可自愈** —— localFileWatch 的 knownSha 早推进到 sha(v2)，之后的事件全被当噪音挡掉，
   * 除非用户再动一次内容。界面看到的是第一趟的 editing，报"已写回远端"。
   */
  it('上传在飞期间又存了一次 → 第二份内容最终也上线（不许被无条件清成 null 丢掉）', async () => {
    h.server.putFile('/etc/app.conf', 'v0\n')
    const info = await h.m.open('s1', '/etc/app.conf')

    // 闸门先建好再用（同下面那条停止用例的理由：TS 不知道 executor 是同步跑的）
    let release = (): void => {}
    h.server.posixRenameGate = new Promise<void>((resolve) => {
      release = resolve
    })

    // job#1 拿着 v1 进场，卡在 posix-rename 上。等到 uploading 才算它确实已经把 v1 取到手里
    await h.watcher.save(info, 'v1\n')
    await waitInfo(h.events, info.id, (i) => i.state === 'uploading', 'uploading')
    // 就在这一刻用户又存了一次：pending 换成 v2，第二个 job 排到队尾
    await h.watcher.save(info, 'v2\n')
    release()

    const deadline = Date.now() + 4000
    while (h.server.contentOf('/etc/app.conf') !== 'v2\n' && Date.now() < deadline) {
      await sleep(10)
    }
    expect(h.server.contentOf('/etc/app.conf')).toBe('v2\n')
    // 两趟写回各自完整走了一遍原子替换，不是"第二趟悄悄没跑"
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toHaveLength(2)
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
  })

  it('存盘内容与远端一致（编辑器只是 touch）时不写回', async () => {
    h.server.putFile('/etc/app.conf', 'same\n')
    const info = await h.m.open('s1', '/etc/app.conf')

    await h.watcher.save(info, 'same\n')
    await sleep(50)
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toEqual([])
  })

  it('权限保留：临时文件 open 就带原 mode，写完再显式 chmod 一次', async () => {
    h.server.putFile('/etc/secret.conf', 'k=v\n', 0o640)
    const info = await h.m.open('s1', '/etc/secret.conf')
    const t0 = Date.now()

    await h.watcher.save(info, 'k=v2\n')
    await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')

    // open 时就带 mode：不留"先 0666 建好、再 chmod 收紧"的全局可写窗口。
    // flags 必须是 'wx' 而不是 'w'：临时名的格式是公开的，'w' 会顺着别人先摆好的符号链接
    // 把特权内容写到他选的路径去（见 writeRemoteTemp 的注释）
    const openedWithMode = h.server.calls.some((c) =>
      /^open \/etc\/\.secret\.conf\.ofsedit-\w+ wx 640$/.test(c)
    )
    expect(openedWithMode).toBe(true)
    // 有些服务器对 open 的 mode 施加 umask，所以写完还要补一次
    expect(h.server.calls).toContain('chmod /etc/secret.conf 640')
    expect(h.server.modeOf('/etc/secret.conf')).toBe(0o640)
  })

  /**
   * 临时名的格式是公开的（.<name>.ofsedit-<8hex>），而目标目录常常别人也能写、
   * 写入方常常是 root。用 'w' 的话，别人先在那个名字上摆一个符号链接，
   * 这次写入就顺着链接落到他选的路径上去。EXCL 撞上任何已存在项都必须直接失败，
   * 既不许 unlink 掉再用 'w' 建，也不许"退化重试"—— 那等于把这道门拆了。
   */
  it("远端临时文件是排他创建：全撞上就报错，绝不退化成 'w' 覆盖目标", async () => {
    h.server.putFile('/etc/app.conf', 'old\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    h.server.refuseExclusive = true

    await h.watcher.save(info, 'new\n')
    const err = await waitInfo(h.events, info.id, (i) => i.state === 'error', 'error')

    expect(err.message).toMatch(/临时文件/)
    // 关键：目标一个字节都没被动，也没有任何一次 'w' 落在临时名上
    expect(h.server.contentOf('/etc/app.conf')).toBe('old\n')
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
    const exclusive = h.server.calls.filter((c) => /^open .*\.ofsedit-\w+ wx /.test(c))
    expect(exclusive).toHaveLength(3)
    // 每次换一个新随机名，不是死磕同一个（残留撞名时换名才有意义）
    expect(new Set(exclusive).size).toBe(3)
    expect(h.server.calls.filter((c) => /^open .*\.ofsedit-\w+ w /.test(c))).toEqual([])
  })

  it('行尾被整体翻面时只警告、照样保存（不替用户改回去）', async () => {
    h.server.putFile('/etc/app.sh', '#!/bin/sh\necho a\necho b\n')
    const info = await h.m.open('s1', '/etc/app.sh')
    const t0 = Date.now()

    await h.watcher.save(info, '#!/bin/sh\r\necho a\r\necho b\r\n')
    const saved = await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')

    expect(saved.eolWarning).toBe('lfToCrlf')
    expect(h.server.contentOf('/etc/app.sh')).toBe('#!/bin/sh\r\necho a\r\necho b\r\n')
  })

  // ---------------- 不支持原子替换 ----------------

  it('服务器不支持 posix-rename → blocked，远端一个字节都没变、也没留临时文件', async () => {
    h.server.putFile('/etc/app.conf', 'old\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    h.server.posixRename = false

    await h.watcher.save(info, 'new\n')
    const blocked = await waitInfo(h.events, info.id, (i) => i.state === 'blocked', 'blocked')

    expect(blocked.message).toMatch(/原子替换/)
    // 关键断言：绝不偷偷退化成"先删后改名"
    expect(h.server.contentOf('/etc/app.conf')).toBe('old\n')
    expect(h.server.calls).not.toContain('unlink /etc/app.conf')
    expect(h.server.calls.filter((c) => c.startsWith('rename '))).toEqual([])
    // 临时文件要自己收拾干净
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
  })

  it('blocked 后显式"仍然覆盖" → 内容写入，备份名不留在远端', async () => {
    h.server.putFile('/etc/app.conf', 'old\n', 0o600)
    const info = await h.m.open('s1', '/etc/app.conf')
    h.server.posixRename = false
    await h.watcher.save(info, 'new\n')
    await waitInfo(h.events, info.id, (i) => i.state === 'blocked', 'blocked')

    await h.m.forceSave(info.id)

    expect(h.server.contentOf('/etc/app.conf')).toBe('new\n')
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
    expect(h.server.modeOf('/etc/app.conf')).toBe(0o600)
    const state = await waitInfo(
      h.events,
      info.id,
      (i) => i.state === 'editing' && i.savedAt !== undefined,
      '回到 editing'
    )
    expect(state.state).toBe('editing')
  })

  /**
   * 退化替换是三步 rename，中间任何一步失败都不能把临时文件留在人家目录里 ——
   * 同级另两条失败路径（rename 失败、blocked）都收拾了，这一条以前是裸调。
   * 残留的不只是垃圾：它是一份**特权文件的完整明文副本**，还带着原文件的权限位。
   */
  it('退化替换抛错时远端临时文件也要回收（不留一份明文副本在人家目录里）', async () => {
    h.server.putFile('/etc/app.conf', 'old\n', 0o600)
    const info = await h.m.open('s1', '/etc/app.conf')
    h.server.posixRename = false
    await h.watcher.save(info, 'new\n')
    await waitInfo(h.events, info.id, (i) => i.state === 'blocked', 'blocked')

    // 只让 tmp→target 那一步失败（只读挂载、权限）：备份回滚那一步照样能走
    h.server.renameFails = (from) => from.includes('.ofsedit-')
    // save 自己吞掉异常转成 error 态（写回失败不该把整条编辑带走），所以这里不 rejects
    await h.m.forceSave(info.id)
    const err = await waitInfo(h.events, info.id, (i) => i.state === 'error', 'error')
    expect(err.message).toMatch(/Permission denied/)

    // 原内容靠备份回滚救回来了，且没留下临时文件，也没留下备份名
    expect(h.server.contentOf('/etc/app.conf')).toBe('old\n')
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
  })

  // ---------------- 冲突 ----------------

  it('远端在编辑期间被第三方改动 → 判冲突，且远端内容一个字节都没被写', async () => {
    h.server.putFile('/etc/app.conf', 'v0\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    h.server.thirdPartyWrite('/etc/app.conf', '别人改的\n')

    await h.watcher.save(info, '我改的\n')
    const conflict = await waitInfo(h.events, info.id, (i) => i.state === 'conflict', 'conflict')

    expect(conflict.message).toMatch(/编辑期间被改动/)
    expect(h.server.contentOf('/etc/app.conf')).toBe('别人改的\n')
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toEqual([])
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
  })

  it('冲突后显式"仍然覆盖"才写入', async () => {
    h.server.putFile('/etc/app.conf', 'v0\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    h.server.thirdPartyWrite('/etc/app.conf', '别人改的\n')
    await h.watcher.save(info, '我改的\n')
    await waitInfo(h.events, info.id, (i) => i.state === 'conflict', 'conflict')

    await h.m.forceSave(info.id)
    expect(h.server.contentOf('/etc/app.conf')).toBe('我改的\n')
  })

  /**
   * 256KB 以上走的是另一条判据（size+mtime，不重下内容算哈希）。
   * 这条分支没有用例的话，"大文件永远不报冲突"和"大文件永远报冲突"都能蒙过去。
   */
  it('大文件（>256KB）靠 size+mtime 判冲突：同长度但被 touch 过也算变了', async () => {
    const big = 'x'.repeat(300 * 1024)
    h.server.putFile('/etc/big.conf', `${big}\n`)
    const info = await h.m.open('s1', '/etc/big.conf')

    // 长度一模一样，只有内容和 mtime 变了 —— 哈希那条路走不到，只能靠 mtime 抓
    h.server.thirdPartyWrite('/etc/big.conf', `${'y'.repeat(300 * 1024)}\n`)
    await h.watcher.save(info, `${big}!\n`)
    await waitInfo(h.events, info.id, (i) => i.state === 'conflict', 'conflict')
    expect(h.server.contentOf('/etc/big.conf')).toBe(`${'y'.repeat(300 * 1024)}\n`)
  })

  it('大文件没被动过时照样存得回去；行尾真被翻面也不报（大文件不留 baseline 内容）', async () => {
    // 15000 行 × 21 字节 ≈ 315KB，稳稳越过 256KB 那条分水岭
    const lines = Array.from({ length: 15000 }, () => 'x'.repeat(20))
    const lf = `${lines.join('\n')}\n`
    const crlf = `${lines.join('\r\n')}\r\n`
    h.server.putFile('/etc/big.conf', lf)
    const info = await h.m.open('s1', '/etc/big.conf')
    const t0 = Date.now()

    /**
     * 这一存**真的把行尾全翻成了 CRLF** —— 同样的内容换成小文件必报 lfToCrlf。
     * 大文件那条路不留 baseline 内容（留着就是每条编辑常驻几 MB），没有 before 就无从比较，
     * 所以该整个跳过判定。这条断言必须建立在"行尾确实翻了面"之上才有意义：
     * 原先两侧都是"1 个 LF、0 个 CRLF"，detectEolRegression 本来就返回 none，
     * 实现对错两种情况下断言都绿，等于什么都没钉住。
     */
    await h.watcher.save(info, crlf)
    await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')
    expect(h.server.contentOf('/etc/big.conf')).toBe(crlf)
    expect(h.m.list()[0].eolWarning).toBeUndefined()
  })

  /**
   * 写回之后那次 stat 只是拿来刷新 baseline 的，失败不算保存失败 —— 但**绝不能拿 0 顶替**。
   * 大文件只比 size+mtime，真实 mtime 必然不等于 0，于是此后每一次存盘都误判成冲突，
   * 而且再没机会自己修正：用户只剩 forceSave 可点，而那条路是跳过冲突检测的。
   */
  it('写回后那次 stat 打不通 → 下一次存盘不许误判成冲突（mtime 未知不等于 mtime 是 0）', async () => {
    const big = 'x'.repeat(300 * 1024)
    h.server.putFile('/etc/big.conf', `${big}a\n`)
    const info = await h.m.open('s1', '/etc/big.conf')

    /**
     * 只掐掉紧跟在 chmod 之后的那一次 stat —— 写回流水线的顺序是
     * posix-rename → chmod → stat(刷新 baseline)，所以这个条件精确命中"写回后那次"。
     * armed 让它只发生一次，否则第二趟的冲突检测 stat 也会被掐掉（那就变成另一个 bug 了）。
     */
    let armed = true
    h.server.statHook = (path) => {
      if (!armed || path !== '/etc/big.conf') return false
      if (!h.server.calls[h.server.calls.length - 1]?.startsWith('chmod ')) return false
      armed = false
      return true
    }

    const t0 = Date.now()
    await h.watcher.save(info, `${big}b\n`)
    const first = await waitInfo(h.events, info.id, savedAfter(t0), '第一次存盘')
    expect(armed).toBe(false) // 那次 stat 真的被掐掉了，不是用例自己没生效

    // 远端没有任何第三方改动，第二次存盘必须照样过 —— 长度也故意保持一致，
    // 逼判定只能落在 mtime 这一项上
    await h.watcher.save(info, `${big}c\n`)
    await waitInfo(h.events, info.id, savedAfter((first.savedAt ?? t0) + 1), '第二次存盘')
    expect(h.server.contentOf('/etc/big.conf')).toBe(`${big}c\n`)
  })

  it('远端文件在编辑期间被删掉 → 也算冲突，不盲目重建', async () => {
    h.server.putFile('/etc/app.conf', 'v0\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    h.server.nodes.delete('/etc/app.conf')

    await h.watcher.save(info, 'v1\n')
    const conflict = await waitInfo(h.events, info.id, (i) => i.state === 'conflict', 'conflict')
    expect(conflict.message).toMatch(/不存在/)
    expect(h.server.paths()).toEqual([])
  })

  // ---------------- 截断闸门（内容急剧变短） ----------------

  /**
   * 这一组挡的是 localFileWatch 判"写完了"的固有漏洞：它靠"连续两次读到同样内容"，
   * 两次之间只隔防抖 180ms + 确认 250ms = 430ms。编辑器原地分段改写
   * （vim backupcopy=yes、PowerShell Set-Content、慢盘或杀软介入）时，两段之间的停顿
   * 只要超过 430ms，半截内容就会被当成一次完成的存盘交上来 —— 实测最坏一档是
   * open('w') 截断后停顿 500ms 才写第一个字节，回调拿到的字节数是 [0, 24]：
   * **远端 nginx.conf 先被替换成 0 字节**再被补回来，正在 reload 的服务读到的就是空配置。
   * save 那边原先只挡 >2MB 与含 NUL，对"从 20KB 缩到 0"没有任何闸门。
   */
  it('存盘变成 0 字节 → 进 shrink 等确认，远端一个字节都没被写', async () => {
    const before = 'server {\n  listen 80;\n}\n'
    h.server.putFile('/etc/nginx.conf', before)
    const info = await h.m.open('s1', '/etc/nginx.conf')

    await h.watcher.save(info, '')
    const s = await waitInfo(h.events, info.id, (i) => i.state === 'shrink', 'shrink')

    // 消息里必须有"从 X 变成 Y"的实数：用户要靠这两个数字判断是自己删的还是编辑器写了一半
    expect(s.message).toMatch(new RegExp(String(before.length)))
    expect(s.message).toMatch(/0 字节/)
    // 关键：远端一个字节都没动 —— 连同目录下的临时文件都不该出现过
    expect(h.server.contentOf('/etc/nginx.conf')).toBe(before)
    expect(h.server.paths()).toEqual(['/etc/nginx.conf'])
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toEqual([])
    expect(h.server.calls.filter((c) => /^open .*\.ofsedit-/.test(c))).toEqual([])
  })

  it('baseline ≥ 4KB 且缩到 1/4 以下 → shrink（分段改写只落了前一段的那一档）', async () => {
    const full = 'listen 80;\n'.repeat(1000) // 11000 字节
    h.server.putFile('/etc/big.conf', full)
    const info = await h.m.open('s1', '/etc/big.conf')

    // 2200 < 11000/4：像是只写了开头一段
    await h.watcher.save(info, 'listen 80;\n'.repeat(200))
    const s = await waitInfo(h.events, info.id, (i) => i.state === 'shrink', 'shrink')

    expect(s.message).toMatch(/11000/)
    expect(s.message).toMatch(/2200/)
    expect(h.server.contentOf('/etc/big.conf')).toBe(full)
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toEqual([])
  })

  it('正常小幅编辑（8KB 删到 7KB）不拦：闸门不能把日常删几行也变成一次确认', async () => {
    h.server.putFile('/etc/mid.conf', `${'x'.repeat(8000)}\n`)
    const info = await h.m.open('s1', '/etc/mid.conf')
    const t0 = Date.now()

    await h.watcher.save(info, `${'x'.repeat(7000)}\n`)
    await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')
    expect(h.server.contentOf('/etc/mid.conf')).toBe(`${'x'.repeat(7000)}\n`)
  })

  /**
   * 4KB 那个尺寸门槛就是为这一档设的：几百字节的 .env / authorized_keys 里删掉一多半
   * 是日常编辑，纯比例判据在这个尺度上全是误报（300 → 6 字节，比例上比上面那条还夸张）。
   * 少了尺寸门槛这条会报红。
   */
  it('小文件（< 4KB）删掉大半不拦：比例判据在这个尺度上全是误报', async () => {
    h.server.putFile('/root/.env', 'KEY=1\n'.repeat(50)) // 300 字节
    const info = await h.m.open('s1', '/root/.env')
    const t0 = Date.now()

    await h.watcher.save(info, 'KEY=1\n') // 6 字节
    await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')
    expect(h.server.contentOf('/root/.env')).toBe('KEY=1\n')
  })

  /**
   * baseline 为空（刚用「新建 > 文件」建出来的 0 字节文件）不许误拦 ——
   * 否则"新建文件 → 写内容 → 保存"这条最常见的路第一次存盘就要用户点一次确认。
   * 后半段顺带钉住：一旦文件有了内容，baseline 跟着推进，再清空就该拦了。
   */
  it('baseline 为空的新建文件照样存得进去；有了内容之后再清空才拦', async () => {
    h.server.putFile('/etc/new.conf', '')
    const info = await h.m.open('s1', '/etc/new.conf')
    const t0 = Date.now()

    await h.watcher.save(info, 'listen 80;\n')
    await waitInfo(h.events, info.id, savedAfter(t0), '第一次存盘')
    expect(h.server.contentOf('/etc/new.conf')).toBe('listen 80;\n')

    await h.watcher.save(info, '')
    const s = await waitInfo(h.events, info.id, (i) => i.state === 'shrink', 'shrink')
    expect(s.message).toMatch(/11 字节/)
    expect(h.server.contentOf('/etc/new.conf')).toBe('listen 80;\n')
  })

  /**
   * 拦是"要确认"而不是"禁止"：真想清空/大幅删减一个远端文件是合理需求，
   * 出口就是既有的强制覆盖入口（与 blocked 完全同款的形状）。
   */
  it('shrink 后显式"仍然覆盖" → 这份短内容真的写进远端', async () => {
    h.server.putFile('/etc/app.conf', 'a'.repeat(9000), 0o600)
    const info = await h.m.open('s1', '/etc/app.conf')
    await h.watcher.save(info, '')
    await waitInfo(h.events, info.id, (i) => i.state === 'shrink', 'shrink')

    await h.m.forceSave(info.id)

    expect(h.server.contentOf('/etc/app.conf')).toBe('')
    // 走的仍然是原子替换那条路，权限也照旧保留
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toHaveLength(1)
    expect(h.server.modeOf('/etc/app.conf')).toBe(0o600)
    expect(h.server.paths()).toEqual(['/etc/app.conf'])
    await waitInfo(
      h.events,
      info.id,
      (i) => i.state === 'editing' && i.savedAt !== undefined,
      '回到 editing'
    )
  })

  /** retry 保留全部检测 —— 它是"再走一遍带检测的写回"，不是 forceSave 的别名 */
  it('shrink 后点 retry 仍然被拦（那条路不该顺手跳过闸门）', async () => {
    h.server.putFile('/etc/app.conf', 'a'.repeat(9000))
    const info = await h.m.open('s1', '/etc/app.conf')
    await h.watcher.save(info, '')
    await waitInfo(h.events, info.id, (i) => i.state === 'shrink', 'shrink')

    // 数 shrink 事件的条数：waitInfo 会翻历史，只判"有过 shrink"的话这条等于没测
    const shrinks = (): number =>
      h.events.filter((e) => e.id === info.id && e.state === 'shrink').length
    const before = shrinks()
    await h.m.retry(info.id)
    expect(shrinks()).toBe(before + 1)
    expect(h.server.contentOf('/etc/app.conf')).toBe('a'.repeat(9000))
    expect(h.server.calls.filter((c) => c.startsWith('posix-rename'))).toEqual([])
  })

  // ---------------- 重试 / 强行覆盖 ----------------

  /**
   * error 态最常见的成因是**可重试的瞬时故障**（重连中的"会话未就绪"、网络抖一下）。
   * 只给 forceSave 一个出口，等于一次网络抖动就把用户推上"无条件覆盖别人改动"那条路。
   * 所以 retry 必须是"带冲突检测地再走一遍"，不是 forceSave 的别名。
   */
  it('瞬时故障进 error 后 retry 仍然做冲突检测（不是悄悄走 forceSave 那条路）', async () => {
    const server = new FakeServer()
    server.putFile('/etc/app.conf', 'v0\n')
    const watcher = fakeWatch()
    const events: RemoteEditInfo[] = []
    let sftpCalls = 0
    const m = createRemoteEditManager({
      getSftp: async () => {
        sftpCalls += 1
        // 第二次 = 第一趟写回，模拟重连中的瞬时故障
        if (sftpCalls === 2) throw new Error('会话未就绪')
        return server.sftp
      },
      openEditor: async () => {},
      tempRoot: () => h.root,
      watch: watcher.watch
    })
    m.onState((info) => events.push(info))

    const info = await m.open('s1', '/etc/app.conf')
    await watcher.save(info, '我改的\n')
    const failed = await waitInfo(events, info.id, (i) => i.state === 'error', 'error')
    expect(failed.message).toMatch(/会话未就绪/)

    // 抖动期间别人改了远端：retry 必须看见它
    server.thirdPartyWrite('/etc/app.conf', '别人改的\n')
    await m.retry(info.id)
    const conflict = await waitInfo(events, info.id, (i) => i.state === 'conflict', 'conflict')
    expect(conflict.message).toMatch(/编辑期间被改动/)
    expect(server.contentOf('/etc/app.conf')).toBe('别人改的\n')

    // 看清冲突之后仍然要覆盖，那是用户显式的决定 —— 那条路才归 forceSave
    await m.forceSave(info.id)
    expect(server.contentOf('/etc/app.conf')).toBe('我改的\n')
    await m.stopAll()
  })

  /**
   * "点了完全没反应（没状态变化、没提示、没报错）"是最难排查的一类 bug：
   * 用户会一直点，日志里一片空白。宁可抛一句人话让界面显示出来。
   */
  it('pending 已空时 retry / forceSave 都报错，不许静默返回', async () => {
    h.server.putFile('/etc/app.conf', 'a\n')
    const info = await h.m.open('s1', '/etc/app.conf')

    // 刚打开、一次都没存过（界面状态过期时这两个按钮点得到）
    await expect(h.m.forceSave(info.id)).rejects.toThrow(/没有待保存的内容/)
    await expect(h.m.retry(info.id)).rejects.toThrow(/没有待保存的内容/)

    // 存盘成功之后 pending 同样是空的
    const t0 = Date.now()
    await h.watcher.save(info, 'b\n')
    await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')
    await expect(h.m.forceSave(info.id)).rejects.toThrow(/没有待保存的内容/)
    await expect(h.m.retry(info.id)).rejects.toThrow(/没有待保存的内容/)
  })

  // ---------------- 软链 ----------------

  it('软链：读写都落在 realpath 的真身上，软链本身还是软链', async () => {
    h.server.putFile('/etc/nginx/sites-available/site', 'server { }\n', 0o644)
    h.server.putLink('/etc/nginx/sites-enabled/site', '/etc/nginx/sites-available/site')

    const info = await h.m.open('s1', '/etc/nginx/sites-enabled/site')
    expect(info.remotePath).toBe('/etc/nginx/sites-enabled/site')
    expect(info.resolvedPath).toBe('/etc/nginx/sites-available/site')
    expect(readFileSync(info.localPath, 'utf8')).toBe('server { }\n')

    const t0 = Date.now()
    await h.watcher.save(info, 'server { listen 80; }\n')
    await waitInfo(h.events, info.id, savedAfter(t0), '存盘成功')

    // 真身被改，软链还是软链（rename 若打在软链上，这一条立刻报红）
    expect(h.server.contentOf('/etc/nginx/sites-available/site')).toBe('server { listen 80; }\n')
    expect(h.server.nodes.get('/etc/nginx/sites-enabled/site')?.link).toBe(
      '/etc/nginx/sites-available/site'
    )
    // 临时名必须落在真身所在的目录，不是软链所在的目录
    const renames = h.server.calls.filter((c) => c.startsWith('posix-rename'))
    expect(renames[0]).toMatch(
      /^posix-rename \/etc\/nginx\/sites-available\/\.site\.ofsedit-\w+ -> \/etc\/nginx\/sites-available\/site$/
    )
    expect(h.server.paths()).toEqual([
      '/etc/nginx/sites-available/site',
      '/etc/nginx/sites-enabled/site'
    ])
  })

  // ---------------- 闸门 ----------------

  it('超过 2MB 直接拒（stat 就拒，不下载）', async () => {
    h.server.putFile('/var/log/huge.log', Buffer.alloc(3 * 1024 * 1024, 0x41))
    await expect(h.m.open('s1', '/var/log/huge.log')).rejects.toThrow(/太大/)
    expect(h.m.list()).toEqual([])
    expect(h.server.calls.some((c) => c.startsWith('open '))).toBe(false)
  })

  it('含 NUL 的二进制文件拒绝编辑，且不留半个临时文件', async () => {
    h.server.putFile('/usr/bin/tool', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
    await expect(h.m.open('s1', '/usr/bin/tool')).rejects.toThrow(/二进制/)
    expect(h.m.list()).toEqual([])
    expect(await fsp.readdir(h.root)).toEqual([])
  })

  it('目录不能编辑', async () => {
    h.server.nodes.set('/etc', { content: null, link: null, mode: 0o040000 | 0o755, mtime: 1 })
    await expect(h.m.open('s1', '/etc')).rejects.toThrow(/目录/)
  })

  it('同时编辑超过 20 个就拒绝（第 21 条）', async () => {
    for (let i = 0; i < 21; i++) h.server.putFile(`/etc/c${i}.conf`, `x${i}\n`)
    for (let i = 0; i < 20; i++) await h.m.open('s1', `/etc/c${i}.conf`)
    await expect(h.m.open('s1', '/etc/c20.conf')).rejects.toThrow(/不能超过 20 个/)
    expect(h.m.list()).toHaveLength(20)
  })

  it('并发打开也守得住闸门（占位在 await 之前）', async () => {
    for (let i = 0; i < 25; i++) h.server.putFile(`/etc/c${i}.conf`, `x${i}\n`)
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => h.m.open('s1', `/etc/c${i}.conf`))
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20)
    expect(h.m.list()).toHaveLength(20)
  })

  it('本地存盘变成二进制（编辑器存成了 UTF-16）时拒绝写回', async () => {
    h.server.putFile('/etc/app.conf', 'a\n')
    const info = await h.m.open('s1', '/etc/app.conf')

    await h.watcher.save(info, 'a\0b')
    const err = await waitInfo(h.events, info.id, (i) => i.state === 'error', 'error')
    expect(err.message).toMatch(/NUL/)
    expect(h.server.contentOf('/etc/app.conf')).toBe('a\n')
  })

  // ---------------- 结束编辑 ----------------

  it('stop：关 watcher、删临时目录、广播 closed', async () => {
    h.server.putFile('/etc/app.conf', 'a\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    const dir = dirname(info.localPath)

    await h.m.stop(info.id)

    expect(h.m.list()).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(h.watcher.handles.every((w) => w.closed)).toBe(true)
    expect(h.events.some((e) => e.id === info.id && e.state === 'closed')).toBe(true)
  })

  it('stopBySession 只清该会话的编辑，临时目录一起删掉', async () => {
    h.server.putFile('/etc/a.conf', 'a\n')
    h.server.putFile('/etc/b.conf', 'b\n')
    const a = await h.m.open('s1', '/etc/a.conf')
    const b = await h.m.open('s1', '/etc/b.conf')
    const keep = await h.m.open('s2', '/etc/a.conf')

    await h.m.stopBySession('s1')

    expect(h.m.list().map((e) => e.id)).toEqual([keep.id])
    expect(existsSync(dirname(a.localPath))).toBe(false)
    expect(existsSync(dirname(b.localPath))).toBe(false)
    expect(existsSync(keep.localPath)).toBe(true)
    // 该会话的 watcher 都关了，留着的那条还活着
    const alive = h.watcher.handles.filter((w) => !w.closed)
    expect(alive.map((w) => w.path)).toEqual([keep.localPath])
  })

  it('停止后再触发存盘不会写远端（watcher 已关，且实现自己也不认已结束的编辑）', async () => {
    h.server.putFile('/etc/app.conf', 'a\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    const handle = h.watcher.handles[0]
    await h.m.stop(info.id)

    // 直接捅回调，模拟"关 watcher 那一刻正好有一个防抖窗口在飞"
    handle.onChanged(Buffer.from('zzz\n'), sha256Hex(Buffer.from('zzz\n')))
    await sleep(50)
    expect(h.server.contentOf('/etc/app.conf')).toBe('a\n')
  })

  /**
   * 取 SFTP、stat、重读比哈希每一步都可能几百毫秒，"停止编辑"完全可能落在中间。
   * 这条把闸门卡在 getSftp 上，模拟写回飞在半空时用户点了停止。
   */
  it('写回飞在半空时被停止 → 不许再往远端写，也不许再发状态复活列表', async () => {
    const server = new FakeServer()
    server.putFile('/etc/app.conf', 'old\n')
    const watcher = fakeWatch()
    const events: RemoteEditInfo[] = []
    // 闸门先建好再用：写成 let release = null 再在 executor 里赋值的话，
    // TS 会把 release 收窄成 null（它不知道 executor 是同步跑的）
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let sftpCalls = 0
    const m = createRemoteEditManager({
      getSftp: async () => {
        // 第一次（打开）直接给，第二次（写回）卡住等测试放行
        sftpCalls += 1
        if (sftpCalls === 2) await gate
        return server.sftp
      },
      openEditor: async () => {},
      tempRoot: () => h.root,
      watch: watcher.watch
    })
    m.onState((info) => events.push(info))

    const info = await m.open('s1', '/etc/app.conf')
    await watcher.save(info, 'new\n')
    await waitInfo(events, info.id, (i) => i.state === 'uploading', 'uploading')

    await m.stop(info.id)
    const afterStop = events.length
    release()
    await sleep(80)

    expect(server.contentOf('/etc/app.conf')).toBe('old\n')
    expect(server.calls.filter((c) => c.startsWith('posix-rename'))).toEqual([])
    // closed 之后一个事件都不该再有
    expect(events.slice(afterStop)).toEqual([])
    expect(m.list()).toEqual([])
  })

  /**
   * 上一条钉的是"不再写"，这条钉的是"不再发事件"。
   * 会话断开时 sshManager.get 会抛"会话不存在或已关闭"，写回于是从 getSftp 就失败 ——
   * 那个 error 状态要是照样播出去，界面会凭空复活一行（临时文件早删了，点什么都是错）。
   */
  it('停止后在途写回失败 → 不许再播 error 状态', async () => {
    const server = new FakeServer()
    server.putFile('/etc/app.conf', 'old\n')
    const watcher = fakeWatch()
    const events: RemoteEditInfo[] = []
    let fail = (_err: Error): void => {}
    const gate = new Promise<void>((_resolve, reject) => {
      fail = reject
    })
    let sftpCalls = 0
    const m = createRemoteEditManager({
      getSftp: async () => {
        sftpCalls += 1
        if (sftpCalls === 2) await gate
        return server.sftp
      },
      openEditor: async () => {},
      tempRoot: () => h.root,
      watch: watcher.watch
    })
    m.onState((info) => events.push(info))

    const info = await m.open('s1', '/etc/app.conf')
    await watcher.save(info, 'new\n')
    await waitInfo(events, info.id, (i) => i.state === 'uploading', 'uploading')

    await m.stop(info.id)
    expect(events[events.length - 1].state).toBe('closed')
    const afterStop = events.length
    fail(new Error('会话不存在或已关闭'))
    await sleep(80)

    expect(events.slice(afterStop)).toEqual([])
    expect(server.contentOf('/etc/app.conf')).toBe('old\n')
  })

  it('forceSave / retry 对已结束的编辑要报错，不能默默无事发生', async () => {
    h.server.putFile('/etc/app.conf', 'a\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    await h.m.stop(info.id)
    await expect(h.m.forceSave(info.id)).rejects.toThrow(/已结束/)
    await expect(h.m.retry(info.id)).rejects.toThrow(/已结束/)
  })

  /**
   * 这三个入口由接线层在多处挂钩（会话关闭、窗口关闭、app quit），
   * 同一条编辑被停两遍是常态，幂等是硬要求 —— 重复的 closed 会让界面反复删同一行。
   */
  it('stop / stopBySession / stopAll 可以重复调，closed 只发一次', async () => {
    h.server.putFile('/etc/a.conf', 'a\n')
    const info = await h.m.open('s1', '/etc/a.conf')
    const dir = dirname(info.localPath)

    await h.m.stop(info.id)
    await h.m.stop(info.id)
    await h.m.stopBySession('s1')
    await h.m.stopAll()
    await h.m.stopAll()

    expect(h.events.filter((e) => e.id === info.id && e.state === 'closed')).toHaveLength(1)
    expect(existsSync(dir)).toBe(false)
    expect(h.m.list()).toEqual([])
    // stopAll 顺手把本进程那个临时根也收了：里面全是远端文件的明文副本
    expect(readdirSync(h.root)).toEqual([])
  })

  // ---------------- 临时根 ----------------

  /**
   * 固定名（曾经的 'openfinalshell-edit'）在 Linux 上是个能被同机非特权用户利用的洞：
   * app.getPath('temp') 就是全局可写的 /tmp，攻击者在受害者第一次编辑前
   * `mkdir -m 777 /tmp/openfinalshell-edit` 就把父目录占住了 —— 之后 <hash> 子目录
   * 他不需要预测（父目录可列可写，换成软链即可），受害者用 root 编辑 /etc 下的文件时
   * 明文副本就落到他选的路径上。mkdtemp 把"名字可预测"和"复用别人建好的目录"一起堵掉。
   */
  it('临时根是进程内一次性 mkdtemp 出来的随机目录，不是固定名', async () => {
    h.server.putFile('/etc/a.conf', 'a\n')
    h.server.putFile('/etc/b.conf', 'b\n')
    const a = await h.m.open('s1', '/etc/a.conf')
    const b = await h.m.open('s1', '/etc/b.conf')

    const roots = readdirSync(h.root)
    expect(roots).toHaveLength(1)
    expect(roots[0]).not.toBe('openfinalshell-edit')
    expect(roots[0]).toMatch(/^ofs-edit-.{6,}$/)
    // 两条编辑共用同一个根（<hash> 子目录仍按 tempRelPath 派生）
    const root = realpathSync.native(join(h.root, roots[0]))
    expect(dirname(dirname(a.localPath))).toBe(root)
    expect(dirname(dirname(b.localPath))).toBe(root)
    // mkdtemp 天然 0700（Windows 上 mode 位没意义，跳过）
    if (process.platform !== 'win32') expect(statSync(root).mode & 0o777).toBe(0o700)

    // 同一个 tempRoot 下的另一个实例各建各的根：名字随机，抢占无从下手
    const other = createRemoteEditManager({
      getSftp: async () => h.server.sftp,
      openEditor: async () => {},
      tempRoot: () => h.root,
      watch: fakeWatch().watch
    })
    await other.open('s1', '/etc/a.conf')
    expect(readdirSync(h.root)).toHaveLength(2)
    await other.stopAll()
  })

  it('purgeStaleTempDirs 清掉上次崩溃留下的临时根，但不碰自己正在用的那个', async () => {
    // 上次进程崩掉时留下的残留：里面躺着的是远端文件的明文副本
    const stale = join(h.root, 'ofs-edit-oldrun')
    mkdirSync(join(stale, 'deadbeefdeadbeef'), { recursive: true })
    writeFileSync(join(stale, 'deadbeefdeadbeef', 'shadow'), 'root:$6$dont-keep-me\n')
    // 不是我们建的目录一律不许动（%TEMP% 是公共场所）
    const alien = join(h.root, 'someone-else')
    mkdirSync(alien)

    h.server.putFile('/etc/app.conf', 'a\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    await h.m.purgeStaleTempDirs()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(alien)).toBe(true)
    // 自己那个根一个字节都不能少，否则正在编辑的文件当场消失
    expect(existsSync(info.localPath)).toBe(true)
    expect(h.m.list()).toHaveLength(1)
  })

  it('启动时（自己的根还没建）purge 把全部 ofs-edit-* 残留清掉', async () => {
    const stale = join(h.root, 'ofs-edit-crashed')
    mkdirSync(stale, { recursive: true })
    await h.m.purgeStaleTempDirs()
    expect(existsSync(stale)).toBe(false)
  })

  /**
   * **按真实顺序**：purge 在 src/main/index.ts 里跑在任何一次编辑**之前**。
   * 上一轮那条用例是先 open 再 purge，于是 tempRootName 已经有值、自保分支看着是好的 ——
   * 而生产里那一刻它还是 null，`name !== null` 对所有目录都成立，自保分支等于不存在。
   *
   * 后果不是"多删一个空目录"：同账号下第二个实例是真会有的（--user-data-dir、改过
   * app name 的开发运行都绕开单实例锁），它启动时就把第一个实例**正在编辑的**临时目录
   * 整棵删掉 —— 用户还没存的改动静默消失，watcher 耗完重试预算放手，界面仍显示 editing。
   */
  it('另一个实例启动时 purge（先 purge 再 open 的真实顺序）不许碰活着的实例正在编辑的目录', async () => {
    // 实例 A：正在编辑，临时根里躺着远端文件的明文副本
    h.server.putFile('/etc/app.conf', 'listen 80;\n')
    const info = await h.m.open('s1', '/etc/app.conf')
    const aRoot = dirname(dirname(info.localPath))

    // 实例 B 启动：它自己一次编辑都还没有，purge 是它做的第一件事
    const b = createRemoteEditManager({
      getSftp: async () => h.server.sftp,
      openEditor: async () => {},
      tempRoot: () => h.root,
      watch: fakeWatch().watch
    })
    await b.purgeStaleTempDirs()

    expect(existsSync(aRoot)).toBe(true)
    expect(existsSync(info.localPath)).toBe(true)
    expect(readFileSync(info.localPath, 'utf8')).toBe('listen 80;\n')
    // B 自己那个根也建出来了（purge 前的 ensureTempRoot），两个实例各占一个
    expect(readdirSync(h.root).filter((n) => n.startsWith('ofs-edit-'))).toHaveLength(2)
    await b.stopAll()
  })

  /**
   * 判活靠的必须是**进程归属**而不是名字：名字只认得出"这是不是我自己的根"，
   * 认不出"这是不是另一个还活着的实例的根"。
   * 三种归属各钉一条：活 pid（跳过）、已死 pid（删）、没有 pid 文件（删 —— 旧版本留下的、
   * 或者写 pid 那一下失败过的根，无从证明有主，而这函数存在的理由就是清掉那份明文副本）。
   */
  it('purge 靠 pid 判活：活 pid 的根跳过，死 pid / 无 pid 文件的根照删', async () => {
    const live = join(h.root, 'ofs-edit-liveinst')
    mkdirSync(join(live, 'aaaabbbbccccdddd'), { recursive: true })
    writeFileSync(join(live, '.ofs-owner'), String(process.pid))
    writeFileSync(join(live, 'aaaabbbbccccdddd', 'shadow'), 'root:$6$still-editing\n')

    const dead = join(h.root, 'ofs-edit-deadinst')
    mkdirSync(dead, { recursive: true })
    writeFileSync(join(dead, '.ofs-owner'), String(deadPid()))

    const nameless = join(h.root, 'ofs-edit-nopid')
    mkdirSync(join(nameless, 'eeeeffff00001111'), { recursive: true })
    writeFileSync(join(nameless, 'eeeeffff00001111', 'id_rsa'), '-----BEGIN…\n')

    const garbage = join(h.root, 'ofs-edit-garbagepid')
    mkdirSync(garbage, { recursive: true })
    // 坏 pid 文件不许被当成"活着"：pid ≤ 0 在 kill 里是"整个进程组"，那必然探到活的
    writeFileSync(join(garbage, '.ofs-owner'), '0\n')

    await h.m.purgeStaleTempDirs()

    expect(existsSync(live)).toBe(true)
    expect(existsSync(join(live, 'aaaabbbbccccdddd', 'shadow'))).toBe(true)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(nameless)).toBe(false)
    expect(existsSync(garbage)).toBe(false)
  })

  /**
   * 临时根被外力删掉（另一个实例的 purge、systemd-tmpfiles、用户手动清 /tmp）之后，
   * 下一次编辑的 recursive mkdir 会把根**和** <hash> 子目录一起建出来 ——
   * 不带 mode 就丢掉 mkdtemp 那个 0700，同机其他用户能列目录拿到远端 basename
   * （shadow、id_rsa、prod.env 这种名字本身就是情报）。
   * mode 位在 Windows 上没有意义，那半条断言只在 POSIX 上跑。
   */
  it('临时根被外力删掉后重建仍然是 0700（recursive mkdir 必须显式带 mode）', async () => {
    h.server.putFile('/etc/a.conf', 'a\n')
    h.server.putFile('/etc/shadow', 'root:$6$x\n')
    const first = await h.m.open('s1', '/etc/a.conf')
    const root = dirname(dirname(first.localPath))

    // 外力：整棵删掉（另一个实例的 purge 就是这个效果）
    rmSync(root, { recursive: true, force: true })
    const second = await h.m.open('s1', '/etc/shadow')

    expect(dirname(dirname(second.localPath))).toBe(root)
    expect(readFileSync(second.localPath, 'utf8')).toBe('root:$6$x\n')
    if (process.platform !== 'win32') expect(statSync(root).mode & 0o777).toBe(0o700)
  })

  // ---------------- 起编辑器之前的用时校验 ----------------

  /**
   * spawn 的是**可执行文件本身**，不是参数 —— 写入侧的校验（sftp:pickEditor）管不到
   * 已经躺在库里的值：老版本写下的、导入的配置文件带来的、有人手改 SQLite 的，全都绕过它。
   * 所以每次 spawn 之前都要再看一眼（也刻意不缓存：exe 可以在两次存盘之间被换掉）。
   *
   * 两条都要钉：校验没过时 **1)** 一次都不许 spawn，**2)** 不许静默退化成系统默认打开 ——
   * 退化会让用户以为编辑器配置生效了。而失败必须让界面看得见：原先只有 log.warn，
   * 界面照旧显示"已开始编辑"，用户无从知道那个 exe 根本没被起来。
   */
  it('编辑器路径校验不过 → 一次都不 spawn、不退化成系统默认打开，且界面收到带原因的提示', async () => {
    const spawned: Array<{ exe: string; args: string[] }> = []
    const systemOpened: string[] = []
    const watcher = fakeWatch()
    const events: RemoteEditInfo[] = []
    const evil = 'C:\\Users\\demo\\Downloads\\payload.exe'
    const m = createRemoteEditManager({
      getSftp: async () => h.server.sftp,
      tempRoot: () => h.root,
      watch: watcher.watch,
      // 生产路径就是这一句：openEditor 取设置里的 exe 交给 launchEditor
      openEditor: (absPath) =>
        launchEditor(absPath, evil, {
          assertUsable: async (exe) => {
            throw new Error(`选中的文件不存在或不可读：${exe}`)
          },
          spawnEditor: (exe, args) => {
            spawned.push({ exe, args })
          },
          openWithSystem: async (p) => {
            systemOpened.push(p)
          }
        })
    })
    m.onState((info) => events.push(info))

    h.server.putFile('/etc/app.conf', 'a\n')
    const info = await m.open('s1', '/etc/app.conf')

    const warned = await waitInfo(
      events,
      info.id,
      (i) => (i.message ?? '').includes(evil),
      '编辑器启动失败的可见提示'
    )
    // 编辑本身没坏（文件已落地、watcher 还盯着），所以状态还是 editing，只是挂了一句人话
    expect(warned.state).toBe('editing')
    expect(warned.message).toMatch(/编辑器/)
    expect(spawned).toEqual([])
    expect(systemOpened).toEqual([])
    // 打开照样成功：编辑器起不来不该让整条编辑失败
    expect(m.list()).toHaveLength(1)
    await m.stopAll()
  })

  it('校验通过才 spawn，且参数只有那一个本地路径（不拼命令行、不走 shell）', async () => {
    const exe = 'C:\\Program Files\\Editor\\ed.exe'
    const checked: string[] = []
    const spawned: string[][] = []
    await launchEditor('C:\\tmp\\ofs\\app.conf', exe, {
      assertUsable: async (p) => {
        checked.push(p)
      },
      spawnEditor: (file, args) => {
        spawned.push([file, ...args])
      },
      openWithSystem: async () => {
        throw new Error('配了 exe 就不该走系统默认打开')
      }
    })
    expect(checked).toEqual([exe])
    expect(spawned).toEqual([[exe, 'C:\\tmp\\ofs\\app.conf']])
  })

  /**
   * 空串在本项目里是**合法语义**（"交给系统默认打开方式"），而 assertUsableEditor 会把 ''
   * 判成"非绝对路径"直接拒 —— 所以必须先判空再调校验。反了的话，没配编辑器的用户
   * （默认就是这样）每次编辑都会收到一句"编辑器必须是绝对路径"，文件根本打不开。
   */
  it('exePath 为空串 → 走系统默认打开，且一次校验都不调', async () => {
    const checked: string[] = []
    const opened: string[] = []
    await launchEditor('C:\\tmp\\ofs\\app.conf', '', {
      assertUsable: async (p) => {
        checked.push(p)
      },
      spawnEditor: () => {
        throw new Error('没配 exe 时不该起进程')
      },
      openWithSystem: async (p) => {
        opened.push(p)
      }
    })
    expect(checked).toEqual([])
    expect(opened).toEqual(['C:\\tmp\\ofs\\app.conf'])
  })
})

/**
 * 上面所有存盘用例都是手捅回调，这一条用**真** localFileWatch 跑完整链路：
 * 改本地落地文件 → watcher 发现 → 写回远端。少了它，"watcher 接线接错了"
 * （比如 initialSha256 传错、回调里忘了 await）在整套用例里都是绿的。
 */
describe('RemoteEditManager 与真 watcher 的接线', () => {
  let root: string
  let manager: RemoteEditManager | null = null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ofs-edit-live-'))
  })

  afterEach(async () => {
    await manager?.stopAll()
    manager = null
    rmSync(root, { recursive: true, force: true })
  })

  it('改动落地文件后远端被写回（默认 watch 实现）', async () => {
    const server = new FakeServer()
    server.putFile('/etc/live.conf', 'before\n')
    const m = createRemoteEditManager({
      getSftp: async () => server.sftp,
      openEditor: async () => {},
      tempRoot: () => root
      // watch 不覆盖：这里要的就是真 localFileWatch
    })
    manager = m
    const info = await m.open('s1', '/etc/live.conf')

    writeFileSync(info.localPath, 'after\n')
    const deadline = Date.now() + 8000
    while (server.contentOf('/etc/live.conf') !== 'after\n' && Date.now() < deadline) {
      await sleep(25)
    }
    expect(server.contentOf('/etc/live.conf')).toBe('after\n')
    expect(server.calls.filter((c) => c.startsWith('posix-rename'))).toHaveLength(1)
  })
})
