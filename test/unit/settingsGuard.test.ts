import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import { assertUsableEditor, stripMainOnlyPaths } from '../../src/main/services/settings'
import type { AppSettings } from '../../src/shared/types'

/**
 * settings.sftp.externalEditorPath 那两道门的护栏。
 *
 * 直接调 main 侧那两个导出的纯函数，不经 IPC、不经渲染进程的桩：护栏要盯的正是
 * "main 里这两个函数还在、还管事"。对着 mock IPC 的重实现断言的话，把 main 侧的
 * 实现整个删掉它依然是绿的 —— 那种绿不值钱。
 *
 * 这个字段的分量：它最终是 RemoteEditManager.launchEditor 里 spawn 的**可执行文件**。
 *  - stripMainOnlyPaths 管**写入侧**：settings:set 与导入配置这两个外来入口都不许写它；
 *  - assertUsableEditor 管**使用侧**：不管值是怎么进来的（老版本、导入文件、手改 SQLite），
 *    spawn 之前都要再看一眼。
 */

/**
 * 真实的 patch 是"深部分"的：设置页只带改动的那几键、导入文件里更是想写什么写什么。
 * 契约上的类型是 Partial<AppSettings>（只有顶层可选），所以造样例得过这一次断言 ——
 * 运行时缺键是安全的，patchSettings 是深合并，缺键就是"这一项不改"。
 */
type DeepPartialSettings = { [K in keyof AppSettings]?: Partial<AppSettings[K]> }
const patchOf = (p: DeepPartialSettings): Partial<AppSettings> => p as Partial<AppSettings>

/** 库里那份现值。用默认值克隆，免得把 DocStore/SQLite 拖进这条纯函数的用例 */
const stored = (): AppSettings => structuredClone(DEFAULT_SETTINGS)

const EVIL = 'C:\\Users\\demo\\Downloads\\payload.exe'
const hasEditorKey = (section: unknown): boolean =>
  Object.keys(section as object).includes('externalEditorPath')

describe('stripMainOnlyPaths：三种 patch 形状都要剥掉 externalEditorPath', () => {
  it('只带这一键', () => {
    const r = stripMainOnlyPaths(patchOf({ sftp: { externalEditorPath: EVIL } }), stored())
    expect(r.stripped).toEqual(['sftp.externalEditorPath'])
    expect(hasEditorKey(r.patch.sftp)).toBe(false)
  })

  it('这一键 + 同段别的键：别的键照常保留', () => {
    const r = stripMainOnlyPaths(
      patchOf({ sftp: { externalEditorPath: EVIL, showHiddenFiles: false, maxConcurrentGlobal: 7 } }),
      stored()
    )
    expect(r.stripped).toEqual(['sftp.externalEditorPath'])
    expect(hasEditorKey(r.patch.sftp)).toBe(false)
    // 剥一个键不许把同段的别的改动一起丢掉（"整段扔掉"是另一种坏修法）
    expect(r.patch.sftp!.showHiddenFiles).toBe(false)
    expect(r.patch.sftp!.maxConcurrentGlobal).toBe(7)
  })

  it('设置页那种"整份设置原样带上"：其余段与同段别的键都不受影响', () => {
    const whole = structuredClone(DEFAULT_SETTINGS)
    whole.sftp.externalEditorPath = EVIL
    whole.sftp.showHiddenFiles = false
    whole.terminal.fontSize = 19

    const r = stripMainOnlyPaths(whole, stored())
    expect(r.stripped).toEqual(['sftp.externalEditorPath'])
    expect(hasEditorKey(r.patch.sftp)).toBe(false)
    expect(r.patch.sftp!.showHiddenFiles).toBe(false)
    expect(r.patch.sftp!.conflictPolicy).toBe(DEFAULT_SETTINGS.sftp.conflictPolicy)
    expect(r.patch.terminal!.fontSize).toBe(19)
    expect(r.patch.language).toBe(DEFAULT_SETTINGS.language)
  })

  it('不带这些键的 patch 原样通过，也不谎报剥了东西', () => {
    const r = stripMainOnlyPaths(patchOf({ sftp: { showHiddenFiles: false } }), stored())
    expect(r.stripped).toEqual([])
    expect(r.patch.sftp!.showHiddenFiles).toBe(false)
  })

  it('传进来的 patch 不被就地改写（调用方还要拿它做别的事）', () => {
    const original = patchOf({ sftp: { externalEditorPath: EVIL } })
    stripMainOnlyPaths(original, stored())
    expect(hasEditorKey(original.sftp)).toBe(true)
  })
})

