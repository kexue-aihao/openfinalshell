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
 * label = 收款币种；note = 该码的作用（链/网络或用途）—— 加密货币务必标清链，
 * 转错链无法找回。每个码上方会显示 `label · note`。
 */
export interface DonateMethod {
  id: string
  /** 收款币种 / 收款方式 */
  label: string
  kind: 'crypto' | 'fiat'
  /** 作用：链/网络（加密货币）或用途（法币扫码） */
  note: string
  /** 二维码图片（本地资源 URL） */
  img: string
}

export const DONATE_METHODS: DonateMethod[] = [
  { id: 'usdt-trc20', label: 'USDT', kind: 'crypto', note: 'TRC20 · 波场', img: usdtTrc20 },
  { id: 'usdt-polygon', label: 'USDT', kind: 'crypto', note: 'Polygon', img: usdtPolygon },
  { id: 'usdt-bep20', label: 'USDT', kind: 'crypto', note: 'BEP20 · BNB Chain', img: usdtBep20 },
  { id: 'usdt-erc20', label: 'USDT', kind: 'crypto', note: 'ERC20 · 以太坊', img: usdtErc20 },
  { id: 'bnb', label: 'BNB', kind: 'crypto', note: 'BNB Chain', img: bnb },
  { id: 'eth', label: 'ETH', kind: 'crypto', note: 'Ethereum', img: eth },
  { id: 'pol', label: 'POL', kind: 'crypto', note: 'Polygon', img: pol },
  { id: 'fiat', label: '微信 / 支付宝', kind: 'fiat', note: '扫码支付', img: fiat }
]
