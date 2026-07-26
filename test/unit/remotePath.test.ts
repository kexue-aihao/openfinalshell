import { describe, expect, it } from 'vitest'
import {
  assertSafeRemotePath,
  dedupeName,
  longPath,
  remoteAncestors,
  remoteBasename,
  remoteDirname,
  remoteJoin,
  sanitizeLocalName,
  toRemotePath
} from '../../src/main/sftp/remotePath'
import { modeToString, ownerFromLongname, typeFromMode, hasBadName, formatBytes } from '../../src/main/sftp/entryParse'

describe('toRemotePath', () => {
  it('把 Windows 反斜杠转成正斜杠', () => {
    expect(toRemotePath('\\var\\www')).toBe('/var/www')
    expect(toRemotePath('C:\\nope')).toBe('C:/nope')
  })

  it('折叠重复分隔符并去掉尾部斜杠', () => {
    expect(toRemotePath('/var//www///')).toBe('/var/www')
    expect(toRemotePath('/')).toBe('/')
  })

  it('空串归一为根目录', () => {
    expect(toRemotePath('')).toBe('/')
  })
})

describe('remoteJoin / dirname / basename', () => {
  it('拼接始终产出 POSIX 路径', () => {
    expect(remoteJoin('/var', 'www', 'index.html')).toBe('/var/www/index.html')
    expect(remoteJoin('/', 'etc')).toBe('/etc')
    // 即使传入反斜杠也不会污染远端路径
    expect(remoteJoin('/var', 'a\\b')).toBe('/var/a/b')
  })

  it('dirname / basename', () => {
    expect(remoteDirname('/var/www/index.html')).toBe('/var/www')
    expect(remoteDirname('/etc')).toBe('/')
    expect(remoteBasename('/var/www/index.html')).toBe('index.html')
  })
})

describe('remoteAncestors', () => {
  it('从最浅到最深列出各级目录（用于逐级 mkdir）', () => {
    expect(remoteAncestors(toRemotePath('/a/b/c'))).toEqual(['/a', '/a/b', '/a/b/c'])
  })

  it('根目录没有祖先', () => {
    expect(remoteAncestors(toRemotePath('/'))).toEqual([])
  })
})

describe('assertSafeRemotePath', () => {
  /**
   * 这一关只在路径要进 **shell 命令**时跑。别指望 toRemotePath 兜住这些 ——
   * 它只归一化，`toRemotePath('-rf')` 原样返回，既不强制绝对也不剥 `..`。
   */
  it('toRemotePath 确实兜不住（所以守卫必须是另一个函数）', () => {
    expect(toRemotePath('-rf')).toBe('-rf')
    expect(toRemotePath('/a/../etc')).toBe('/a/../etc')
    expect(() => assertSafeRemotePath('-rf')).toThrow()
    expect(() => assertSafeRemotePath('/a/../etc')).toThrow()
  })

  it('放行正常的绝对路径，并原样返回（拒绝而不是规范化）', () => {
    expect(assertSafeRemotePath('/var/log/nginx')).toBe('/var/log/nginx')
    expect(assertSafeRemotePath('/')).toBe('/')
    // 不折叠重复斜杠、不去尾斜杠 —— 审计时"我拒掉的就是你给的那条"
    expect(assertSafeRemotePath('/a//b/')).toBe('/a//b/')
  })

  it.each([
    ['空串', ''],
    ['纯空白', ' \t '],
    ['含 NUL', '/a\0b'],
    ['含换行', '/a\nb'],
    ['含回车', '/a\rb'],
    ['相对路径', 'a/b'],
    ['像选项', '-rf'],
    ['当前目录段', '/a/./b'],
    ['父目录段', '/a/../b'],
    ['结尾 ..', '/a/..'],
    ['超过 4096', `/${'a'.repeat(4100)}`]
  ])('拒绝 %s', (_label, path) => {
    expect(() => assertSafeRemotePath(path)).toThrow()
  })

  it('换行拦在这里而不是 shQuote 里：单引号里的换行是合法字面量，但我们按行解析输出', () => {
    expect(() => assertSafeRemotePath('/data/a\nb')).toThrow(/换行/)
  })

  it('what 参数进得了报错文案（用户看到的是"删除路径…"而不是"远端路径…"）', () => {
    expect(() => assertSafeRemotePath('', '删除路径')).toThrow(/删除路径/)
  })

  it('通配元字符放行（真实文件名里可以有 *，我们单引号包着它是字面量）', () => {
    expect(assertSafeRemotePath('/data/*.log')).toBe('/data/*.log')
    expect(assertSafeRemotePath("/data/it's")).toBe("/data/it's")
  })
})