describe('assertUsableEditor：spawn 之前的那一眼', () => {
  const isWin = process.platform === 'win32'
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ofs-editor-guard-'))
    // 名字带 .exe 的**目录**：win32 上过得了扩展名那条，必须被 isFile 挡住
    mkdirSync(join(dir, 'looks-like.exe'))
    writeFileSync(join(dir, 'hook.bat'), '@echo off\r\n', 'utf8')
    writeFileSync(join(dir, 'hook.cmd'), '@echo off\r\n', 'utf8')
    writeFileSync(join(dir, 'plain.txt'), '不是程序', 'utf8')
  })

  it('相对路径与裸文件名一律拒（裸名字会先试当前工作目录里的同名 exe）', async () => {
    await expect(assertUsableEditor('editor.exe')).rejects.toThrow(/绝对路径/)
    await expect(assertUsableEditor('notepad')).rejects.toThrow(/绝对路径/)
    await expect(assertUsableEditor('./tools/editor.exe')).rejects.toThrow(/绝对路径/)
    await expect(assertUsableEditor('')).rejects.toThrow(/绝对路径/)
  })

  it('目录不行、不存在的路径不行', async () => {
    await expect(assertUsableEditor(join(dir, 'looks-like.exe'))).rejects.toThrow(/不是文件/)
    await expect(assertUsableEditor(join(dir, 'nope.exe'))).rejects.toThrow(/不存在/)
  })

  it('win32：只放行 .exe —— .bat/.cmd 要经 cmd.exe 解释执行', async () => {
    if (!isWin) {
      // POSIX 上没有扩展名这回事，挡住它们是可执行位那条的活
      await expect(assertUsableEditor(join(dir, 'hook.bat'))).rejects.toThrow(/可执行权限/)
      return
    }
    await expect(assertUsableEditor(join(dir, 'hook.bat'))).rejects.toThrow(/只接受 \.exe/)
    await expect(assertUsableEditor(join(dir, 'hook.cmd'))).rejects.toThrow(/只接受 \.exe/)
  })

  it('win32：拒 UNC / 设备路径 —— 网络共享上的内容随时可换', async () => {
    if (!isWin) {
      // POSIX 上 \\host\share 连绝对路径都不是，第一条就挡住了
      await expect(assertUsableEditor('\\\\evil-host\\share\\editor')).rejects.toThrow(/绝对路径/)
      return
    }
    // isAbsolute 认这三种，扩展名也是 .exe，stat 经 SMB 一样报 isFile
    await expect(assertUsableEditor('\\\\evil-host\\share\\editor.exe')).rejects.toThrow(/UNC/)
    await expect(assertUsableEditor('//evil-host/share/editor.exe')).rejects.toThrow(/UNC/)
    await expect(assertUsableEditor('\\\\?\\UNC\\evil-host\\share\\editor.exe')).rejects.toThrow(
      /UNC/
    )
  })

  it('非 win32：查可执行位 —— 纯文本文件不能当编辑器', async () => {
    if (isWin) {
      // win32 上没有可执行位可查，.txt 被扩展名那条挡住
      await expect(assertUsableEditor(join(dir, 'plain.txt'))).rejects.toThrow(/只接受 \.exe/)
      return
    }
    await expect(assertUsableEditor(join(dir, 'plain.txt'))).rejects.toThrow(/可执行权限/)
  })

  it('真实存在的可执行文件要过（不然这几条全是空转）', async () => {
    // 本进程自己的 exe：win32 上是 node.exe（绝对路径 + .exe + 是文件），POSIX 上有可执行位
    await expect(assertUsableEditor(process.execPath)).resolves.toBeUndefined()
    if (isWin) {
      const notepad = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
      // 精简版 Windows 上可能真没有它，缺了就跳过 —— 上面那条已经证明"能过"这件事
      if (existsSync(notepad)) {
        await expect(assertUsableEditor(notepad)).resolves.toBeUndefined()
      }
    }
  })
})
