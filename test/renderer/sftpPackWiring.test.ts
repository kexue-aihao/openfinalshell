import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { blockAfter, flat, read, stripComments } from '../sourceGuard'

/**
 * 打包下载这一片的护栏。挑的每一处都是"错了不抛异常、不影响编译，只是静默走偏"：
 *
 *  1. 打包分支必须排在 `expandIfDirectory` **之前** —— 排后面的话它永远轮不到，
 *     而功能看起来"开了但没效果"，没有任何报错；
 *  2. 降级必须**可解释**（原因落进 task.notice）；判定本身出错不许把传输带下去；
 *  3. 清场必须在 `finally` 里 —— 失败时远端 /tmp 与本机 %TEMP% 各留一份大文件；
 *  4. `child_process` 只许 localTar.ts 用（这是主进程**新增**的能力，本项目此前一处都没用过）；
 *  5. 启动清扫必须有调用点，且排在单实例锁之后；
 *  6. 界面必须真的把阶段名与 notice 显示出来（main 发了、界面没接 = 用户什么都看不到）。
 */

const TQ = 'src/main/sftp/TransferQueue.ts'
const PT = 'src/main/sftp/packTransfer.ts'
const LT = 'src/main/sftp/localTar.ts'
const LIST = 'src/renderer/src/features/transfers/TransferList.tsx'
const PANE = 'src/renderer/src/features/sftp/SftpPane.tsx'

describe('队列接入点', () => {
  const src = stripComments(read(TQ))
  const start = blockAfter(src, 'private async start(')

  /** 展开正是打包要替代的那一步；排它后面等于永远轮不到 */
  it('打包分支排在 expandIfDirectory 之前，且条件没被短路掉', () => {
    const packAt = start.indexOf('tryPackedDownload')
    const expandAt = start.indexOf('expandIfDirectory')
    expect(packAt).toBeGreaterThan(0)
    expect(expandAt).toBeGreaterThan(0)
    expect(packAt).toBeLessThan(expandAt)
    /*
     * 顺序对了还不够：`if (false && await this.tryPackedDownload(...))` 的文本顺序
     * 一模一样，但那个分支永远进不去 —— 功能看起来"开了没效果"且没有任何报错。
     * 所以这里精确比对整个条件。
     */
    expect(flat(start)).toContain('if (await this.tryPackedDownload(entry, conn, sftp)) {')
  })

  it('打包分支排在 acquireTransferSftp 之后（exec 要搭在那条连接上）', () => {
    expect(start.indexOf('acquireTransferSftp')).toBeLessThan(start.indexOf('tryPackedDownload'))
  })

  const tryPack = blockAfter(src, 'private async tryPackedDownload(')

  it('只对下载生效，且受设置开关约束', () => {
    const body = flat(tryPack)
    expect(body).toContain("task.kind !== 'download'")
    expect(body).toContain('getSettings().sftp.packedTransfer')
  })

  it('单个文件不打包（省不出往返，只多两次 tar）', () => {
    expect(flat(tryPack)).toContain('if (!info.isDir) return false')
  })

  it('判定不成立时把原因写进 notice —— 降级必须是可解释的', () => {
    const body = flat(tryPack)
    expect(body).toContain('task.notice = decision.reason')
    expect(body).toContain('return false')
  })

  /** 判定本身出错（探测超时、通道开不出来）绝不能把这次传输带下去 */
  it('判定出错时退回逐文件，而不是让任务失败', () => {
    expect(flat(tryPack)).toContain('.catch(')
    expect(flat(tryPack)).toContain('pack: false')
  })

  it('走的是传输连接上的 exec（不跟终端抢主连接的通道）', () => {
    expect(flat(tryPack)).toContain('conn.transferExecTarget()')
  })
})

describe('下载落地名过 sanitizeLocalName（修的是既有 bug）', () => {
  const src = stripComments(read(TQ))

  it('enqueue 里对 download 的 localPath 做 sanitize', () => {
    expect(flat(blockAfter(src, 'enqueue(items:'))).toContain('sanitizeDownloadPath(item.localPath)')
  })

  it('sanitizeDownloadPath 只改最后一段（不许把整条路径搅了）', () => {
    const fn = flat(blockAfter(src, 'function sanitizeDownloadPath('))
    expect(fn).toContain('basename(p)')
    expect(fn).toContain('sanitizeLocalName(base)')
    expect(fn).toContain('dirname(p)')
  })

  /** 上传的 localPath 是真实存在的本地路径，动它就找不到源文件了 */
  it('上传方向不动 localPath', () => {
    expect(flat(blockAfter(src, 'enqueue(items:'))).toContain(
      "item.kind === 'download' ? sanitizeDownloadPath(item.localPath) : item.localPath"
    )
  })
})

