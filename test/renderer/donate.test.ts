import { describe, expect, it } from 'vitest'
import { read, stripComments } from '../sourceGuard'

/**
 * 赞赏码：登记表齐全 + 关于页真的挂了区块。图片内容（真/占位）不在这测。
 * 注：donations.ts 会 import 一张 .svg，vitest 里没有资源加载器，所以这里不 import 该模块，
 * 改用源码文本护栏 —— 既避开加载器问题，也正好守住"6 个平台一个都不能少"。
 */

const manifest = stripComments(read('src/renderer/src/features/donate/donations.ts'))
const section = stripComments(read('src/renderer/src/features/donate/DonateSection.tsx'))
const settings = stripComments(read('src/renderer/src/features/settings/SettingsModal.tsx'))
const enLocale = read('src/shared/locales/en-US.json')
const zhLocale = read('src/shared/locales/zh-CN.json')

describe('赞赏码登记表', () => {
  it('八个收款码齐全（USDT×4 链 + BNB + ETH + POL + 微信/支付宝），一个不多一个不少', () => {
    for (const id of [
      'usdt-trc20',
      'usdt-polygon',
      'usdt-bep20',
      'usdt-erc20',
      'bnb',
      'eth',
      'pol',
      'fiat'
    ]) {
      expect(manifest, `缺少 ${id}`).toContain(`id: '${id}'`)
    }
    // 数组条目以 `{ id: '` 开头，接口里的 `id: string` 不含 `{`，正好只数到条目
    expect(manifest.match(/\{ id: '/g)).toHaveLength(8)
  })
  it('每个码都接入了真实图片资源（不是占位图）', () => {
    // 8 个 .png import，且都在 qr/ 目录下
    expect(manifest.match(/from '\.\/qr\/[a-z0-9-]+\.png'/g)).toHaveLength(8)
    expect(manifest).not.toContain('placeholder')
  })
  it('每个码都标了链/用途的 i18n 键（加密货币转错链无法找回）', () => {
    expect(manifest).toContain('noteKey: string')
    for (const key of ['donate.noteTrc20', 'donate.noteBep20', 'donate.noteErc20', 'donate.scanToPay']) {
      expect(manifest, `缺少 ${key}`).toContain(key)
    }
    // 链标注的文案落在 locales 里（中英都要有，加密货币标错链会丢币）
    for (const chain of ['TRC20', 'BEP20', 'ERC20']) {
      expect(enLocale, `en 缺 ${chain}`).toContain(chain)
      expect(zhLocale, `zh 缺 ${chain}`).toContain(chain)
    }
  })
})

describe('接线', () => {
  it('区块组件渲染二维码图片', () => {
    expect(section).toContain('DONATE_METHODS')
    expect(section).toContain('<img')
  })
  it('设置→关于页挂了 DonateSection', () => {
    expect(settings).toContain("from '@/features/donate/DonateSection'")
    expect(settings).toContain('<DonateSection')
  })
})
