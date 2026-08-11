import { describe, expect, it } from 'vitest'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * 局域网同步的源码护栏。LanSyncManager / discovery 在 node 测试里能真跑（见
 * test/integration/lansync.test.ts），所以这里只守那些**行为测不到、改错了却编译得过**
 * 的接线与安全约定：
 *
 *  - 发送恒 encryptAll:true —— 一旦有人改成明文发送，线上就裸奔了，且没有任何报错；
 *  - 配对码证明必须过 scrypt —— 退化成裸 HMAC 会让离线暴力从"28 核·小时"塌成"瞬间"；
 *  - confirm 验证必须**先于** payload 处理 —— 顺序倒了等于谁连上都能塞数据进来；
 *  - before-quit 收尾里 stopAll 必须在 closeDatabase 之前。
 */

const MANAGER = 'src/main/lansync/LanSyncManager.ts'
const PAIRING = 'src/main/lansync/pairing.ts'
const SYNC_IPC = 'src/main/ipc/sync.ipc.ts'
const INDEX = 'src/main/index.ts'

describe('契约', () => {
  it('8 条 invoke 在 InvokeMap，2 条状态在 EventMap', () => {
    const invoke = channelsOf('InvokeMap')
    for (const c of [
      'sync:receiveStart',
      'sync:receiveStop',
      'sync:receiveStatus',
      'sync:scan',
      'sync:send',
      'sync:sendCancel',
      'sync:apply',
      'sync:dismiss'
    ]) {
      expect(invoke, `InvokeMap 缺 ${c}`).toContain(c)
    }
    const events = channelsOf('EventMap')
    expect(events).toContain('sync:receiveState')
    expect(events).toContain('sync:sendState')
  })

  it("'sync:' 在 preload 的前缀白名单里，否则整组被拦在门外", () => {
    const src = stripComments(read('src/shared/ipc.ts'))
    const at = src.indexOf('export const CHANNEL_PREFIXES')
    expect(src.slice(at, src.indexOf('] as const', at))).toContain("'sync:'")
  })

  it('sync:send 的配对码卡死 6 位数字（别退化成任意串）', () => {
    const ipc = flat(stripComments(read(SYNC_IPC)))
    expect(ipc).toMatch(/code:\s*z\.string\(\)\.regex\(\/\^\\d\{6\}\$\/\)/)
  })

  it('sync:apply 的收尾复用 finishImportSideEffects，不另抄一份主题热更', () => {
    const ipc = stripComments(read(SYNC_IPC))
    expect(ipc).toContain('finishImportSideEffects(result)')
    // 第二份手抄的特征：自己 broadcast settings:changed
    expect(ipc).not.toContain("broadcast('settings:changed'")
  })
})