describe('sanitizeLocalName', () => {
  const isWin = process.platform === 'win32'

  it('Windows 上替换非法字符与保留名', () => {
    if (!isWin) {
      expect(sanitizeLocalName('a:b')).toBe('a:b')
      return
    }
    expect(sanitizeLocalName('a:b')).toBe('a_b')
    expect(sanitizeLocalName('a?b*c')).toBe('a_b_c')
    expect(sanitizeLocalName('con')).toBe('_con')
    expect(sanitizeLocalName('CON.txt')).toBe('_CON.txt')
    expect(sanitizeLocalName('trailing.')).toBe('trailing')
    expect(sanitizeLocalName('trailing ')).toBe('trailing')
    expect(sanitizeLocalName('...')).toBe('_')
  })

  it('正常名字不变', () => {
    expect(sanitizeLocalName('normal-name_1.txt')).toBe('normal-name_1.txt')
    expect(sanitizeLocalName('中文名.txt')).toBe('中文名.txt')
  })
})

describe('longPath', () => {
  it('超长路径加 \\\\?\\ 前缀（仅 Windows）', () => {
    const long = `C:\\${'a'.repeat(300)}`
    if (process.platform === 'win32') {
      expect(longPath(long).startsWith('\\\\?\\')) .toBe(true)
      expect(longPath('C:\\short')).toBe('C:\\short')
      // 已有前缀不重复添加
      expect(longPath(`\\\\?\\${long}`)).toBe(`\\\\?\\${long}`)
    } else {
      expect(longPath(long)).toBe(long)
    }
  })
})

describe('dedupeName', () => {
  it('冲突时追加 (2)(3)，保留扩展名', () => {
    const taken = new Set(['a.txt', 'a (2).txt'])
    expect(dedupeName('a.txt', (c) => taken.has(c))).toBe('a (3).txt')
    expect(dedupeName('b.txt', (c) => taken.has(c))).toBe('b.txt')
  })

  it('无扩展名也能处理', () => {
    const taken = new Set(['README'])
    expect(dedupeName('README', (c) => taken.has(c))).toBe('README (2)')
  })
})

describe('entryParse', () => {
  it('typeFromMode 识别目录/文件/符号链接', () => {
    expect(typeFromMode(0o040755)).toBe('dir')
    expect(typeFromMode(0o100644)).toBe('file')
    expect(typeFromMode(0o120777)).toBe('symlink')
    expect(typeFromMode(0o010644)).toBe('other')
  })

  it('modeToString 生成 rwx 串', () => {
    expect(modeToString(0o100644, 'file')).toBe('-rw-r--r--')
    expect(modeToString(0o040755, 'dir')).toBe('drwxr-xr-x')
    expect(modeToString(0o120777, 'symlink')).toBe('lrwxrwxrwx')
    expect(modeToString(0o100000, 'file')).toBe('----------')
  })

  it('ownerFromLongname 解析属主与组', () => {
    expect(ownerFromLongname('-rw-r--r--  1 root  wheel  1234 Jan  1 00:00 x')).toEqual({
      owner: 'root',
      group: 'wheel'
    })
    // 格式不符时不硬解析
    expect(ownerFromLongname('weird output')).toEqual({ owner: '', group: '' })
  })

  it('hasBadName 检出非 UTF-8 文件名', () => {
    expect(hasBadName('正常.txt')).toBe(false)
    expect(hasBadName('bad\uFFFDname')).toBe(true)
  })

  it('formatBytes 人类可读', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(1536)).toBe('1.50 KB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MB')
  })
})
