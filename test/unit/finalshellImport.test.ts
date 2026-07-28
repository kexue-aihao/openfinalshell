import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const fs = await import('../../src/main/services/finalshellImport')
const conns = await import('../../src/main/store/connections')
const { vault } = await import('../../src/main/store/Vault')
const { database, prepare } = await import('../../src/main/store/Database')

/**
 * FinalShell 导入。
 *
 * 字段映射对着**一条真实记录**写的（用户提供），这里的样本保留它的字段名与形状，
 * 但主机/密文都是编的 —— 测试仓库里不该躺着任何人的真实凭据。
 *
 * 最要紧的两条：
 *  1. **密码解不出就是解不出**，绝不能因为"看着解出来了"把垃圾存进库。
 *     `acceptDecryptedSecret` 是那道门，它与密钥推导无关，所以现在就能测、也必须测。
 *  2. 写库一律经 `saveProfile` —— 那是本项目唯一的加密入口。绕过它的话，
 *     明文会直接进 profiles 表的 JSON 列，而代码看着一样能跑。
 */

/** 用户给的那条记录的形状，值换成编的 */
const SAMPLE = {
  forwarding_auto_reconnect: false,
  custom_size: false,
  delete_time: 0,
  secret_key_id: 'rimxqo03hu5t2lio',
  user_name: 'root',
  remote_port_forwarding: {},
  conection_type: 100,
  sort_time: 0,
  description: '香港节点',
  proxy_id: '7b1rpzt1y8jjc6k6',
  authentication_type: 2,
  drivestoredirect: true,
  delete_key_sequence: 0,
  password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  modified_time: 1782611139179,
  host: '203.0.113.7',
  accelerate: false,
  id: 'fwzniysx3yzyigig',
  height: 0,
  order: 0,
  create_time: 1782610958947,
  port_forwarding_list: [],
  parent_update_time: 0,
  rename_time: 0,
  backspace_key_sequence: 2,
  fullscreen: false,
  port: 50035,
  terminal_encoding: 'UTF-8',
  parent_id: 'b55cirnojk57ww3i',
  exec_channel_enable: true,
  width: 0,
  name: 'Hytron-HK1',
  access_time: 1785192866687
}

/** 分组记录：没有 host/port，其余字段照抄它的命名习惯 */
const SAMPLE_GROUP = {
  id: 'b55cirnojk57ww3i',
  name: '生产',
  parent_id: '',
  conection_type: 0,
  create_time: 1782610000000,
  modified_time: 1782610000001
}

beforeEach(() => {
  database()
  fs.resetFinalShellPending()
  // 每条用例自己造数据，先清空连接表免得互相干扰
  prepare('DELETE FROM profiles').run()
  prepare('DELETE FROM conn_groups').run()
})

describe('记录解析', () => {
  it('按真实字段名取值：host / port / user_name / description / terminal_encoding', () => {
    const rec = fs.parseFinalShellRecord(SAMPLE)
    expect(rec).not.toBeNull()
    expect(rec!.name).toBe('Hytron-HK1')
    expect(rec!.host).toBe('203.0.113.7')
    expect(rec!.port).toBe(50035)
    expect(rec!.username).toBe('root')
    expect(rec!.note).toBe('香港节点')
    expect(rec!.charset).toBe('utf-8')
    expect(rec!.parentId).toBe('b55cirnojk57ww3i')
    expect(rec!.isSsh).toBe(true)
  })

  it('认出"有密码但解不开"、"用了密钥"、"配了代理"三种情况', () => {
    const rec = fs.parseFinalShellRecord(SAMPLE)!
    expect(rec.lockedPassword).toBe(true)
    expect(rec.usesKey).toBe(true)
    expect(rec.hasProxy).toBe(true)
  })

  it('缺 id 或 name 的记录判为无效（而不是导进来一条没名字的连接）', () => {
    expect(fs.parseFinalShellRecord({ ...SAMPLE, id: '' })).toBeNull()
    expect(fs.parseFinalShellRecord({ ...SAMPLE, name: '   ' })).toBeNull()
    expect(fs.parseFinalShellRecord(null)).toBeNull()
    expect(fs.parseFinalShellRecord('不是对象')).toBeNull()
  })

  it('非 SSH 的连接类型不导（本项目只做 SSH）', () => {
    expect(fs.parseFinalShellRecord({ ...SAMPLE, conection_type: 200 })!.isSsh).toBe(false)
    // 缺类型字段时按 SSH 处理：老版本可能没这个字段
    const noType = { ...SAMPLE } as Record<string, unknown>
    delete noType.conection_type
    expect(fs.parseFinalShellRecord(noType)!.isSsh).toBe(true)
  })

  it('编码映射：认得的转小写，认不出的回落 utf-8 并报出原名', () => {
    expect(fs.mapCharset('UTF-8')).toEqual({ charset: 'utf-8' })
    expect(fs.mapCharset('GBK')).toEqual({ charset: 'gbk' })
    expect(fs.mapCharset('GB2312')).toEqual({ charset: 'gbk' })
    expect(fs.mapCharset('Big5')).toEqual({ charset: 'big5' })
    expect(fs.mapCharset('EUC-JP')).toEqual({ charset: 'utf-8', unknown: 'EUC-JP' })
    expect(fs.mapCharset(undefined)).toEqual({ charset: 'utf-8' })
  })

  it('分类：有主机的算连接，没主机的算分组，坏的计数', () => {
    const out = fs.classifyFinalShellRecords([
      SAMPLE,
      SAMPLE_GROUP,
      { ...SAMPLE, id: 'x2', conection_type: 200 },
      { 啥都没有: 1 }
    ])
    expect(out.connections.map((c) => c.id)).toEqual(['fwzniysx3yzyigig'])
    expect(out.groups.map((g) => g.id)).toEqual(['b55cirnojk57ww3i'])
    expect(out.notSsh).toBe(1)
    expect(out.invalid).toBe(1)
  })
})

