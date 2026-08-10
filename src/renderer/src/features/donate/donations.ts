import usdtTrc20 from './qr/usdt-trc20.png'
import usdtPolygon from './qr/usdt-polygon.png'
import usdtBep20 from './qr/usdt-bep20.png'
import usdtErc20 from './qr/usdt-erc20.png'
import bnb from './qr/bnb.png'
import eth from './qr/eth.png'
import pol from './qr/pol.png'
import fiat from './qr/fiat.png'

/**
 * 赞赏码登记表。二维码是作者提供的真实收款码，已裁剪成"只剩二维码"（qr/ 下）。
 * 图片打进包、离线可用、不接任何支付接口。
 *
 * label = 收款币种（币种/品牌代号不翻译）；noteKey = 该码作用（链/用途）的 i18n 键 ——
 * 加密货币务必标清链，转错链无法找回。法币码的 label 也走 i18n（labelKey）。
 * 每个码上方显示 `label · note`（见 DonateSection）。
 */
export interface DonateMethod {
  id: string
  /** 币种/品牌代号（不翻译，如 USDT/BNB）；法币用 labelKey 走 i18n */
  label?: string
  labelKey?: string
  kind: 'crypto' | 'fiat'
  /** 作用（链/网络或用途）的 i18n 键 */
  noteKey: string
  /** 二维码图片（本地资源 URL） */
  img: string
}

export const DONATE_METHODS: DonateMethod[] = [
  { id: 'usdt-trc20', label: 'USDT', kind: 'crypto', noteKey: 'donate.noteTrc20', img: usdtTrc20 },
  { id: 'usdt-polygon', label: 'USDT', kind: 'crypto', noteKey: 'donate.notePolygon', img: usdtPolygon },
  { id: 'usdt-bep20', label: 'USDT', kind: 'crypto', noteKey: 'donate.noteBep20', img: usdtBep20 },
  { id: 'usdt-erc20', label: 'USDT', kind: 'crypto', noteKey: 'donate.noteErc20', img: usdtErc20 },
  { id: 'bnb', label: 'BNB', kind: 'crypto', noteKey: 'donate.noteBnb', img: bnb },
  { id: 'eth', label: 'ETH', kind: 'crypto', noteKey: 'donate.noteEth', img: eth },
  { id: 'pol', label: 'POL', kind: 'crypto', noteKey: 'donate.notePolygon', img: pol },
  { id: 'fiat', labelKey: 'donate.wechatAlipay', kind: 'fiat', noteKey: 'donate.scanToPay', img: fiat }
]
