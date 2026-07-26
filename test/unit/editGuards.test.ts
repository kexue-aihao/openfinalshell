import { describe, expect, it } from 'vitest'
import { detectEolRegression, looksBinary, sha256Hex, tempRelPath } from '../../src/main/sftp/editGuards'

/**
 * looksBinary 曾经只嗅前 8KB。窗口已经拆掉（改成全量扫描），但这个数字仍然留着当坐标：
 * 下面几条用例专门守在旧窗口的内外两侧，任何人想把窗口加回来都会立刻踩红。
 */
const OLD_SNIFF_BYTES = 8192

/** 调用方 RemoteEditManager 的 MAX_EDIT_BYTES：能进这个函数的 buffer 最大就是这么大 */
const MAX_EDIT_BYTES = 2 * 1024 * 1024

describe('looksBinary', () => {
  it('纯 ASCII 文本不是二进制', () => {
    expect(looksBinary(Buffer.from('#!/bin/sh\necho hello\n', 'utf8'))).toBe(false)
  })

  it('含中文与 emoji 的 UTF-8 不是二进制', () => {
    expect(looksBinary(Buffer.from('# 配置说明 🚀\nserver_name 例子.com;\n', 'utf8'))).toBe(false)
  })

  it('空文件不是二进制', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })

  it('出现 NUL 即判为二进制', () => {
    expect(looksBinary(Buffer.from([0x61, 0x62, 0x00, 0x63]))).toBe(true)
  })

  it('ELF 头判为二进制', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00])
    expect(looksBinary(elf)).toBe(true)
  })

  it('UTF-16LE 文本被有意拒绝（高字节 0x00，往返编辑极易损坏）', () => {
    expect(looksBinary(Buffer.from('hello', 'utf16le'))).toBe(true)
  })

  // 语义已刻意反转：旧实现在这里返回 false（"只嗅前 8KB"的取舍），现在必须返回 true。
  // 反转的理由是写回方向 —— looksBinary 同时守着下载与写回两条路，用的是同一个判定。
  // 窗口外的 NUL 看不见，就等于：文件被当文本放进编辑器、编辑器存盘时把 NUL 改写掉、
  // 写回时依然看不见，最后把损坏后的内容原子写回远端，毁的是远端文件本身。
  it('8KB 之后才出现的 NUL 也要判为二进制（刻意收紧：漏判会让编辑器毁掉远端文件）', () => {
    const buf = Buffer.concat([Buffer.alloc(OLD_SNIFF_BYTES, 0x61), Buffer.from([0x00])])
    expect(looksBinary(buf)).toBe(true)
  })

  it('前 8KB 全是文本、第 9KB 才有 NUL：仍是二进制（带 ASCII 头的 SQLite/PDF 就长这样）', () => {
    const buf = Buffer.alloc(OLD_SNIFF_BYTES * 2, 0x61)
    buf[OLD_SNIFF_BYTES + 512] = 0x00
    expect(looksBinary(buf)).toBe(true)
  })

  it('旧嗅探窗口最后一个字节上的 NUL 仍要抓到', () => {
    const buf = Buffer.alloc(OLD_SNIFF_BYTES, 0x61)
    buf[OLD_SNIFF_BYTES - 1] = 0x00
    expect(looksBinary(buf)).toBe(true)
  })

  it('2MB 边界附近的 NUL 都要抓到（确认没有截断逻辑残留）', () => {
    // 上限整块纯文本：不能因为"扫得远"就误判
    expect(looksBinary(Buffer.alloc(MAX_EDIT_BYTES, 0x61))).toBe(false)

    // 最后一个字节 —— 全量扫描的真正终点，也是任何 subarray 上限最容易切掉的位置
    const atEnd = Buffer.alloc(MAX_EDIT_BYTES, 0x61)
    atEnd[MAX_EDIT_BYTES - 1] = 0x00
    expect(looksBinary(atEnd)).toBe(true)

    // 倒数第二个字节，防止"少扫一位"这种 off-by-one 蒙混过关
    const nearEnd = Buffer.alloc(MAX_EDIT_BYTES, 0x61)
    nearEnd[MAX_EDIT_BYTES - 2] = 0x00
    expect(looksBinary(nearEnd)).toBe(true)
  })
})

