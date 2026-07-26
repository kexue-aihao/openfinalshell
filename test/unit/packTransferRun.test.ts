import { execFileSync } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferPhase, TransferTask } from '../../src/shared/types'
import { findLocalTar } from '../../src/main/sftp/localTar'
import { runPackedDownload } from '../../src/main/sftp/packTransfer'
import { toRemotePath } from '../../src/main/sftp/remotePath'

/**
 * 打包下载的**编排**。这一层做的判断全是"错了不会抛，只会静默出错"的那种：
 * 该拒的归档拒没拒、临时文件清没清、tar 退 1 当没当成失败、阶段有没有按顺序发出来。
 *
 * 远端那三件事（exec、stat、unlink）打桩，本地 tar 用**真的**（归档也是真造的）——
 * 于是"校验 + 解包"这段走的是生产代码，而不是又一份重实现。
 */

const stub = vi.hoisted(() => ({
  /** execOnce 的返回队列（按调用顺序取） */
  execResults: [] as Array<{ stdout: string; stderr: string; code: number | null }>,
  execScripts: [] as string[],
  statSize: { exists: true, isDir: false, size: 0 } as {
    exists: boolean
    isDir: boolean
    size: number
  },
  unlinked: [] as string[],
  /** 传输阶段把这个文件复制到 task.localPath，模拟"归档下载完了" */
  prepared: '',
  transferThrows: null as Error | null
}))

vi.mock('../../src/main/ssh/ExecRunner', () => ({
  execOnce: (_conn: unknown, script: string) => {
    stub.execScripts.push(script)
    const r = stub.execResults.shift() ?? { stdout: '', stderr: '', code: 0 }
    return Promise.resolve({ ...r, truncated: false })
  }
}))

vi.mock('../../src/main/sftp/SftpManager', () => ({
  statSize: () => Promise.resolve(stub.statSize)
}))

vi.mock('../../src/main/sftp/sftpLowLevel', () => ({
  sftpUnlink: (_sftp: unknown, path: string) => {
    stub.unlinked.push(String(path))
    return Promise.resolve()
  }
}))

vi.mock('../../src/main/sftp/TransferWorker', async (importOriginal) => {
  // TransferAborted 那个类必须是真的：packTransfer 会 throw/instanceof 它
  const actual = await importOriginal<typeof import('../../src/main/sftp/TransferWorker')>()
  return {
    ...actual,
    runTransfer: (opts: { task: TransferTask }) => ({
      handle: { pause: () => {}, cancel: () => {} },
      promise: (async () => {
        if (stub.transferThrows) throw stub.transferThrows
        await copyFile(stub.prepared, opts.task.localPath)
      })()
    })
  }
})