describe('密码：解不出就是解不出', () => {
  it('认出密文的形状（8 字节头 + 8 的整数倍）', () => {
    expect(fs.looksLikeFinalShellSecret('bR0YbkkiVDe8HESscsKTL0eLwND25i9kSxU+lvo5o4U=')).toBe(true)
    expect(fs.looksLikeFinalShellSecret('')).toBe(false)
    expect(fs.looksLikeFinalShellSecret(undefined)).toBe(false)
    expect(fs.looksLikeFinalShellSecret('短')).toBe(false)
    // 长度不是 8 的整数倍
    expect(fs.looksLikeFinalShellSecret(Buffer.alloc(20).toString('base64'))).toBe(false)
  })

  it('当前一律解不出（宁可让用户重输一次，也不把猜出来的垃圾存进库）', () => {
    expect(fs.decryptFinalShellPassword('bR0YbkkiVDe8HESscsKTL0eLwND25i9kSxU+lvo5o4U=')).toBeNull()
  })

  describe('准入校验（将来接上推导时唯一的守门人）', () => {
    /** 造一段合法的 PKCS#5 明文块 */
    const padded = (text: string): Buffer => {
      const body = Buffer.from(text, 'utf8')
      const pad = 8 - (body.length % 8)
      return Buffer.concat([body, Buffer.alloc(pad, pad)])
    }

    it('合法的收下', () => {
      expect(fs.acceptDecryptedSecret(padded('hunter2'))).toBe('hunter2')
      expect(fs.acceptDecryptedSecret(padded('中文密码-🙂'))).toBe('中文密码-🙂')
      // 正好整块（pad = 8）
      expect(fs.acceptDecryptedSecret(padded('12345678'))).toBe('12345678')
    })

    it('padding 不合法的拒掉 —— 错密钥有 7/8 概率撞在这里', () => {
      expect(fs.acceptDecryptedSecret(Buffer.from([1, 2, 3, 4, 5, 6, 7, 99]))).toBeNull()
      // 末字节说 pad=3，但前面两个不是 3
      expect(fs.acceptDecryptedSecret(Buffer.from([1, 2, 3, 4, 5, 9, 9, 3]))).toBeNull()
      // 长度不是 8 的整数倍
      expect(fs.acceptDecryptedSecret(Buffer.from([1, 1]))).toBeNull()
      expect(fs.acceptDecryptedSecret(Buffer.alloc(0))).toBeNull()
    })

    it('padding 碰巧合法但内容是乱字节的，也拒掉', () => {
      // 末字节 1 → pad=1 合法，但前 7 字节是不可打印的控制字节
      const junk = Buffer.from([0x00, 0x01, 0x02, 0x1f, 0x7f, 0x03, 0x04, 0x01])
      expect(fs.acceptDecryptedSecret(junk)).toBeNull()
      // 非法 UTF-8 序列（孤立的续字节）
      const badUtf8 = Buffer.from([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x01])
      expect(fs.acceptDecryptedSecret(badUtf8)).toBeNull()
    })

    it('全是 padding（明文为空）拒掉', () => {
      expect(fs.acceptDecryptedSecret(Buffer.alloc(8, 8))).toBeNull()
    })
  })
})

