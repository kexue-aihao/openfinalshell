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
  it('每个码都标了链/用途（note 必填，加密货币转错链无法找回）', () => {
    expect(manifest).toContain('note: string')
    // 四条 USDT 各自标了不同的链
    for (const chain of ['TRC20', 'Polygon', 'BEP20', 'ERC20']) {
      expect(manifest, `USDT 缺少 ${chain} 标注`).toContain(chain)
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
