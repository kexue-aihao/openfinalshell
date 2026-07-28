import { describe, expect, it } from 'vitest'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { blockAfter, channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * 「已保存的代理 / 私钥」这一片的源码护栏。每一条守的都是"改错了编译得过、界面看着正常，
 * 只是悄悄走偏"的地方：
 *
 *  1. 契约与前缀 —— 前缀漏进白名单，6 条 channel 全被 preload 拦在门外。
 *  2. **删连接不许清共享实体的密码**（deleteProfile）、**复制连接不许复制它们的 ref**
 *     （duplicateProfile）。这两条坏掉时不抛异常，用户下次连接才发现密码没了。
 *  3. 拨号侧"引用查不到就报错，绝不静默直连"—— 静默直连等于暴露真实来源。
 *  4. 内联字段只有**一个**抽取实现（extractInlineRefs），升级迁移与导入老文件共用它。
 *  5. 导出必须扫两张新表的 ref，否则含密码导出里没有代理密码与私钥口令。
 *  6. 抽屉提交仍用 getFieldsValue(true)（折叠面板不挂载那个坑）。
 */

const CONNS = 'src/main/store/connections.ts'
const SAVED = 'src/main/store/savedRefs.ts'
const AUTH = 'src/main/ssh/auth.ts'
const EXPORT = 'src/main/services/exportData.ts'
const IMPORT = 'src/main/services/importData.ts'
const DRAWER = 'src/renderer/src/features/connections/ProfileEditDrawer.tsx'

describe('契约', () => {
  it('6 条 channel 都在 InvokeMap 里', () => {
    const invoke = channelsOf('InvokeMap')
    for (const c of [
      'proxy:list',
      'proxy:save',
      'proxy:delete',
      'key:list',
      'key:save',
      'key:delete'
    ]) {
      expect(invoke).toContain(c)
    }
  })

  it("'proxy:' 与 'key:' 在 preload 的前缀白名单里", () => {
    const src = stripComments(read('src/shared/ipc.ts'))
    const at = src.indexOf('export const CHANNEL_PREFIXES')
    const list = src.slice(at, src.indexOf('] as const', at))
    expect(list).toContain("'proxy:'")
    expect(list).toContain("'key:'")
  })

  it('删除那两条返回 DeleteRefResult 而不是抛异常（被引用不是错误）', () => {
    const src = stripComments(read('src/shared/ipc.ts'))
    const decl = flat(src.slice(src.indexOf("'proxy:delete'"), src.indexOf("'key:list'")))
    expect(decl).toContain('DeleteRefResult')
    // main 侧那两个函数返回值也必须是它
    const saved = stripComments(read(SAVED))
    expect(flat(saved)).toContain('export function deleteProxy(id: ProxyId): DeleteRefResult')
    expect(flat(saved)).toContain(
      'export function deletePrivateKey(id: PrivateKeyId): DeleteRefResult'
    )
  })

  it('草稿类型里没有内联代理 —— 不留第二条写代理的路', () => {
    const types = stripComments(read('src/shared/types.ts'))
    const draft = flat(blockAfter(types, 'export interface ProfileDraft'))
    expect(draft).not.toContain('proxy:')
    expect(draft).not.toContain('privateKeyPath')
    // conn:save 那侧的 zod 同样不许再收它们
    const ipc = flat(stripComments(read('src/main/ipc/conn.ipc.ts')))
    expect(ipc).toContain('proxyId:')
    expect(ipc).not.toContain('privateKeyPath')
  })
})

describe('共享语义（这两条坏掉时不抛异常）', () => {
  const src = stripComments(read(CONNS))

  it('deleteProfile 只清它自己独占的登录密码', () => {
    const body = flat(blockAfter(src, 'export function deleteProfile'))
    expect(body).toContain('vault.deleteSecret(p.auth.passwordRef)')
    // 共享实体的 ref 一个都不许在这里删
    expect(body).not.toContain('proxy?.passwordRef')
    expect(body).not.toContain('passphraseRef')
  })

  it('duplicateProfile 不复制共享实体的 ref（复制会留下 Vault 孤儿）', () => {
    const body = flat(blockAfter(src, 'export function duplicateProfile'))
    expect(body).toContain('passwordRef: copyRef(src.auth.passwordRef)')
    expect(body).not.toContain('copyRef(src.proxy')
    expect(body).not.toContain('copyRef(src.auth.passphraseRef)')
  })

  it('删除实体时才清它的 Vault 条目，且排在"没人引用"之后', () => {
    const saved = stripComments(read(SAVED))
    const del = flat(blockAfter(saved, 'export function deleteProxy'))
    // 先查引用、被引用就返回，之后才删
    expect(del.indexOf('usedBy.length > 0')).toBeLessThan(del.indexOf('vault.deleteSecret'))
  })
})

describe('拨号侧', () => {
  const src = stripComments(read(AUTH))

  it('引用查不到 / 地址为空都抛 ProxyError，绝不返回 null 静默直连', () => {
    const body = flat(blockAfter(src, 'export function resolveProxy'))
    // 唯一允许返回 null 的分支是"压根没引用代理"
    expect(body).toContain('if (!profile.proxyId) return null')
    expect(body.match(/return null/g) ?? []).toHaveLength(1)
    expect(body.match(/throw new ProxyError/g) ?? []).toHaveLength(2)
  })

  it('私钥按 id 查表，报错要指名是哪一条', () => {
    expect(src).toContain('getPrivateKey(keyId)')
    expect(src).toContain('读不到私钥「${key.name}」的文件')
  })

  it('proxyDial 仍然不认识引用、也不碰 Vault', () => {
    const dial = stripComments(read('src/main/ssh/proxyDial.ts'))
    expect(dial).not.toContain('passwordRef')
    expect(dial).not.toContain('Vault')
    expect(dial).not.toContain('proxyId')
  })
})

describe('抽取只有一份实现', () => {
  it('extractInlineRefs 是唯一的抽取者，迁移与导入都调它', () => {
    const conns = stripComments(read(CONNS))
    expect(conns).toContain('export function extractInlineRefs')
    expect(flat(blockAfter(conns, 'export function migrateInlineRefsOnce'))).toContain(
      'extractInlineRefs(profiles)'
    )
    expect(stripComments(read(IMPORT))).toContain('extractInlineRefs(imported)')
  })

  it('导入侧没有自己再写一遍去重/建实体的逻辑', () => {
    const imp = stripComments(read(IMPORT))
    // 只允许原样 upsert 文件里带的那些，不许出现"按 host/port 去重"这类痕迹
    expect(imp).not.toContain('proxyByKey')
    expect(imp).not.toContain('keysByPath')
  })

  it('extractInlineRefs 不自己开事务（调用方已在 tx 里，嵌套会当场炸）', () => {
    const body = blockAfter(stripComments(read(CONNS)), 'export function extractInlineRefs')
    expect(body).not.toContain('tx(')
  })
})

describe('导出必须扫两张新表的 ref', () => {
  it('referencedRefs 收 proxies 与 privateKeys 的 ref', () => {
    const body = flat(blockAfter(stripComments(read(EXPORT)), 'function referencedRefs'))
    expect(body).toContain('data.proxies')
    expect(body).toContain('data.privateKeys')
    expect(body).toContain('x.passwordRef')
    expect(body).toContain('k.passphraseRef')
  })

  it('信封里带这两个数组', () => {
    const src = stripComments(read(EXPORT))
    expect(flat(src)).toContain('proxies: unknown[]')
    expect(flat(src)).toContain('privateKeys: unknown[]')
    expect(flat(blockAfter(src, 'function collect'))).toContain('FROM proxies')
  })

  it('两类实体的写入排在 profiles 之前（连接引用它们）', () => {
    const body = stripComments(read(IMPORT))
    const proxyWrite = body.indexOf('for (const x of parsed.proxies)')
    /*
     * 必须定位到**写入**那个循环（带花括号）。`for (const p of parsed.profiles)` 在文件里
     * 出现两次，头一次是 duplicate 模式预分配 id 的单行写法 —— 按它比较会永远为假，
     * 而这条护栏就成了摆设。（这个错本条护栏自己抓到过一次。）
     */
    const profileWrite = body.indexOf('for (const p of parsed.profiles) {')
    expect(proxyWrite).toBeGreaterThan(0)
    expect(profileWrite).toBeGreaterThan(0)
    expect(proxyWrite).toBeLessThan(profileWrite)
  })

  it('ImportSelection 没有为它们新增开关（挂在 profiles 下）', () => {
    const types = flat(blockAfter(stripComments(read('src/shared/types.ts')), 'export interface ImportSelection'))
    expect(types).not.toContain('proxies')
    expect(types).not.toContain('privateKeys')
  })
})

describe('界面', () => {
  const drawer = stripComments(read(DRAWER))

  it('提交仍用 getFieldsValue(true)（折叠面板不挂载那个坑）', () => {
    expect(flat(blockAfter(drawer, 'const submit ='))).toContain('form.getFieldsValue(true)')
  })

  it('抽屉提交的是 id，不再拼内联代理', () => {
    const body = flat(blockAfter(drawer, 'const submit ='))
    expect(body).toContain('proxyId: v.proxyId || undefined')
    expect(body).toContain('privateKeyId: v.privateKeyId || undefined')
    expect(body).not.toContain("type: 'none'")
  })

  it('两处编辑弹窗是同一份实现（抽屉与设置页都用 SavedRefModals）', () => {
    expect(drawer).toContain("from '@/features/settings/SavedRefModals'")
    expect(stripComments(read('src/renderer/src/features/settings/SavedRefsPanel.tsx'))).toContain(
      "from './SavedRefModals'"
    )
  })
})

describe('文案两边都有', () => {
  const keys = [
    'section',
    'desc',
    'proxies',
    'keys',
    'name',
    'nameRequired',
    'proxyNew',
    'proxyEdit',
    'keyNew',
    'keyEdit',
    'keyPathHint',
    'usedBy',
    'unused',
    'deleteConfirm',
    'blockedTitle',
    'blockedDesc'
  ] as const

  it('savedRef.* 齐全', () => {
    for (const k of keys) {
      expect(zh.translation.savedRef[k], `zh 缺 savedRef.${k}`).toBeTruthy()
      expect(en.translation.savedRef[k], `en 缺 savedRef.${k}`).toBeTruthy()
    }
  })

  it('私钥那条文案说明了"只记路径、不进导出文件"', () => {
    expect(zh.translation.savedRef.keyPathHint).toContain('只记路径')
    expect(zh.translation.savedRef.keyPathHint).toContain('导出')
  })
})
