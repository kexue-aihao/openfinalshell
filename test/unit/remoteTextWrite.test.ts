import { describe, expect, it } from 'vitest'
import { looksTruncated, siblingTempPath } from '../../src/main/sftp/remoteTextWrite'
import { read, stripComments } from '../sourceGuard'

/**
 * 写回那一层的纯函数。
 *
 * `saveRemoteText` 本身的语义（冲突检测、原子替换、非原子替换的备份顺序、chmod 兜底）
 * 目前由 test/unit/remoteEditManager.test.ts 的 67 条用例覆盖 —— 那些工具函数就是从
 * 那条路上提出来的，两边跑的是同一份代码。等内置编辑器的保存接上来（片 3 剩下的部分），
 * 这里要补一套直接对着 saveRemoteText 的用例，因为届时 gates 的三个开关
 * （overwriteRemoteChanges / allowNonAtomic / allowShrink）会成为渲染进程可控输入。
 */

describe('looksTruncated', () => {
  /**
   * 两条判据各自的门槛。表里每一行都对应一个真实场景，别当成随机取值：
   * 40 字节的 .env 与 20KB 的 nginx.conf 被清空一样致命，所以 0 字节那档不设尺寸门槛；
   * 而几百字节的文件里删掉一多半是日常编辑，所以比例判据必须配尺寸门槛。
   */
  it.each([
    // [远端字节, 新字节, 是否算截断, 场景]
    [0, 0, false, '空文件存成空文件（新建文件的第一次保存）'],
    [0, 10, false, '空文件写进内容'],
    [40, 0, true, '40 字节的 .env 被清空 —— 与文件大小无关，一律拦'],
    [20480, 0, true, '20KB 的 nginx.conf 被清空'],
    [4096, 1023, true, '4KB 缩到 1/4 以下'],
    [4096, 1024, false, '正好 1/4 不算（判据是严格小于）'],
    [4095, 1, false, '不到 4KB：比例判据不生效，几百字节里删一多半是日常编辑'],
    [500, 10, false, '.env 里删掉一多半'],
    [100000, 60000, false, '把长配置精简掉四成'],
    [100000, 24999, true, '把长配置缩到 1/4 以下'],
    [1000, 1200, false, '变长了']
  ])('远端 %i → 新 %i = %s（%s）', (remote, next, expected) => {
    expect(looksTruncated(remote, next)).toBe(expected)
  })
})

describe('siblingTempPath', () => {
  it('落在同一个目录下、以点开头（同目录是 rename 能成的硬要求）', () => {
    const p = siblingTempPath('/etc/nginx/nginx.conf', '.ofsedit-')
    expect(p.startsWith('/etc/nginx/.')).toBe(true)
    expect(p).toContain('.ofsedit-')
    // 不许把目标本身的路径直接拿去用
    expect(p).not.toBe('/etc/nginx/nginx.conf')
  })

  it('每次都不一样（同一目标连叫两次不能撞名）', () => {
    const a = siblingTempPath('/etc/x.conf', '.ofsedit-')
    const b = siblingTempPath('/etc/x.conf', '.ofsedit-')
    expect(a).not.toBe(b)
  })

  it('名字长度不超过文件系统单段上限（长名会被截掉主名部分）', () => {
    const long = `/etc/${'x'.repeat(300)}.conf`
    const p = siblingTempPath(long, '.ofsbak-')
    const base = p.slice(p.lastIndexOf('/') + 1)
    expect(Buffer.byteLength(base, 'utf8')).toBeLessThanOrEqual(255)
    // 截了主名也必须留下后缀与随机部分，否则两次调用会撞名
    expect(base).toContain('.ofsbak-')
  })

  it('中文名按字节算长度，不按字符数', () => {
    // 90 个中文 = 270 字节，已经超过 255：必须被截
    const p = siblingTempPath(`/srv/${'配'.repeat(90)}.conf`, '.ofsedit-')
    const base = p.slice(p.lastIndexOf('/') + 1)
    expect(Buffer.byteLength(base, 'utf8')).toBeLessThanOrEqual(255)
  })
})

/**
 * 随机名必须来自 randomBytes。
 *
 * 这条只能靠源码护栏：`Math.random()` 和 `randomBytes()` 都会让"两次调用不一样"
 * 那条行为用例通过，可预测性测不出来。而这个名字是符号链接抢占防线的一半 ——
 * EXCL 保证"名字被占了就换一个"，不可预测保证"别人猜不到下一个用哪个名字"。
 *
 * 这不是假想的：第一版就写成了 Math.random，是 randomBytes 变成未使用的导入才发现的。
 */
describe('临时名的随机性来源', () => {
  const src = stripComments(read('src/main/sftp/remoteTextWrite.ts'))

  it('用 randomBytes，不用 Math.random', () => {
    expect(src).toContain('randomBytes(')
    expect(src, '临时名的随机数退回 Math.random 了 —— 名字变成可预测的').not.toContain('Math.random')
  })

  it('临时文件一律排他创建（wx），绝不用 w', () => {
    expect(src).toContain("'wx'")
    // 'w' 会跟随符号链接：别人先摆一个软链，这次写入就落到他选的路径上
    expect(src).not.toMatch(/writeRemoteFile\([^)]*'w'\s*\)/)
  })
})