describe('安全约定（改错了编译得过、界面照常，只是线上裸奔或防线失效）', () => {
  // 注：这些函数的入参是对象类型字面量，blockAfter 会误抓参数类型的花括号 ——
  // 所以用整文件 + indexOf 顺序判断（每个标记在文件里都唯一）。
  const manager = flat(stripComments(read(MANAGER)))
  const pairing = flat(stripComments(read(PAIRING)))

  it('发送恒整文件加密：buildExportEnvelope 带 encryptAll: true，绝不发 v1 明文', () => {
    // buildExportEnvelope 只在发送路径被调一次
    expect(manager).toContain('buildExportEnvelope({')
    expect(manager).toContain('encryptAll: true')
    // 明文信封的特征：v1 或 includeSecrets:false 的整文件加密都不该出现在发送路径
    expect(manager).not.toContain('formatVersion: 1')
    expect(manager).not.toContain('encryptAll: false')
  })

  it('配对密钥派生过 scrypt（退化成裸 HMAC 会让离线爆破从数十核时塌成瞬间）', () => {
    const at = pairing.indexOf('export async function derivePairKey')
    const scrypt = pairing.indexOf('scryptAsync(', at)
    const nextFn = pairing.indexOf('export ', at + 1)
    expect(scrypt).toBeGreaterThan(at)
    expect(scrypt).toBeLessThan(nextFn === -1 ? pairing.length : nextFn)
  })

  it('scrypt 走异步（不阻塞主线程）—— 未认证 hello 路径不能同步冻结事件循环', () => {
    // 同步 scryptSync 出现在派生里就是 DoS 回归
    expect(pairing).not.toContain('scryptSync(')
    expect(pairing).toContain('promisify(scrypt)')
  })

  it('接收端 hello 有"每连接首个"幂等守卫（防重复 hello 触发 scrypt flood）', () => {
    const manager = flat(stripComments(read(MANAGER)))
    const helloAt = manager.indexOf("frame.kind === 'hello'")
    // 守卫读 getSenderPub()，早于 derivePairKey
    const guardAt = manager.indexOf('ctx.getSenderPub()', helloAt)
    const deriveAt = manager.indexOf('derivePairKey(', helloAt)
    expect(guardAt).toBeGreaterThan(helloAt)
    expect(guardAt).toBeLessThan(deriveAt)
  })

  it('码证明比较用 timingSafeEqual，不是 === / equals', () => {
    const at = pairing.indexOf('export function macEquals')
    expect(pairing.indexOf('timingSafeEqual(', at)).toBeGreaterThan(at)
  })

  it('接收端：payload 处理带 confirmed 闸门 —— 未过码证明不许塞数据', () => {
    // payload 分支里必须先看 r.confirmed，且在 inspectImportFromText 之前
    const payloadAt = manager.indexOf("frame.kind === 'payload'")
    expect(payloadAt, '找不到 payload 分支').toBeGreaterThan(-1)
    const confirmedGuardAt = manager.indexOf('r.confirmed', payloadAt)
    const inspectAt = manager.indexOf('inspectImportFromText', payloadAt)
    expect(confirmedGuardAt, 'payload 分支里没有 confirmed 闸门').toBeGreaterThan(payloadAt)
    expect(confirmedGuardAt).toBeLessThan(inspectAt)
  })

  it('错码烧码：confirm-s 验不过时 rotateCode', () => {
    const mismatchAt = manager.indexOf("code: 'err.sync.codeMismatch'")
    expect(mismatchAt).toBeGreaterThan(-1)
    expect(manager.indexOf('this.rotateCode()', mismatchAt)).toBeGreaterThan(mismatchAt)
  })
})

describe('生命周期', () => {
  it('registerSyncIpc 在 index.ts 注册', () => {
    expect(stripComments(read(INDEX))).toContain('registerSyncIpc()')
  })

  it('before-quit 里 lanSyncManager.stopAll() 排在 closeDatabase() 之前', () => {
    const src = flat(stripComments(read(INDEX)))
    const stop = src.indexOf('lanSyncManager.stopAll()')
    const close = src.indexOf('closeDatabase()')
    expect(stop, 'before-quit 缺 lanSyncManager.stopAll()').toBeGreaterThan(-1)
    expect(stop).toBeLessThan(close)
  })

  it('App.tsx 接了 wireLanSyncEvents', () => {
    expect(stripComments(read('src/renderer/src/App.tsx'))).toContain('wireLanSyncEvents()')
  })

  it('面板挂载时先对齐一次现状（refreshReceive），防错过事件', () => {
    expect(stripComments(read('src/renderer/src/features/settings/LanSyncPanel.tsx'))).toContain(
      'refreshReceive()'
    )
  })
})

describe('文案', () => {
  const uiKeys = [
    'title', 'receiveTitle', 'receiveStart', 'receiveStop', 'codeLabel', 'waitingHint',
    'addressLabel', 'firewallHint', 'sendTitle', 'scan', 'noDevices', 'includeSecrets',
    'sendButton', 'incomingTitle', 'applyButton', 'rejectButton'
  ] as const
  const errKeys = ['busy', 'codeMismatch', 'timeout', 'connectFailed', 'protocol', 'sendInProgress', 'remoteError'] as const

  it('sync.* 与 err.sync.* 两边都齐', () => {
    for (const k of uiKeys) {
      expect((zh.translation.sync as Record<string, unknown>)[k], `zh 缺 sync.${k}`).toBeTruthy()
      expect((en.translation.sync as Record<string, unknown>)[k], `en 缺 sync.${k}`).toBeTruthy()
    }
    const zhErr = (zh.translation.err as Record<string, Record<string, unknown>>).sync
    const enErr = (en.translation.err as Record<string, Record<string, unknown>>).sync
    for (const k of errKeys) {
      expect(zhErr[k], `zh 缺 err.sync.${k}`).toBeTruthy()
      expect(enErr[k], `en 缺 err.sync.${k}`).toBeTruthy()
    }
  })

  it('面板文案写明了"不是双向同步"这条边界（发一份副本的心智）', () => {
    expect((zh.translation.sync as Record<string, string>).desc).toContain('不是双向同步')
  })
})