const TAR = findLocalTar()
const root = mkdtempSync(join(tmpdir(), 'ofs-packrun-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个真归档，顶层项名为 top */
function makeArchive(name: string, top: string, extra?: () => void): string {
  const base = join(root, `src-${name}`)
  mkdirSync(join(base, top, 'sub'), { recursive: true })
  writeFileSync(join(base, top, 'a.txt'), 'hello\n', 'utf8')
  writeFileSync(join(base, top, 'sub', 'b.txt'), 'world\n', 'utf8')
  extra?.()
  const archive = join(root, `${name}.tar`)
  execFileSync(TAR as string, ['-c', '-f', archive, '-C', base, '--', top])
  return archive
}

interface RunOutcome {
  phases: TransferPhase[]
  notices: string[]
  task: TransferTask
  destDir: string
  localTmpDir: string
  error: Error | null
}

async function run(label: string, top = 'app'): Promise<RunOutcome> {
  const destDir = join(root, `dest-${label}`)
  const localTmpDir = join(root, `tmp-${label}`)
  mkdirSync(destDir, { recursive: true })
  const task: TransferTask = {
    id: `task-${label}`,
    sessionId: 'sess',
    kind: 'download',
    localPath: join(destDir, top),
    remotePath: '/data/app',
    size: -1,
    transferred: 0,
    state: 'running',
    speedBps: 0,
    createdAt: 0
  }
  const phases: TransferPhase[] = []
  const notices: string[] = []
  let error: Error | null = null
  try {
    await runPackedDownload({
      conn: { execChannel: () => Promise.reject(new Error('不该开通道')) },
      sftp: {} as SFTPWrapper,
      task,
      tmpBase: toRemotePath('/tmp'),
      sizeKb: 10,
      localTmpDir,
      onProgress: () => {},
      onPhase: (phase, notice) => {
        phases.push(phase)
        if (notice) notices.push(notice)
      }
    }).promise
  } catch (err) {
    error = err as Error
  }
  return { phases, notices, task, destDir, localTmpDir, error }
}

/** 让 execOnce 的第一次调用（打包）回一个成功结果 */
function packOk(tarRc = 0): void {
  stub.execResults.push({
    stdout: `OFSP:PATH /tmp/ofs-pack.AbCd1234\nOFSP:RC ${tarRc}\n`,
    stderr: '',
    code: 0
  })
}

beforeEach(() => {
  stub.execResults.length = 0
  stub.execScripts.length = 0
  stub.unlinked.length = 0
  stub.transferThrows = null
  stub.statSize = { exists: true, isDir: false, size: 1024 }
})

describe.skipIf(TAR === null)('runPackedDownload：顺利那一趟', () => {
  it('打包 → 传输 → 解包 → 清理，文件真的落地', async () => {
    stub.prepared = makeArchive('happy', 'app')
    packOk()
    const r = await run('happy')

    expect(r.error).toBe(null)
    expect(r.phases).toEqual(['packing', 'transferring', 'extracting', 'cleanup'])
    expect(readFileSync(join(r.destDir, 'app', 'a.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(r.destDir, 'app', 'sub', 'b.txt'), 'utf8')).toBe('world\n')
    // task.size 来自 stat 而不是猜的
    expect(r.task.size).toBe(1024)
    expect(r.task.transferred).toBe(1024)
  })

  it('远端临时包用 SFTP unlink 清掉，本地临时 tar 也删了', async () => {
    stub.prepared = makeArchive('cleanup', 'app')
    packOk()
    const r = await run('cleanup')

    expect(stub.unlinked).toEqual(['/tmp/ofs-pack.AbCd1234'])
    expect(existsSync(join(r.localTmpDir, 'task-cleanup.tar'))).toBe(false)
  })

  /**
   * **GNU tar 退 1 不是失败**（0 正常 / 1 有差异 / ≥2 致命）。
   * "file changed as we read it" 就是 1 —— 打包任何含活跃日志的目录都会撞上。
   */
  it('远端 tar 退 1：继续往下走，但留一句说明', async () => {
    stub.prepared = makeArchive('rc1', 'app')
    packOk(1)
    const r = await run('rc1')

    expect(r.error).toBe(null)
    expect(r.notices.join(' ')).toMatch(/不是同一时刻的快照/)
    expect(existsSync(join(r.destDir, 'app', 'a.txt'))).toBe(true)
  })

  it('发出去的打包命令是经 wrapShellScript 之前那段脚本（含 mktemp 与 --）', async () => {
    stub.prepared = makeArchive('script', 'app')
    packOk()
    await run('script')
    expect(stub.execScripts).toHaveLength(1)
    expect(stub.execScripts[0]).toContain('mktemp')
    expect(stub.execScripts[0]).toContain("-C '/data' -- 'app'")
  })
})

describe.skipIf(TAR === null)('runPackedDownload：该拦的都拦住，且都清了场', () => {
  it('mktemp 失败（退 90）', async () => {
    stub.prepared = makeArchive('e90', 'app')
    stub.execResults.push({ stdout: '', stderr: '', code: 90 })
    const r = await run('e90')
    expect(r.error?.message).toMatch(/mktemp/)
    // 没拿到路径，所以没什么远端文件要删
    expect(stub.unlinked).toEqual([])
  })

  it('远端打包失败（退 91）会把 stderr 的第一行带出来', async () => {
    stub.prepared = makeArchive('e91', 'app')
    stub.execResults.push({ stdout: '', stderr: 'tar: /data/app: Cannot open\n', code: 91 })
    const r = await run('e91')
    expect(r.error?.message).toMatch(/Cannot open/)
  })

  it('打包命令没回报路径 → 报错而不是拿 undefined 往下走', async () => {
    stub.prepared = makeArchive('nopath', 'app')
    stub.execResults.push({ stdout: 'OFSP:RC 0\n', stderr: '', code: 0 })
    const r = await run('nopath')
    expect(r.error?.message).toMatch(/没有回报临时文件路径/)
  })

  /** mktemp 回来的路径要**再过一遍守卫**才能进下一条命令 / SFTP 请求 */
  it('打包回报的路径过不了守卫 → 报错', async () => {
    stub.prepared = makeArchive('badpath', 'app')
    stub.execResults.push({
      stdout: 'OFSP:PATH ../../etc/passwd\nOFSP:RC 0\n',
      stderr: '',
      code: 0
    })
    const r = await run('badpath')
    expect(r.error).not.toBe(null)
    expect(stub.unlinked).toEqual([])
  })

  it('远端包不存在或为 0 字节 → 报错（0 字节的 tar 列成员会"成功"，必须早点拦）', async () => {
    stub.prepared = makeArchive('empty', 'app')
    packOk()
    stub.statSize = { exists: true, isDir: false, size: 0 }
    const r = await run('empty')
    expect(r.error?.message).toMatch(/不存在或为空/)
    // 已经建出来的远端临时包仍然要清掉
    expect(stub.unlinked).toEqual(['/tmp/ofs-pack.AbCd1234'])
  })

  it('下载回来的不是归档 → 校验失败，不解包，两边临时文件都清掉', async () => {
    const junk = join(root, 'junk.tar')
    writeFileSync(junk, 'not a tar at all\n', 'utf8')
    stub.prepared = junk
    packOk()
    const r = await run('junk')

    expect(r.error?.message).toMatch(/归档校验失败/)
    expect(existsSync(join(r.destDir, 'app'))).toBe(false)
    expect(stub.unlinked).toEqual(['/tmp/ofs-pack.AbCd1234'])
    expect(existsSync(join(r.localTmpDir, 'task-junk.tar'))).toBe(false)
  })

  /**
   * 顶层项与预期不符 → **一个字节都不解**。这条盯的是"归档里的东西会落到哪"这件事：
   * 解包目标是下载目录的父级，顶层不对就等于往用户下载目录里塞一个别的东西。
   */
  it('顶层项与预期不符 → 放弃解包，目标目录一个文件都没多', async () => {
    stub.prepared = makeArchive('wrongtop', 'other')
    packOk()
    const r = await run('wrongtop', 'app')

    expect(r.error?.message).toMatch(/越出目标目录|放弃解包/)
    expect(existsSync(join(r.destDir, 'other'))).toBe(false)
    expect(existsSync(join(r.destDir, 'app'))).toBe(false)
    expect(stub.unlinked).toEqual(['/tmp/ofs-pack.AbCd1234'])
  })

  it('传输阶段失败：错误照原样抛出，两边临时文件照样清', async () => {
    stub.prepared = makeArchive('xfer', 'app')
    packOk()
    stub.transferThrows = new Error('连接断了')
    const r = await run('xfer')

    expect(r.error?.message).toBe('连接断了')
    expect(stub.unlinked).toEqual(['/tmp/ofs-pack.AbCd1234'])
    expect(r.phases).toContain('cleanup')
  })
})
