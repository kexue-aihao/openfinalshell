import { beforeEach, describe, expect, it, vi } from 'vitest'
import iconv from 'iconv-lite'
import { FakeServer } from '../fakeSftpServer'
import { read, stripComments } from '../sourceGuard'
import { MAX_EDIT_BYTES } from '../../src/shared/constants'
import type { RemoteSaveGates } from '../../src/shared/types'
import {
  forgetSessionBaselines,
  MAX_TRACKED_BASELINES,
  resetBaselinesForTest
} from '../../src/main/sftp/editBaselines'
import { saveRemoteTextFile } from '../../src/main/sftp/fileSave'
import { viewRemoteFile } from '../../src/main/sftp/fileView'

/**
 * 内置编辑器保存那条路的单测：远端换成内存假服务器，`sshManager` 打掉。
 *
 * 这一套的存在理由很具体：`saveRemoteText`（写回的核心）此前**一个调用方都没有** ——
 * 它的语义只被外部编辑器那条路间接覆盖着，而那条路马上要被删掉（片 4）。
 * 更要紧的是，接上 `sftp:fileSave` 之后 `SaveGates` 的三个开关变成了
 * **渲染进程可控输入**，所以这里的重点不是"能存上"，而是：
 *
 *  1. 三个闸门各自独立 —— 开一个绝不顺带放行另一个（老路 `force: boolean` 的毛病）；
 *  2. 四道硬拒**没有任何 gate 能越过**（编码存不下去、原字节解不干净、超上限、基线不在）；
 *  3. 每一条被拦下的路上，远端**一个字节都没被写**；
 *  4. 返回给渲染进程的东西里**没有基线**。
 *
 * 用真的 `viewRemoteFile` 来铺基线而不是手搓一个：那样这些用例顺带钉住了
 * "fileView 真的把基线记下来了"这条接线 —— 手搓基线的话，fileView 哪天忘了记，
 * 这一整套照样全绿。
 */

const server = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../src/main/ssh/SshConnectionManager', () => ({
  sshManager: {
    get: () => ({
      browseSftpSession: () => {
        const s = server.current as { sftp: unknown } | null
        if (!s) throw new Error('用例没有装假服务器')
        return Promise.resolve(s.sftp)
      }
    })
  }
}))

const SID = 'session-1'
const P = '/etc/app.conf'

/** 三个闸门全关 —— 界面上"直接按 Ctrl+S"就是这个 */
const NO_GATES: RemoteSaveGates = {
  overwriteRemoteChanges: false,
  allowNonAtomic: false,
  allowShrink: false
}

let fake: FakeServer

beforeEach(() => {
  fake = new FakeServer()
  server.current = fake
  resetBaselinesForTest()
})

/** 打开（铺基线）→ 保存。默认 utf8 / lf / 无 BOM，与 fixture 一致 */
async function openThenSave(
  text: string,
  gates: RemoteSaveGates = NO_GATES,
  opts: { path?: string; charset?: 'utf8' | 'gbk'; eol?: 'lf' | 'crlf'; hasBom?: boolean } = {}
): ReturnType<typeof saveRemoteTextFile> {
  const path = opts.path ?? P
  const charset = opts.charset ?? 'utf8'
  await viewRemoteFile(SID, path, charset)
  return saveRemoteTextFile({
    sessionId: SID,
    path,
    text,
    charset,
    eol: opts.eol ?? 'lf',
    hasBom: opts.hasBom ?? false,
    gates
  })
}

// ---------------- 写成了 ----------------

describe('保存的正常路径', () => {
  it('内容写进远端，且走的是 posix-rename（不是先删后改名）', async () => {
    fake.putFile(P, 'old\n')
    const r = await openThenSave('new content\n')

    expect(r.kind).toBe('saved')
    expect(fake.contentOf(P)).toBe('new content\n')
    expect(fake.calls.some((c) => c.startsWith(`posix-rename`))).toBe(true)
    // 目标被 unlink 过就意味着中间有一瞬间它不存在 —— 那正是原子替换要避免的
    expect(fake.calls).not.toContain(`unlink ${P}`)
    // 临时文件不许留在人家目录里
    expect(fake.paths()).toEqual([P])
  })

  it('连续两次保存都写得进去：基线跟着推进，第二次不会误判成冲突', async () => {
    fake.putFile(P, 'v0\n')
    expect((await openThenSave('v1\n')).kind).toBe('saved')

    // 第二次**不重新打开**，直接再存一次 —— 界面上就是连按两次 Ctrl+S
    const second = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'v2\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(second.kind).toBe('saved')
    expect(fake.contentOf(P)).toBe('v2\n')
  })

  it('权限位保留：0o600 的文件存完还是 0o600', async () => {
    fake.putFile(P, 'secret\n', 0o600)
    expect((await openThenSave('secret2\n')).kind).toBe('saved')
    expect(fake.modeOf(P)).toBe(0o600)
  })

  it('返回给渲染进程的结果里没有基线（sha / mtime 一个都不许下发）', async () => {
    fake.putFile(P, 'old\n')
    const r = await openThenSave('new\n')

    expect(Object.keys(r).sort()).toEqual(['bytes', 'kind', 'mode', 'warning'].sort())
    const flat = JSON.stringify(r)
    expect(flat).not.toMatch(/sha|mtime|baseline/i)
  })
})