describe('tempRelPath', () => {
  it('同一 (sessionId, remotePath) 必须得到同一结果（重复打开复用同一目录）', () => {
    const a = tempRelPath('s1', '/etc/nginx/nginx.conf')
    const b = tempRelPath('s1', '/etc/nginx/nginx.conf')
    expect(a).toEqual(b)
  })

  it('同名不同路径的远端文件落到不同目录', () => {
    const a = tempRelPath('s1', '/etc/nginx/nginx.conf')
    const b = tempRelPath('s1', '/etc/nginx/sites/nginx.conf')
    expect(a.file).toBe(b.file)
    expect(a.dir).not.toBe(b.dir)
  })

  it('sessionId 不同则目录不同（同一路径在两台机器上互不覆盖）', () => {
    expect(tempRelPath('s1', '/etc/hosts').dir).not.toBe(tempRelPath('s2', '/etc/hosts').dir)
  })

  it('目录名是 16 位小写十六进制，且 dir/file 都是单个路径片段', () => {
    const { dir, file } = tempRelPath('s1', '/etc/nginx/nginx.conf')
    expect(dir).toMatch(/^[0-9a-f]{16}$/)
    expect(file).not.toMatch(/[/\\]/)
  })

  it('保留扩展名（编辑器靠它选语法高亮）', () => {
    expect(tempRelPath('s1', '/var/www/app.min.js').file).toBe('app.min.js')
    expect(tempRelPath('s1', '/root/deploy.sh').file).toBe('deploy.sh')
    expect(tempRelPath('s1', '/root/README').file).toBe('README')
  })

  it('远端 basename 为空时回退成 file', () => {
    expect(tempRelPath('s1', '/').file).toBe('file')
    expect(tempRelPath('s1', '').file).toBe('file')
  })

  it('Windows 非法名清洗后仍然是合法文件名', () => {
    const names = ['con', 'a:b', '报告.']
    const cleaned = names.map((n) => tempRelPath('s1', `/tmp/${n}`).file)

    if (process.platform !== 'win32') {
      // 非 win32 上这些名字本来合法，原样落地
      expect(cleaned).toEqual(names)
      return
    }
    expect(cleaned).toEqual(['_con', 'a_b', '报告'])
    // 不用 \u 转义写字符类，免得源文件里真被塞进控制字节
    const illegalChars = '<>:"/\\|?*'
    for (const name of cleaned) {
      expect([...name].some((c) => illegalChars.includes(c))).toBe(false)
      expect([...name].some((c) => c.charCodeAt(0) < 0x20)).toBe(false)
      expect(name).not.toMatch(/[. ]$/)
      expect(name).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i)
    }
  })
})

describe('detectEolRegression', () => {
  const lf = (lines: string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8')
  const crlf = (lines: string[]): Buffer => Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')

  it('纯 LF 存成全 CRLF（记事本的经典毁法）', () => {
    expect(detectEolRegression(lf(['a', 'b', 'c']), crlf(['a', 'b', 'c']))).toBe('lfToCrlf')
  })

  it('反向：纯 CRLF 存成全 LF', () => {
    expect(detectEolRegression(crlf(['a', 'b', 'c']), lf(['a', 'b', 'c']))).toBe('crlfToLf')
  })

  it('两边都是 LF 就是 none（改了内容也不报）', () => {
    expect(detectEolRegression(lf(['a', 'b']), lf(['a', 'b', 'c', 'd']))).toBe('none')
  })

  it('两边都是 CRLF 也是 none', () => {
    expect(detectEolRegression(crlf(['a', 'b']), crlf(['a', 'b', 'c']))).toBe('none')
  })

  it('本来就混行尾的文件不报（无从判断是不是回归）', () => {
    const mixed = Buffer.from('a\nb\r\nc\nd\r\n', 'utf8')
    expect(detectEolRegression(mixed, mixed)).toBe('none')
    // 混行尾被统一成 CRLF 也不报：这本可能正是用户想要的
    expect(detectEolRegression(mixed, crlf(['a', 'b', 'c', 'd']))).toBe('none')
  })

  // 30 行 LF + 1 行 CRLF：既用来验证"基本"不是"完全"，也用来验证个别 CRLF 不触发误报
  const lines = Array.from({ length: 30 }, (_, i) => `line${i}`)
  const almostLf = Buffer.concat([lf(lines), Buffer.from('tail\r\n', 'utf8')])
  const allCrlf = crlf([...lines, 'tail'])

  it('原文夹着零星 CRLF 仍然要报（阈值是"基本"而不是"完全"）', () => {
    expect(detectEolRegression(almostLf, allCrlf)).toBe('lfToCrlf')
  })

  it('反向同样宽容：整体转 LF 时残留个别 CRLF 仍然要报', () => {
    expect(detectEolRegression(allCrlf, almostLf)).toBe('crlfToLf')
  })

  it('存盘只夹进个别 CRLF 不算行尾回归（否则改一行就误报）', () => {
    expect(detectEolRegression(lf([...lines, 'tail']), almostLf)).toBe('none')
  })

  it('没有换行的单行文件与空文件都是 none', () => {
    expect(detectEolRegression(Buffer.from('no newline'), Buffer.from('no newline!'))).toBe('none')
    expect(detectEolRegression(Buffer.alloc(0), crlf(['a', 'b']))).toBe('none')
  })
})

describe('sha256Hex', () => {
  it('对上标准向量', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('一个字节的差别就要换一个摘要', () => {
    expect(sha256Hex(Buffer.from([0x00]))).not.toBe(sha256Hex(Buffer.from([0x01])))
  })

  // 这一份是全项目唯一的 sha256 出口，两类用途都得对着它钉住：
  // 签名 (buf: Buffer) => string 不能变（上层比对内容直接调它），
  // tempRelPath 的目录名也必须真的由它派生 —— 否则"唯一一份"就只是注释里的说法。
  it('tempRelPath 的目录名就是本函数摘要的前 16 位（导出签名与用途都钉住）', () => {
    const dir: string = tempRelPath('s1', '/etc/nginx/nginx.conf').dir
    const expected: string = sha256Hex(Buffer.from('s1\0/etc/nginx/nginx.conf', 'utf8')).slice(0, 16)
    expect(dir).toBe(expected)
  })
})