describe('写入：一律经 saveProfile，明文不落库', () => {
  const makeDir = (records: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-fs-'))
    mkdirSync(join(dir, 'conn'), { recursive: true })
    records.forEach((r, i) => {
      writeFileSync(join(dir, 'conn', `${i}_connection.json`), JSON.stringify(r), 'utf8')
    })
    return dir
  }

  it('扫描 → 导入：连接与分组落库，分组层级用新 id 重建', async () => {
    const dir = makeDir([SAMPLE, SAMPLE_GROUP])
    const scan = await fs.scanFinalShell({ dir })
    expect(scan).not.toBeNull()
    expect(scan!.counts.profiles).toBe(1)
    expect(scan!.counts.groups).toBe(1)
    expect(scan!.counts.lockedPasswords).toBe(1)
    // 摘要里不许出现密文
    expect(JSON.stringify(scan!.samples)).not.toContain('AAAA')

    const r = fs.applyFinalShellImport({ token: scan!.token, conflict: 'skip' })
    expect(r.profiles).toBe(1)
    expect(r.groups).toBe(1)
    expect(r.secrets).toBe(0)

    const { profiles, groups } = conns.listConnections()
    const p = profiles.find((x) => x.name === 'Hytron-HK1')
    expect(p).toBeDefined()
    expect(p!.host).toBe('203.0.113.7')
    expect(p!.port).toBe(50035)
    expect(p!.username).toBe('root')
    expect(p!.terminal.charset).toBe('utf-8')
    expect(p!.note).toBe('香港节点')
    // id 是本项目自己的 UUID，不复用 FinalShell 的 16 位串
    expect(p!.id).not.toBe('fwzniysx3yzyigig')
    // 分组挂上了，且 groupId 指向新建的那个分组
    const g = groups.find((x) => x.name === '生产')
    expect(g).toBeDefined()
    expect(p!.groupId).toBe(g!.id)
    // 没有密码引用 —— 首次连接时会问
    expect(p!.auth.passwordRef).toBeUndefined()
    expect(p!.auth.method).toBe('password')
  })

  it('库里不出现任何密文/明文片段（这条是"加密存储"那句话的兜底）', async () => {
    const dir = makeDir([SAMPLE, SAMPLE_GROUP])
    const scan = await fs.scanFinalShell({ dir })
    fs.applyFinalShellImport({ token: scan!.token, conflict: 'skip' })
    const rows = prepare('SELECT json FROM profiles').all() as Array<{ json: string }>
    const all = rows.map((r) => r.json).join('\n')
    expect(all).not.toContain(SAMPLE.password)
    /*
     * 判的是有没有 `"password":` 这个**键**（那才是明文落库的样子）。
     * 别写成 `not.toContain('password')` —— `"method":"password"` 是合法内容，
     * 那样写出来的护栏会因为一个正常字段而红，然后被人删掉。
     */
    expect(all).not.toMatch(/"password"\s*:/)
    expect(all).not.toMatch(/"passphrase"\s*:/)
    // secrets 表里也不该因为这次导入多出条目
    expect(prepare('SELECT COUNT(*) AS c FROM secrets').get()).toEqual({ c: 0 })
  })

  it('判重按 主机+端口+用户名：skip 跳过、duplicate 一律新建', async () => {
    const dir = makeDir([SAMPLE])
    const first = await fs.scanFinalShell({ dir })
    fs.applyFinalShellImport({ token: first!.token, conflict: 'skip' })

    const again = await fs.scanFinalShell({ dir })
    const skipped = fs.applyFinalShellImport({ token: again!.token, conflict: 'skip' })
    expect(skipped.profiles).toBe(0)
    expect(skipped.skipped).toBe(1)

    const third = await fs.scanFinalShell({ dir })
    const dup = fs.applyFinalShellImport({ token: third!.token, conflict: 'duplicate' })
    expect(dup.profiles).toBe(1)
    expect(conns.listConnections().profiles.filter((p) => p.host === '203.0.113.7')).toHaveLength(2)
  })

  it('token 用过就失效（重复提交不会导两遍）', async () => {
    const dir = makeDir([SAMPLE])
    const scan = await fs.scanFinalShell({ dir })
    fs.applyFinalShellImport({ token: scan!.token, conflict: 'duplicate' })
    expect(() => fs.applyFinalShellImport({ token: scan!.token, conflict: 'duplicate' })).toThrow(
      /会话已失效/
    )
  })

  it('目录里没有 JSON / 没有 SSH 连接时，报的是人话', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ofs-fs-empty-'))
    await expect(fs.scanFinalShell({ dir: empty })).rejects.toThrow(/没有找到任何 \.json/)

    const onlyGroups = makeDir([SAMPLE_GROUP])
    await expect(fs.scanFinalShell({ dir: onlyGroups })).rejects.toThrow(/没有可导入的 SSH 连接/)
  })

  it('上级分组不在目录里时落到根，并在结果里说明', async () => {
    const dir = makeDir([SAMPLE]) // 只有连接，没有那条分组记录
    const scan = await fs.scanFinalShell({ dir })
    const r = fs.applyFinalShellImport({ token: scan!.token, conflict: 'duplicate' })
    expect(r.profiles).toBe(1)
    expect(conns.listConnections().profiles.at(-1)!.groupId).toBeNull()
    expect(r.notes.join('\n')).toMatch(/上级分组不在所选目录里/)
  })

  it('vault 没被这次导入写过（没有密码可写）', async () => {
    const dir = makeDir([SAMPLE])
    const scan = await fs.scanFinalShell({ dir })
    fs.applyFinalShellImport({ token: scan!.token, conflict: 'duplicate' })
    const p = conns.listConnections().profiles.at(-1)!
    expect(p.auth.passwordRef).toBeUndefined()
    // 反过来验一次：这条路径本身是通的 —— 用户日后勾"记住密码"就会有引用
    const withPw = conns.saveProfile({
      ...p,
      id: undefined,
      name: '手填密码',
      auth: { method: 'password', password: '后来输入的' }
    })
    expect(withPw.auth.passwordRef).toBeTruthy()
    expect(vault.getSecret(withPw.auth.passwordRef!)).toBe('后来输入的')
  })
})