// ---------------- 三个闸门 ----------------

describe('闸门一：远端在编辑期间被改过', () => {
  it('关着 → conflict，远端一个字节都没被写', async () => {
    fake.putFile(P, 'old\n')
    await viewRemoteFile(SID, P, 'utf8')
    fake.thirdPartyWrite(P, '别人 vim 存了一次\n')

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'mine\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(r.kind).toBe('conflict')
    expect(fake.contentOf(P)).toBe('别人 vim 存了一次\n')
    expect(fake.paths()).toEqual([P])
  })

  it('开了 → 这份内容真的盖上去', async () => {
    fake.putFile(P, 'old\n')
    await viewRemoteFile(SID, P, 'utf8')
    fake.thirdPartyWrite(P, '别人的改动\n')

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'mine\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: { ...NO_GATES, overwriteRemoteChanges: true }
    })
    expect(r.kind).toBe('saved')
    expect(fake.contentOf(P)).toBe('mine\n')
  })

  it('远端文件被删掉也算冲突（不盲目重建）', async () => {
    fake.putFile(P, 'old\n')
    await viewRemoteFile(SID, P, 'utf8')
    fake.nodes.delete(P)

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'mine\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(r.kind).toBe('conflict')
    expect(fake.paths()).toEqual([])
  })
})

describe('闸门二：服务器不支持原子替换', () => {
  it('关着 → nonAtomic，远端没变、也没留临时文件', async () => {
    fake.putFile(P, 'old\n')
    fake.posixRename = false

    const r = await openThenSave('new\n')
    expect(r).toEqual({ kind: 'nonAtomic' })
    expect(fake.contentOf(P)).toBe('old\n')
    // 试原子替换必须先写临时文件（能力探测只能靠真调一次），失败后要收干净
    expect(fake.paths()).toEqual([P])
  })

  it('开了 → 内容写入，备份名不留在远端', async () => {
    fake.putFile(P, 'old\n')
    fake.posixRename = false

    const r = await openThenSave('new\n', { ...NO_GATES, allowNonAtomic: true })
    expect(r.kind).toBe('saved')
    expect(fake.contentOf(P)).toBe('new\n')
    expect(fake.paths()).toEqual([P])
  })
})

describe('闸门三：内容缩水', () => {
  it('清空 → shrink，远端一个字节都没被写', async () => {
    fake.putFile(P, 'listen 443;\n')
    const r = await openThenSave('')

    expect(r).toMatchObject({ kind: 'shrink', localBytes: 0 })
    expect(fake.contentOf(P)).toBe('listen 443;\n')
    expect(fake.paths()).toEqual([P])
  })

  it('开了 → 这个文件真的被清空', async () => {
    fake.putFile(P, 'listen 443;\n')
    const r = await openThenSave('', { ...NO_GATES, allowShrink: true })

    expect(r.kind).toBe('saved')
    expect(fake.contentOf(P)).toBe('')
  })

  it('日常小幅删几行不拦（闸门不能把正常编辑也变成一次确认）', async () => {
    fake.putFile(P, 'x'.repeat(8192))
    const r = await openThenSave('x'.repeat(7000))
    expect(r.kind).toBe('saved')
  })
})

/**
 * 这两条是 SaveGates 拆成三个 boolean 的**红证**。
 *
 * 老路把三件事挤成一个 `force: boolean`，于是用户点"仍然覆盖"（我接受远端改动被盖掉）
 * 顺带把非原子替换也放行了 —— 他同意的是前者，承担的是后者。谁哪天"简化"回一个开关，
 * 红的就是这两条。
 */
