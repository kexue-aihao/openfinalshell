import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { blockAfter, channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * 快速删除这一片的护栏。挑的每一处都有同一个特征：**错了不抛异常、不影响编译，
 * 只是让一条 `rm -rf` 悄悄变得不那么安全**。
 *
 *  1. 展示给用户的命令与真正执行的命令必须出自**同一个构造器**。展示一条、执行另一条
 *     是这种界面最恶劣的失效方式 —— 用户亲眼确认过的东西不是发出去的那个。
 *  2. 守卫必须在 main 侧、在 `fastDelete` 那条路上也跑一遍，不能只在 preview 里跑
 *     （preview 与 fastDelete 是两条独立 channel，渲染进程完全可以只调后面那条）。
 *  3. 刷新必须**排在所有结果分支之前且只有一处**：三种结果都可能已经删掉了一部分东西。
 *  4. 确认框必须是**独立**那一套（`我确认删除` + 命令原文），不能退化成普通删除那个框。
 *  5. 菜单项必须同时受设置开关与"全是目录"两个条件约束。
 *  6. shell 命令只许在 main 侧拼 —— 渲染进程里不该出现第二份 `rm` 命令拼装或转义函数。
 */

const SFTP_PANE = 'src/renderer/src/features/sftp/SftpPane.tsx'
const FAST_DELETE = 'src/main/sftp/fastDelete.ts'
const SFTP_IPC = 'src/main/ipc/sftp.ipc.ts'

describe('契约与命名', () => {
  it('两条 channel 都在 sftp: 前缀下（换个前缀就被 preload 拦在门外）', () => {
    const invoke = channelsOf('InvokeMap')
    expect(invoke).toContain('sftp:fastDeletePreview')
    expect(invoke).toContain('sftp:fastDelete')
  })

  it('preview 不收 sessionId —— 它是纯的，收了就意味着有人给它加了副作用', () => {
    const src = stripComments(read('src/shared/ipc.ts'))
    const decl = flat(src.slice(src.indexOf("'sftp:fastDeletePreview'"), src.indexOf("'sftp:fastDelete'")))
    expect(decl).not.toContain('sessionId')
    // zod 那侧也得对得上
    const ipc = flat(stripComments(read(SFTP_IPC)))
    expect(ipc).toContain('handle( \'sftp:fastDeletePreview\', ({ paths }) => fastDeletePreview(paths)')
  })
})

describe('展示的命令与执行的命令是同一个', () => {
  const src = stripComments(read(FAST_DELETE))

  it('preview 与 fastDelete 都经 buildFastDeleteCommand，没人自己拼字符串', () => {
    expect(flat(blockAfter(src, 'export function fastDeletePreview'))).toContain(
      'buildFastDeleteCommand('
    )
    expect(flat(blockAfter(src, 'export async function fastDelete('))).toContain(
      'buildFastDeleteCommand('
    )
  })

  it('只有一处拼 rm 命令（多一处就有"展示的和执行的不一样"的空间）', () => {
    expect(src.match(/rm -rf --/g) ?? []).toHaveLength(1)
  })

  it('守卫长在构造器里，所以两条路都躲不过', () => {
    expect(flat(blockAfter(src, 'export function buildFastDeleteCommand'))).toContain(
      'assertDeletable('
    )
  })

  it('执行那条路真的过 execOnce（而不是自己开通道发裸命令）', () => {
    expect(flat(blockAfter(src, 'export async function fastDelete('))).toContain('execOnce(')
  })
})

describe('深度规则不许被悄悄放宽', () => {
  const src = stripComments(read(FAST_DELETE))

  /**
   * 深度规则**只是第二道**：`/a/../../etc` 有三段，靠它是拦不住的 —— 拦住的是
   * assertSafeRemotePath 里那条"不许有 `.`/`..` 段"。所以这里钉的是"通用守卫真的还在被调"。
   *
   * （原本这里还有一条"通用守卫必须排在层级计算之前"的断言，已删掉：
   *   先 split 再校验并不是缺陷 —— 校验一抛就轮不到深度判断了，那条断言永远绿。）
   */
  it('assertDeletable 真的还在调通用守卫，且层级算在校验过的路径上', () => {
    const body = flat(blockAfter(src, 'export function assertDeletable'))
    expect(body).toContain("assertSafeRemotePath(raw, '删除路径')")
    expect(body).toContain("p.split('/').filter(Boolean)")
  })

  /**
   * 这一条是**刻意的封条**。计划里写明"这条限制要写进文档，不要事后放宽"——
   * 把它改成 1 就等于把 `/etc`、`/root`、`/usr` 一次性全放出来，而那个改动只有一个字符。
   */
  it('最少两级这个数字被钉住了', () => {
    expect(src).toContain('export const FAST_DELETE_MIN_SEGMENTS = 2')
  })
})

describe('界面：确认框与刷新', () => {
  const pane = stripComments(read(SFTP_PANE))
  const doFastDelete = blockAfter(pane, 'const doFastDelete =')
  const onOk = blockAfter(doFastDelete, 'onOk: async ()')

  /**
   * 两条断言合起来才等于"每条路都刷新了"：
   *  - 只有一处 → 没人把它抄成每分支一份（抄成 N 份迟早漏一份，漏掉的那次表现是"看着还在，其实没了"）；
   *  - 排在第一个 return 之前 → 没有任何一条路能绕过它（每个分支都以 return 结尾）。
   * 光断言"存在"是空转的：挪到只有成功分支才刷新，那种写法照样含有这行。
   */
  it('刷新只有一处，且排在任何 return 之前', () => {
    expect(onOk.match(/load\(cwd, false\)/g) ?? []).toHaveLength(1)
    const refreshAt = onOk.indexOf('load(cwd, false)')
    expect(refreshAt).toBeGreaterThanOrEqual(0)
    expect(onOk.indexOf('return')).toBeGreaterThan(refreshAt)
    for (const branch of ['modal.error', 'message.success']) {
      expect(onOk.indexOf(branch), branch).toBeGreaterThan(refreshAt)
    }
  })

  it('三种结果各有出口：未知 / 部分未完成 / 非零状态，成功才 success', () => {
    const flatOk = flat(onOk)
    expect(flatOk).toContain('exitCode === null')
    expect(flatOk).toContain('leftover.length > 0')
    expect(flatOk).toContain('exitCode !== 0')
    expect(flatOk).toContain("t('sftp.fastDeleteDone'")
  })

  it('确认框是独立那一套：命令原文 + 我确认删除，不复用普通删除的文案', () => {
    const flatBody = flat(doFastDelete)
    expect(flatBody).toContain('preview.command')
    expect(flatBody).toContain("t('sftp.fastDeleteOk')")
    expect(flatBody).toContain("t('sftp.fastDeleteWarning')")
    // 复用 common.delete 就等于让用户在肌肉记忆里点掉一条 rm -rf
    expect(flatBody).not.toContain("t('common.delete')")
    expect(flatBody).not.toContain("t('sftp.deleteConfirm')")
  })

  it('守卫在弹框之前跑：preview 的报错走 message.error 并 return，不进 modal', () => {
    const before = doFastDelete.slice(0, doFastDelete.indexOf('modal.confirm'))
    expect(flat(before)).toContain("ofs.invoke('sftp:fastDeletePreview'")
    expect(flat(before)).toContain('message.error(')
  })
})

describe('界面：菜单项的两个闸门', () => {
  const pane = stripComments(read(SFTP_PANE))
  const contextItems = blockAfter(pane, 'const contextItems =')

  it('受设置开关约束', () => {
    expect(flat(contextItems)).toContain('settings.sftp.fastDelete')
  })

  it('只对目录、且要求这一批全是目录', () => {
    const flatBody = flat(contextItems)
    expect(flatBody).toContain('every((e) => isDir(e)')
    expect(flatBody).toContain("key: 'fastDelete', label: t('sftp.fastDelete'), danger: true, disabled: !allDirs")
  })

  /**
   * 菜单算禁用态和点击处理必须用**同一个**函数算"作用于哪些条目" ——
   * 分成两处写的后果是"菜单上是灰的但点了有反应"，而其中一处是 rm -rf。
   */
  it('菜单与点击处理共用 targetsFor', () => {
    expect(flat(contextItems)).toContain('targetsFor(target)')
    expect(flat(blockAfter(pane, 'const onContextClick ='))).toContain('targetsFor(target)')
  })
})

describe('shell 命令只在 main 侧拼', () => {
  it('渲染进程里没有第二份转义函数或 rm 命令拼装（mock 那条占位不算）', () => {
    for (const rel of [SFTP_PANE, 'src/renderer/src/features/settings/SettingsModal.tsx']) {
      const src = stripComments(read(rel))
      expect(src, rel).not.toContain('shQuote')
      expect(src, rel).not.toContain('rm -rf')
    }
  })

  /**
   * mock 只负责让界面在浏览器调试模式里能走完一遍流程，**刻意不重实现守卫与命令构造**。
   * 重实现一遍只会得到"自己跟自己对"的假绿 —— externalEditorPath 那条护栏就是这么空转的。
   */
  it('mock 的命令是明确标注的占位，不冒充真命令', () => {
    const mock = stripComments(read('src/renderer/src/ipc/mock.ts'))
    const block = mock.slice(mock.indexOf("'sftp:fastDeletePreview'"), mock.indexOf("'sftp:editOpen'"))
    // 找 '# mock' 这个注释标记本身，不是"这段里有 mock 这三个字母"——
    // 那种写法被 mockDeleted 之类的标识符白送成绿的
    expect(block).toContain('# mock')
    expect(block).not.toContain('assertDeletable')
    expect(block).not.toContain('FAST_DELETE_MIN_SEGMENTS')
  })
})

describe('设置与文案', () => {
  it('默认开（默认关会让这个对标 FinalShell 的功能没人发现）', () => {
    expect(DEFAULT_SETTINGS.sftp.fastDelete).toBe(true)
  })

  it('两种语言的确认按钮都不是"删除"（避开普通删除练出来的肌肉记忆）', () => {
    expect(zh.translation.sftp.fastDeleteOk).not.toBe(zh.translation.common.delete)
    expect(en.translation.sftp.fastDeleteOk).not.toBe(en.translation.common.delete)
  })

  it('警告文案说清"不进回收站/不可恢复"，设置说明写明层级限制', () => {
    expect(zh.translation.sftp.fastDeleteWarning).toMatch(/回收站/)
    expect(zh.translation.sftp.fastDeleteWarning).toMatch(/不可恢复/)
    expect(zh.translation.settings.fastDeleteHint).toMatch(/两级/)
    expect(en.translation.settings.fastDeleteHint).toMatch(/two segments/)
  })
})