describe('清场', () => {
  const src = stripComments(read(PT))

  it('远端临时包与本地临时 tar 都在 finally 里清（失败路径也要清）', () => {
    // 锚在那个 async IIFE 上，**不能**锚 `export function runPackedDownload(` ——
    // 它后面第一个 `{` 是返回类型标注 `{ promise; handle }`，blockAfter 会取到那个
    const run = blockAfter(src, 'const promise = (async ()')
    const finallyAt = run.indexOf('} finally {')
    expect(finallyAt).toBeGreaterThan(0)
    const tail = run.slice(finallyAt)
    expect(tail).toContain('sftpUnlink(')
    expect(tail).toContain('fs.rm(')
  })

  /** 用 SFTP unlink 而不是再发一条 rm：传输句柄现成，少一条 shell 命令 */
  it('远端清场走 SFTP unlink，不再发 shell 命令', () => {
    expect(src).toContain('sftpUnlink(')
    expect(src).not.toMatch(/rm -f .*\$\{/)
  })

  it('启动时清扫 %TEMP%/ofs-pack，且排在单实例锁之后', () => {
    const main = stripComments(read('src/main/index.ts'))
    expect(main).toContain('packTempDir()')
    // requestSingleInstanceLock 的 else 分支里 —— 否则第二个实例会删掉第一个正在传的包
    expect(main.indexOf('requestSingleInstanceLock')).toBeLessThan(main.indexOf('packTempDir()'))
    expect(flat(main)).toContain('rm(packTempDir(), { recursive: true, force: true })')
  })

  it('会话关闭时清掉探测缓存', () => {
    const mgr = stripComments(read('src/main/ssh/SshConnectionManager.ts'))
    expect(blockAfter(mgr, 'close(sessionId: SessionId)')).toContain('clearProbeCache(sessionId)')
  })
})

describe('child_process 的用处清单', () => {
  /**
   * 起子进程这件事在本项目里是**逐个批准**的，不是随便用的能力。现在有两处：
   * `localTar.ts` 调 System32 的 bsdtar 列/解归档，`directLatency.ts` 调系统 ping 测 ICMP RTT。
   *
   * 曾经还有 `RemoteEditManager.ts`（起用户指定的那个外部编辑器 exe）——
   * 外部编辑器整条路删掉之后它也没了，之后新增的每一处都必须在这里说明风险边界。
   * 那一处的风险面是最麻烦的一类：被执行的 exe 路径来自设置，而设置有两个外来入口。
   *
   * 这条用例是**清单**而不是"只许一处"：多一处就多一个"命令串怎么拼"的风险面，
   * 所以要让新增者被迫改这张表、连带在评审里解释一句。
   */
  const DL = 'src/main/monitor/directLatency.ts'

  it('src/main 下引用 child_process 的文件必须全部在清单中', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.ts$/.test(name)) {
          const src = stripComments(read(p))
          if (/child_process/.test(src)) offenders.push(p.replace(/\\/g, '/'))
        }
      }
    }
    walk('src/main')
    expect(offenders).toEqual([DL, LT])
  })

  it('直连 Ping 使用系统绝对路径与 argv，且不经过 shell', () => {
    const src = stripComments(read(DL))
    expect(src).toContain("import { spawn } from 'node:child_process'")
    expect(src).toContain("join(systemRoot, 'System32', 'PING.EXE')")
    expect(src).toContain("command: '/bin/ping'")
    expect(src).toContain('shell: false')
    expect(src).not.toContain('windowsVerbatimArguments')
    expect(src).not.toMatch(/\bexecSync\b|\bexecFile\b/)
  })

  it('localTar 里一律 shell: false，且不用 exec / windowsVerbatimArguments', () => {
    const src = stripComments(read(LT))
    expect(src).toContain('shell: false')
    expect(src).not.toContain('windowsVerbatimArguments')
    expect(src).not.toMatch(/\bexecSync\b|\bexecFile\b|[^n]\bexec\(/)
  })

  /** 走 PATH 会命中 Git 的 MSYS tar（GNU tar，会做路径改写），不是 System32 的 bsdtar */
  it('tar 用绝对路径定位，绝不走 PATH', () => {
    const fn = flat(blockAfter(stripComments(read(LT)), 'export function findLocalTar('))
    expect(fn).toContain('process.env.SystemRoot')
    expect(fn).toContain('existsSync')
    expect(fn).not.toContain('process.env.PATH')
  })

  it('解包不传 -p，也绝不传 -P/--absolute-paths', () => {
    const src = stripComments(read(LT))
    const extract = flat(blockAfter(src, 'export async function extractTar('))
    expect(extract).toContain("['-x', '-f', archive, '-C', destDir]")
    expect(extract).not.toContain("'-p'")
    expect(extract).not.toContain("'-P'")
    expect(extract).not.toContain('absolute-paths')
  })

  /**
   * 真机撞出来的：远端 GNU tar 的包里成员名是原始 UTF-8 字节，而 ustar 没地方声明编码，
   * bsdtar 在 Windows 上按 ANSI 代码页解释 → 每个非 ASCII 成员都报 `Invalid empty pathname`。
   * 少了这个选项，打包下载对中文文件名**整个不可用**。
   */
  it('列成员与解包都带 hdrcharset=UTF-8', () => {
    const src = stripComments(read(LT))
    expect(src).toContain("'--options', 'hdrcharset=UTF-8'")
    for (const marker of ['export async function listTarEntries(', 'export async function extractTar(']) {
      expect(flat(blockAfter(src, marker)), marker).toContain('runTar(')
    }
    // runTar 是唯一插入该选项的地方 —— 绕过它直接 run() 就等于绕过这道修复
    expect(flat(blockAfter(src, 'async function runTar('))).toContain('UTF8_OPTS')
  })
})