describe('闸门之间互不牵连', () => {
  it('"仍然覆盖"不顺带放行非原子替换', async () => {
    fake.putFile(P, 'old\n')
    await viewRemoteFile(SID, P, 'utf8')
    fake.thirdPartyWrite(P, '别人的改动\n')
    fake.posixRename = false

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'mine\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: { ...NO_GATES, overwriteRemoteChanges: true }
    })
    expect(r).toEqual({ kind: 'nonAtomic' })
    expect(fake.contentOf(P)).toBe('别人的改动\n')
  })

  it('"允许缩水"不顺带跳过冲突检测', async () => {
    fake.putFile(P, 'x'.repeat(8192))
    await viewRemoteFile(SID, P, 'utf8')
    fake.thirdPartyWrite(P, 'y'.repeat(8192))

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: '',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: { ...NO_GATES, allowShrink: true }
    })
    expect(r.kind).toBe('conflict')
    expect(fake.contentOf(P)).toBe('y'.repeat(8192))
  })
})

// ---------------- 四道硬拒：没有任何 gate 能越过 ----------------

/** 三个开关全开。硬拒的用例都拿它调，才算证明了"确认也没用" */
const ALL_GATES: RemoteSaveGates = {
  overwriteRemoteChanges: true,
  allowNonAtomic: true,
  allowShrink: true
}

describe('硬拒：基线不在', () => {
  it('没打开过就直接保存 → 抛错，远端没被写', async () => {
    fake.putFile(P, 'old\n')
    await expect(
      saveRemoteTextFile({
        sessionId: SID,
        path: P,
        text: 'mine\n',
        charset: 'utf8',
        eol: 'lf',
        hasBom: false,
        gates: NO_GATES
      })
    ).rejects.toThrow(/打开状态已失效/)
    expect(fake.contentOf(P)).toBe('old\n')
  })

  it('三个 gate 全开也一样抛 —— 它不是闸门', async () => {
    fake.putFile(P, 'old\n')
    await expect(
      saveRemoteTextFile({
        sessionId: SID,
        path: P,
        text: 'mine\n',
        charset: 'utf8',
        eol: 'lf',
        hasBom: false,
        gates: ALL_GATES
      })
    ).rejects.toThrow(/打开状态已失效/)
    expect(fake.contentOf(P)).toBe('old\n')
  })

  it('会话关掉之后基线作废（forgetSessionBaselines），保存硬拒而不是无检测直写', async () => {
    fake.putFile(P, 'old\n')
    await viewRemoteFile(SID, P, 'utf8')
    forgetSessionBaselines(SID)

    await expect(
      saveRemoteTextFile({
        sessionId: SID,
        path: P,
        text: 'mine\n',
        charset: 'utf8',
        eol: 'lf',
        hasBom: false,
        gates: ALL_GATES
      })
    ).rejects.toThrow(/打开状态已失效/)
    expect(fake.contentOf(P)).toBe('old\n')
  })

  /**
   * 注册表满了淘汰最老的一条之后，那个文件的保存必须**硬拒**。
   *
   * 这条才是"上限是安全的"那句话的证明：淘汰只会让用户重新打开一次，
   * 绝不会退化成"没有基线就当没变过、直接写"。
   */
  it('注册表溢出淘汰掉最老那条之后，那个文件保存硬拒', async () => {
    const oldest = '/etc/oldest.conf'
    fake.putFile(oldest, 'old\n')
    await viewRemoteFile(SID, oldest, 'utf8')

    // 再打开 MAX_TRACKED_BASELINES 个，把最老那条挤出去
    for (let i = 0; i < MAX_TRACKED_BASELINES; i++) {
      const p = `/etc/f${i}.conf`
      fake.putFile(p, `#${i}\n`)
      await viewRemoteFile(SID, p, 'utf8')
    }

    await expect(
      saveRemoteTextFile({
        sessionId: SID,
        path: oldest,
        text: 'mine\n',
        charset: 'utf8',
        eol: 'lf',
        hasBom: false,
        gates: ALL_GATES
      })
    ).rejects.toThrow(/打开状态已失效/)
    expect(fake.contentOf(oldest)).toBe('old\n')

    // 最后打开的那个照样存得进去（淘汰的是最老的，不是随便一个）
    const newest = `/etc/f${MAX_TRACKED_BASELINES - 1}.conf`
    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: newest,
      text: 'ok\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(r.kind).toBe('saved')
  })
})

