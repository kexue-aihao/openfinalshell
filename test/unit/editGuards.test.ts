import { describe, expect, it } from 'vitest'
import { looksBinary, sha256Hex } from '../../src/main/sftp/editGuards'

/**
 * looksBinary 曾经只嗅前 8KB。窗口已经拆掉（改成全量扫描），但这个数字仍然留着当坐标：
 * 下面几条用例专门守在旧窗口的内外两侧，任何人想把窗口加回来都会立刻踩红。
 */
const OLD_SNIFF_BYTES = 8192

/** 调用方那侧的 MAX_EDIT_BYTES：能进这个函数的 buffer 最大就是这么大 */
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

  /**
   * 这一份是全项目唯一的 sha256 出口，签名 (buf: Buffer) => string 不能变 ——
   * 冲突检测与基线都直接调它（见 remoteTextWrite / editBaselines）。
   * 原先这里还钉着「tempRelPath 的目录名由它派生」，那条随外部编辑器一起删掉了。
   */
  it('导出签名钉住：吃 Buffer、吐 64 位十六进制', () => {
    const hex: string = sha256Hex(Buffer.from('x', 'utf8'))
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })
})
