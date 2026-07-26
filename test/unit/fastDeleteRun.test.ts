import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FAST_DELETE_BATCH } from '../../src/shared/constants'
import { fastDelete } from '../../src/main/sftp/fastDelete'

/**
 * `fastDelete` 这层只做一件事：把多批的结果合起来。单独一个文件是为了让 mock 只作用在这里 ——
 * fastDelete.test.ts 里那些纯函数（含真 shell 那一段）不该跟一个假的 execOnce 同处一室。
 *
 * 合法的合并规则只有一条：**未知最大**。任何一批拿不到退出码，整体就得是 null，
 * 因为"我不知道删成没成"比"有一批失败了"更需要把用户赶去核对列表。写成"最后一批赢"
 * 或"只要有 0 就算成功"都会在断连那一刻把一次半途而废的 `rm -rf` 报成成功。
 */

const stub = vi.hoisted(() => ({
  results: [] as Array<{ stdout: string; stderr: string; code: number | null }>,
  calls: 0
}))

// 真 SshConnectionManager 会把整条 ssh 栈拖进来，而这层根本不碰连接
vi.mock('../../src/main/ssh/SshConnectionManager', () => ({
  sshManager: { get: () => ({ execChannel: () => Promise.reject(new Error('不该开通道')) }) }
}))
vi.mock('../../src/main/ssh/ExecRunner', () => ({
  execOnce: () => {
    const r = stub.results[stub.calls++] ?? { stdout: '', stderr: '', code: 0 }
    return Promise.resolve({ ...r, truncated: false })
  }
}))

/** 造 FAST_DELETE_BATCH + 1 条路径，逼出两批 */
const twoBatches = (): string[] =>
  Array.from({ length: FAST_DELETE_BATCH + 1 }, (_, i) => `/data/f${i}`)

const SID = 'session-1' as never

beforeEach(() => {
  stub.results.length = 0
  stub.calls = 0
})

describe('fastDelete 的多批结果聚合', () => {
  it('两批都成功 → 0，无残留', async () => {
    stub.results.push({ stdout: '', stderr: '', code: 0 }, { stdout: '', stderr: '', code: 0 })
    expect(await fastDelete(SID, twoBatches())).toEqual({ exitCode: 0, leftover: [], stderr: '' })
    expect(stub.calls).toBe(2)
  })

  it('一批非零 → 报那个非零码，两批的残留与 stderr 都不丢', async () => {
    stub.results.push(
      { stdout: 'OFSLEFT:/data/f1\n', stderr: 'denied a\n', code: 1 },
      { stdout: 'OFSLEFT:/data/f9\n', stderr: 'denied b\n', code: 0 }
    )
    const r = await fastDelete(SID, twoBatches())
    expect(r.exitCode).toBe(1)
    expect(r.leftover).toEqual(['/data/f1', '/data/f9'])
    expect(r.stderr).toBe('denied a\ndenied b\n')
  })

  it('任何一批拿不到退出码 → 整体 null，即使别的批都是 0', async () => {
    stub.results.push({ stdout: '', stderr: '', code: 0 }, { stdout: '', stderr: '', code: null })
    expect((await fastDelete(SID, twoBatches())).exitCode).toBe(null)
  })

  /**
   * 多批都失败时报**第一个**非零码。这个取舍本身是任意的（报第一个还是最后一个都说得通），
   * 钉住它的理由是别的：注释里写了"第一个"，而一个没人验的约定就是一句会漂走的注释。
   * stderr 是全量拼接的，所以后面几批的原因不会因此丢掉。
   */
  it('多批都失败时报第一个非零码，后面几批的 stderr 照样带回来', async () => {
    stub.results.push(
      { stdout: '', stderr: 'first\n', code: 1 },
      { stdout: '', stderr: 'second\n', code: 2 }
    )
    const r = await fastDelete(SID, twoBatches())
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toBe('first\nsecond\n')
  })

  it('未知压过非零（"不知道"比"某批失败了"更需要人去核对）', async () => {
    stub.results.push({ stdout: '', stderr: '', code: null }, { stdout: '', stderr: '', code: 2 })
    expect((await fastDelete(SID, twoBatches())).exitCode).toBe(null)
  })

  it('单批也走同一条路（别让"只有一批"变成一条没人验的特例）', async () => {
    stub.results.push({ stdout: 'OFSLEFT:/data/a\n', stderr: '', code: 1 })
    const r = await fastDelete(SID, ['/data/a'])
    expect(stub.calls).toBe(1)
    expect(r).toEqual({ exitCode: 1, leftover: ['/data/a'], stderr: '' })
  })

  it('空路径列表直接报错，不会静默当成"删完了"', async () => {
    await expect(fastDelete(SID, [])).rejects.toThrow(/没有要删除/)
    expect(stub.calls).toBe(0)
  })

  /** 守卫不依赖 preview 被调过 —— 那是两条独立 channel */
  it('非法路径在发出任何命令之前就抛', async () => {
    await expect(fastDelete(SID, ['/data/ok', '/etc'])).rejects.toThrow(/层级过浅/)
    expect(stub.calls).toBe(0)
  })
})