describe('硬拒：原始字节解不干净', () => {
  /** 0x81 是 GBK 的前导字节，0x20 不是合法后继 —— iconv 只能用替换字符顶上 */
  const ILLEGAL_GBK = Buffer.from([0x61, 0x81, 0x20, 0x62, 0x0a])

  it('lossless 为 false 时拒绝保存（一次确认换不回那些字节）', async () => {
    fake.putFile(P, ILLEGAL_GBK)
    const view = await viewRemoteFile(SID, P, 'gbk')
    // 前提确认：这份字节按 GBK 解确实是有损的，否则下面那条断言是空的
    expect(view.lossless).toBe(false)

    await expect(
      saveRemoteTextFile({
        sessionId: SID,
        path: P,
        text: view.text,
        charset: 'gbk',
        eol: 'lf',
        hasBom: false,
        gates: ALL_GATES
      })
    ).rejects.toThrow(/解不干净/)
    expect(fake.nodes.get(P)?.content?.equals(ILLEGAL_GBK)).toBe(true)
  })

  it('换成 latin1 打开（每个字节都合法）之后就存得回去', async () => {
    fake.putFile(P, ILLEGAL_GBK)
    const view = await viewRemoteFile(SID, P, 'latin1')
    expect(view.lossless).toBe(true)

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: view.text,
      charset: 'latin1',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(r.kind).toBe('saved')
    // 原样往返：一个字节都没变
    expect(fake.nodes.get(P)?.content?.equals(ILLEGAL_GBK)).toBe(true)
  })
})

describe('硬拒：用户打的字存不下去', () => {
  it('往 GBK 文件里粘 emoji → 拒绝，并点名那个字符，远端没被写', async () => {
    fake.putFile(P, iconv.encode('端口 = 443\n', 'gbk'))
    await viewRemoteFile(SID, P, 'gbk')

    const call = saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: '端口 = 443 🎉\n',
      charset: 'gbk',
      eol: 'lf',
      hasBom: false,
      gates: ALL_GATES
    })
    await expect(call).rejects.toThrow(/无法用 gbk 表示/)
    await expect(call).rejects.toThrow(/🎉/)
    expect(fake.contentOf(P)).not.toContain('?')
  })

  it('同样的内容存成 utf8 就没问题（拒的是编码不匹配，不是 emoji）', async () => {
    fake.putFile(P, iconv.encode('端口 = 443\n', 'gbk'))
    await viewRemoteFile(SID, P, 'gbk')

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: '端口 = 443 🎉\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(r.kind).toBe('saved')
    expect(fake.contentOf(P)).toBe('端口 = 443 🎉\n')
  })
})

describe('硬拒：超过字节上限', () => {
  it('按**编码后**的长度判，不按字符数', async () => {
    fake.putFile(P, 'x\n')
    await viewRemoteFile(SID, P, 'utf8')

    // 80 万个中文按 UTF-8 是 240 万字节 > 2MB，而字符数只有 80 万（远低于上限）
    const text = '配'.repeat(800_000)
    expect(text.length).toBeLessThan(MAX_EDIT_BYTES)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(MAX_EDIT_BYTES)

    await expect(
      saveRemoteTextFile({
        sessionId: SID,
        path: P,
        text,
        charset: 'utf8',
        eol: 'lf',
        hasBom: false,
        gates: ALL_GATES
      })
    ).rejects.toThrow(/超过上限/)
    expect(fake.contentOf(P)).toBe('x\n')
  })
})

// ---------------- 软链 ----------------

describe('软链', () => {
  const LINK = '/etc/nginx/sites-enabled/site'
  const REAL = '/etc/nginx/sites-available/site'

  it('读写都落在真身上，软链本身还是软链', async () => {
    fake.putFile(REAL, 'server_name a;\n')
    fake.putLink(LINK, REAL)

    const r = await openThenSave('server_name b;\n', NO_GATES, { path: LINK })
    expect(r.kind).toBe('saved')
    expect(fake.contentOf(REAL)).toBe('server_name b;\n')
    // 软链没有被替换成普通文件 —— 不做这一条，用户改一次配置站点就消失
    expect(fake.nodes.get(LINK)?.link).toBe(REAL)
  })

  it('编辑期间软链被重新指向 → 停止保存，两个目标一个字节都没被写', async () => {
    fake.putFile(REAL, 'A\n')
    fake.putFile('/etc/nginx/sites-available/other', 'B\n')
    fake.putLink(LINK, REAL)
    await viewRemoteFile(SID, LINK, 'utf8')

    // 换站点正是靠改这条软链做的
    fake.putLink(LINK, '/etc/nginx/sites-available/other')

    await expect(
      saveRemoteTextFile({
        sessionId: SID,
        path: LINK,
        text: 'mine\n',
        charset: 'utf8',
        eol: 'lf',
        // 三个 gate 全开：确认"仍然覆盖"授权的是覆盖他正在编辑的那个文件，
        // 不是覆盖另一个文件，所以这条不许被任何 gate 放行
        hasBom: false,
        gates: ALL_GATES
      })
    ).rejects.toThrow(/指向的是另一个文件/)
    expect(fake.contentOf(REAL)).toBe('A\n')
    expect(fake.contentOf('/etc/nginx/sites-available/other')).toBe('B\n')
  })
})

