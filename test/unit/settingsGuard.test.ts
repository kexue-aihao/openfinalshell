import { describe, expect, it } from 'vitest'
import { MAIN_ONLY_SETTINGS_PATHS } from '../../src/shared/ipc'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import { stripMainOnlyPaths } from '../../src/main/services/settings'
import type { AppSettings } from '../../src/shared/types'
import { blockAfter, flat, read, stripComments } from '../sourceGuard'

/**
 * "只许 main 自己写的设置字段"那套机制的护栏。
 *
 * ⚠️ **这张表目前是空的。** 唯一那条 `sftp.externalEditorPath` 随外部编辑器一起删掉了，
 * 连同它的使用侧校验（`assertUsableEditor`：必须绝对路径 / Windows 上只放行 .exe /
 * 拒 UNC / 非 win32 查可执行位）—— 那个函数校验的字段已经不存在，留着就是死代码。
 *
 * 那为什么这个文件还在？因为**机制挡住的那个错已经犯过一次**，而那个知识比当时那一条键值钱：
 * 外来数据有**两个**入口（`settings:set` 与 `applyImport`），上一版只有前者剥，
 * 后者整条绕过去 —— 递给受害者一份"导出的配置"就能中，而且全程静默。
 *
 * 所以这里分三层，而且**刻意不假装**在验一个不存在的字段：
 *  1. 表为空这件事被显式断言（连带写清哪天不空了该怎么改）；
 *  2. 循环的行为靠注入一条假路径继续跑 —— 那份行为要在下一次有人加键的**当天**就是对的；
 *  3. 两个入口都还接着这个函数，靠源码护栏钉住（表为空期间行为验不到它）。
 */

type DeepPartialSettings = { [K in keyof AppSettings]?: Partial<AppSettings[K]> }
const patchOf = (p: DeepPartialSettings): Partial<AppSettings> => p as Partial<AppSettings>
const stored = (): AppSettings => structuredClone(DEFAULT_SETTINGS)

/**
 * 注入用的假"只许 main 写"路径。挑 `sftp.downloadDir` 是因为它**真的存在**于设置里 ——
 * 拿一个不存在的键做样例，就分不清"剥掉了"和"压根没这一项"。
 */
const FAKE_PATHS = ['sftp.downloadDir'] as const
const EVIL = 'C:\\Users\\demo\\Downloads\\evil'
const hasKey = (section: unknown, key: string): boolean =>
  Object.keys(section as object).includes(key)

describe('表本身', () => {
  /**
   * 空是**当前的事实**，不是目标。哪天往表里加了键：把这条改成对新键的断言，
   * 下面那几条注入用例也就可以直接改用真表。
   */
  it('目前是空的（唯一那条随外部编辑器删掉了）', () => {
    expect(MAIN_ONLY_SETTINGS_PATHS).toEqual([])
  })

  it('表为空时 stripMainOnlyPaths 是恒等的，而且不谎报剥了东西', () => {
    const patch = patchOf({ sftp: { downloadDir: EVIL }, terminal: { fontSize: 15 } })
    const r = stripMainOnlyPaths(patch, stored())
    expect(r.stripped).toEqual([])
    expect(r.patch).toBe(patch)
  })
})

describe('剥离的行为（注入一条假路径，钉住循环本身）', () => {
  it('只带这一键', () => {
    const r = stripMainOnlyPaths(patchOf({ sftp: { downloadDir: EVIL } }), stored(), FAKE_PATHS)
    expect(r.stripped).toEqual(['sftp.downloadDir'])
    expect(hasKey(r.patch.sftp, 'downloadDir')).toBe(false)
  })

  it('这一键 + 同段别的键：别的键照常保留', () => {
    const r = stripMainOnlyPaths(
      patchOf({ sftp: { downloadDir: EVIL, maxConcurrentGlobal: 6 } }),
      stored(),
      FAKE_PATHS
    )
    expect(r.stripped).toEqual(['sftp.downloadDir'])
    expect(hasKey(r.patch.sftp, 'downloadDir')).toBe(false)
    // 整段一起丢掉也算修坏了 —— 那会让"改个并发数"顺带把别的键重置
    expect(r.patch.sftp?.maxConcurrentGlobal).toBe(6)
  })

  it('设置页那种"整份设置原样带上"：其余段与同段别的键都不受影响', () => {
    const whole = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
    ;(whole.sftp as Record<string, unknown>).downloadDir = EVIL
    ;(whole.terminal as Record<string, unknown>).fontSize = 15
    const r = stripMainOnlyPaths(whole as Partial<AppSettings>, stored(), FAKE_PATHS)
    expect(r.stripped).toEqual(['sftp.downloadDir'])
    expect(hasKey(r.patch.sftp, 'downloadDir')).toBe(false)
    expect(r.patch.terminal?.fontSize).toBe(15)
    expect(r.patch.sftp?.showHiddenFiles).toBe(DEFAULT_SETTINGS.sftp.showHiddenFiles)
  })

  it('不带这些键的 patch 原样通过，也不谎报剥了东西', () => {
    const patch = patchOf({ terminal: { fontSize: 15 } })
    const r = stripMainOnlyPaths(patch, stored(), FAKE_PATHS)
    expect(r.stripped).toEqual([])
    expect(r.patch).toBe(patch)
  })

  it('传进来的 patch 不被就地改写（调用方还要拿它做别的事）', () => {
    const patch = patchOf({ sftp: { downloadDir: EVIL } })
    stripMainOnlyPaths(patch, stored(), FAKE_PATHS)
    expect(hasKey(patch.sftp, 'downloadDir')).toBe(true)
  })
})

/**
 * **两个入口都得接着这一份实现。** 这是整个文件里最值的一段：
 * 上一版只有 settings:set 剥，导入配置那条路整条绕过去，而那个洞在行为上完全静默
 * （导入成功、设置生效、没有任何报错）。表为空期间行为用例验不到它，只能查源码。
 */
describe('两个外来入口都还接着它', () => {
  it('settings:set 的处理器里调了 stripMainOnlyPaths', () => {
    const src = stripComments(read('src/main/ipc/settings.ipc.ts'))
    expect(flat(src)).toContain('stripMainOnlyPaths(')
  })

  it('导入配置的清洗里也调了（换机迁移 / 同事分享一份导出文件同样是外来数据）', () => {
    const src = stripComments(read('src/main/services/importData.ts'))
    const at = src.indexOf('function sanitizeSettings')
    expect(at, 'sanitizeSettings 没了？').toBeGreaterThan(0)
    /**
     * 不用 blockAfter：这个函数的返回类型自带一对花括号，会把窗口在签名那儿就截断。
     * 用定长窗口，并且断言窗口真的盖到了函数尾（它以 `return { patch:` 收尾）——
     * 否则窗口哪天不够长，这条护栏就变成"没找到所以没红"的空转。
     */
    const body = flat(src.slice(at, at + 2600))
    expect(body, '窗口没盖到 sanitizeSettings 的结尾，护栏会空转').toContain('return { patch:')
    expect(body, '导入那条路又绕过剥离了 —— 这个洞犯过一次').toContain('stripMainOnlyPaths(')
  })

  /**
   * 剥离**不能**下沉进 patchSettings：main 自己写这些字段时走的也是它，
   * 塞进去会把唯一的正路一起堵死 —— 那时"只许 main 写"就变成了"谁都写不了"。
   */
  it('patchSettings 里没有剥离 —— 它是可信的内部入口', () => {
    const body = blockAfter(
      stripComments(read('src/main/services/settings.ts')),
      'export function patchSettings'
    )
    expect(body).not.toContain('stripMainOnlyPaths')
  })
})