describe('远端命令只用 POSIX 交集', () => {
  const src = stripComments(read(PT))

  it('打包与探测都不用长选项（BusyBox 认不全）', () => {
    for (const marker of ['export function buildPackCommand(', 'export function buildProbeScript(']) {
      const body = blockAfter(src, marker)
      // `--version` 是探测里唯一的长选项，且它本来就是用来试探的
      const longOpts = [...body.matchAll(/--[a-z][a-z-]+/g)].map((m) => m[0])
      expect(longOpts.filter((o) => o !== '--version'), marker).toEqual([])
    }
  })

  it('不做 gzip（下载方向等于拿生产服务器的 CPU 换钱）', () => {
    expect(src).not.toContain('gzip')
    expect(src).not.toMatch(/'-z'|-z /)
  })

  it('临时文件名必须由 mktemp 生成（固定名是 /tmp 里的软链攻击靶子）', () => {
    expect(flat(blockAfter(src, 'export function buildPackCommand('))).toContain('mktemp')
  })
})

describe('界面：阶段与说明要看得见', () => {
  const list = stripComments(read(LIST))

  it('有阶段时显示阶段名代替状态名', () => {
    expect(flat(list)).toContain('task.phase && task.state ===')
    expect(flat(list)).toContain('PHASE_KEY[task.phase]')
  })

  it('五个阶段都有文案，一个不落', () => {
    for (const phase of ['scanning', 'packing', 'transferring', 'extracting', 'cleanup']) {
      expect(list, phase).toContain(`${phase}: 'transfer.phase`)
    }
  })

  /*
   * notice 与 error 现在共用一行（行高是定值，撑不出第二行来），靠 `aside` 二选一：
   * error 优先、样式按来源分。要守住的还是同一件事 —— notice 必须有出口，
   * 而且**不能被涂成红色报错**（"已改用逐文件传输"是说明，不是错误）。
   */
  it('notice 有出口，且不当成错误标红', () => {
    const body = flat(list)
    expect(body).toContain('const aside = task.error ?? task.notice')
    expect(body).toContain('{aside && (')
    expect(body).toContain('task.error ? styles.itemError : styles.itemNotice')
  })

  /** 打包/解包期间进度真的未知 —— 停在上次百分比，由阶段名承载含义，不许编 */
  it('没有为打包/解包编造百分比', () => {
    expect(flat(list)).not.toMatch(/phase === 'packing' \? \d/)
    expect(flat(list)).not.toMatch(/phase === 'extracting' \? \d/)
  })
})

describe('界面：勾选项与设置', () => {
  const pane = stripComments(read(PANE))

  it('菜单里的打包传输是勾选项，切换写全局设置', () => {
    const items = flat(blockAfter(pane, 'const contextItems ='))
    expect(items).toContain("key: 'packedTransfer'")
    expect(items).toContain('settings.sftp.packedTransfer ?')
    expect(flat(blockAfter(pane, 'const onContextClick ='))).toContain(
      'packedTransfer: !settings.sftp.packedTransfer'
    )
  })

  it('设置页也有一份（可发现性 + 放解释文案）', () => {
    const settings = stripComments(read('src/renderer/src/features/settings/SettingsModal.tsx'))
    expect(flat(settings)).toContain("t('settings.packedTransfer')")
    expect(flat(settings)).toContain("hint={t('settings.packedTransferHint')}")
  })

  it('默认关（要在远端建临时文件、本地起子进程，先让愿意的人显式打开）', () => {
    expect(DEFAULT_SETTINGS.sftp.packedTransfer).toBe(false)
  })

  /** 下载目录的分隔符从它自己看出来 —— 硬编码反斜杠在 POSIX 宿主上会拼出带 `\` 的文件名 */
  it('拼本地下载路径时不硬编码反斜杠', () => {
    const download = flat(blockAfter(pane, 'const download = async'))
    expect(download).toContain("includes('\\\\') ? '\\\\' : '/'")
  })
})