// ---------------- 编码 / 行尾 / BOM 往返 ----------------

describe('编码、行尾与 BOM 都按传进来的那份还原', () => {
  it('GBK 文件存回去仍是 GBK 字节（不许被偷偷存成 UTF-8）', async () => {
    fake.putFile(P, iconv.encode('监听 = 80\n', 'gbk'))
    const view = await viewRemoteFile(SID, P, 'gbk')
    expect(view.text).toBe('监听 = 80\n')

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: '监听 = 443\n',
      charset: 'gbk',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(r.kind).toBe('saved')
    const bytes = fake.nodes.get(P)?.content
    expect(bytes?.equals(iconv.encode('监听 = 443\n', 'gbk'))).toBe(true)
    // 存成 UTF-8 的话字节会是这个 —— 断言它**不是**，否则上一条可能是巧合
    expect(bytes?.equals(Buffer.from('监听 = 443\n', 'utf8'))).toBe(false)
  })

  it('CRLF 文件保存后行尾还是 CRLF', async () => {
    fake.putFile(P, 'a\r\nb\r\n')
    const view = await viewRemoteFile(SID, P, 'utf8')
    expect(view.eol).toBe('crlf')
    // 编辑器内部只见 LF
    expect(view.text).toBe('a\nb\n')

    const r = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'a\nb\nc\n',
      charset: 'utf8',
      eol: view.eol,
      hasBom: false,
      gates: NO_GATES
    })
    expect(r.kind).toBe('saved')
    expect(fake.nodes.get(P)?.content?.toString('latin1')).toBe('a\r\nb\r\nc\r\n')
  })

  it('LF 文件不会被翻面', async () => {
    fake.putFile(P, 'a\nb\n')
    const view = await viewRemoteFile(SID, P, 'utf8')
    expect(view.eol).toBe('lf')

    await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'a\nb\nc\n',
      charset: 'utf8',
      eol: view.eol,
      hasBom: false,
      gates: NO_GATES
    })
    expect(fake.nodes.get(P)?.content?.toString('latin1')).toBe('a\nb\nc\n')
  })

  it('带 BOM 的文件保存后 BOM 还在（.bat / .ps1 靠它）', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('@echo off\n')])
    fake.putFile(P, withBom)
    const view = await viewRemoteFile(SID, P, 'utf8')
    expect(view.hasBom).toBe(true)
    // BOM 不许出现在编辑器的文本里
    expect(view.text.startsWith('﻿')).toBe(false)

    await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: '@echo on\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: view.hasBom,
      gates: NO_GATES
    })
    const bytes = fake.nodes.get(P)?.content
    expect(bytes?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
    expect(bytes?.subarray(3).toString('utf8')).toBe('@echo on\n')
  })
})

// ---------------- 并发 ----------------

describe('同一个文件的并发保存', () => {
  /**
   * 拒绝而不是排队。排队错得很隐蔽：第二次的基线是第一次保存**之前**记的，
   * 排到它时远端已经被第一次写过了 → 报一个假冲突，而那个"别人"就是我们自己。
   * 用户被训练成见到冲突框就点确认，从此真冲突也一样被盖掉。
   */
  it('上一次还在飞 → 第二次直接抛，且第一次照样写成', async () => {
    fake.putFile(P, 'old\n')
    await viewRemoteFile(SID, P, 'utf8')

    let release = (): void => {}
    fake.posixRenameGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const args = {
      sessionId: SID,
      path: P,
      charset: 'utf8' as const,
      eol: 'lf' as const,
      hasBom: false,
      gates: NO_GATES
    }
    const first = saveRemoteTextFile({ ...args, text: 'first\n' })
    // 让第一次跑到卡住 posix-rename 的那一步
    await new Promise((r) => setImmediate(r))

    await expect(saveRemoteTextFile({ ...args, text: 'second\n' })).rejects.toThrow(
      /上一次保存还在进行中/
    )

    release()
    expect((await first).kind).toBe('saved')
    expect(fake.contentOf(P)).toBe('first\n')
  })

  it('第一次结束后闸门要放开（不许把这个文件永久钉住）', async () => {
    fake.putFile(P, 'old\n')
    expect((await openThenSave('v1\n')).kind).toBe('saved')

    const again = await saveRemoteTextFile({
      sessionId: SID,
      path: P,
      text: 'v2\n',
      charset: 'utf8',
      eol: 'lf',
      hasBom: false,
      gates: NO_GATES
    })
    expect(again.kind).toBe('saved')
  })

  it('保存抛错之后闸门也要放开（finally 而不是写在成功分支里）', async () => {
    fake.putFile(P, 'old\n')
    await viewRemoteFile(SID, P, 'utf8')
    fake.renameFails = () => true
    fake.posixRename = false

    const args = {
      sessionId: SID,
      path: P,
      text: 'x\n',
      charset: 'utf8' as const,
      eol: 'lf' as const,
      hasBom: false,
      gates: { ...NO_GATES, allowNonAtomic: true }
    }
    await expect(saveRemoteTextFile(args)).rejects.toThrow()

    fake.renameFails = null
    fake.posixRename = true
    // 报的必须是别的错（或成功），绝不能是"上一次保存还在进行中"
    const r = await saveRemoteTextFile(args)
    expect(r.kind).toBe('saved')
  })
})

// ---------------- IPC 边界的源码护栏 ----------------

/**
 * 这几条只能靠源码护栏：zod 的默认值是**行为上看不见**的。
 * `gates: z.object({ allowNonAtomic: z.boolean().optional() })` 会让缺省值变成
 * `undefined`，而 `undefined` 在 `if (!gates.allowNonAtomic)` 里等于 false ——
 * 于是行为用例全绿，只是从此渲染进程可以"不提这个开关"而不是"明确说不"。
 * 真正危险的是 `.default(true)`：那一行让每次保存都自动放行一道闸门，
 * 而所有行为用例都是显式传三个开关的，一条都不会红。
 */
describe('sftp:fileSave 的 zod 护栏', () => {
  const src = stripComments(read('src/main/ipc/sftp.ipc.ts'))
  const at = src.indexOf("'sftp:fileSave'")
  const window = src.slice(at, at + 900)

  it('契约里确实注册了这条 channel', () => {
    expect(at).toBeGreaterThan(0)
  })

  it('三个闸门都是必填 boolean —— 没有 optional、没有 default', () => {
    for (const gate of ['overwriteRemoteChanges', 'allowNonAtomic', 'allowShrink']) {
      expect(window, `${gate} 不在 schema 里`).toContain(`${gate}: z.boolean()`)
    }
    expect(window, 'fileSave 的 schema 里出现了 optional —— 缺省值会替用户放行闸门').not.toContain(
      '.optional()'
    )
    expect(window, 'fileSave 的 schema 里出现了 default —— 那会让每次保存自动越过闸门').not.toContain(
      '.default('
    )
  })

  it('charset 走白名单枚举（iconv 的 hex 能让渲染进程精确构造任意字节）', () => {
    expect(window).toContain('charset: z.enum(REMOTE_CHARSETS)')
  })

  it('eol 只认两个值，hasBom 必填', () => {
    expect(window).toContain("eol: z.enum(['lf', 'crlf'])")
    expect(window).toContain('hasBom: z.boolean()')
  })
})

/**
 * 基线不许下发。这条也只能查源码：把 `baseline` 塞进返回值不会让任何行为用例变红
 * （渲染进程照样能存盘），但从那天起冲突检测就变成了渲染进程说了算。
 */
describe('基线不下发的源码护栏', () => {
  it('fileSave 返回的 saved 分支是逐字段列出来的，不是把 outcome 摊开', () => {
    const src = stripComments(read('src/main/sftp/fileSave.ts'))
    expect(src, '把 outcome 整个摊开会顺带把 baseline 下发给渲染进程').not.toMatch(
      /\.\.\.outcome/
    )
    expect(src).toContain("kind: 'saved'")
  })

  it('shared 的 RemoteFileSaveResult 里没有 baseline / sha / mtime', () => {
    const src = stripComments(read('src/shared/types.ts'))
    const at = src.indexOf('RemoteFileSaveResult')
    const window = src.slice(at, at + 600)
    expect(window).not.toMatch(/\bbaseline\b|\bsha\b|\bmtime\b/)
  })
})
