import { z } from 'zod'
import { handle } from './registry'
import {
  deletePrivateKey,
  deleteProxy,
  listPrivateKeys,
  listProxies,
  savePrivateKey,
  saveProxy
} from '../store/savedRefs'

/**
 * 「已保存的代理」与「已保存的私钥」的 IPC。
 *
 * 长度上限与既有的连接草稿对齐（`conn.ipc.ts:12-52`）：代理密码 255（SOCKS5 的 RFC1929
 * 就卡在 255 字节，见 `proxyDial.ts` 里那条），私钥口令 1024，路径 1024。
 *
 * `type` 的枚举里**没有 `'none'`** —— 独立实体里"存在即启用"，不用代理就是不引用。
 */
const proxyDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  type: z.enum(['http', 'socks5']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  clearSecret: z.boolean().optional()
})

const keyDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  path: z.string().min(1).max(1024),
  passphrase: z.string().max(1024).optional(),
  clearSecret: z.boolean().optional(),
  note: z.string().max(4096).optional()
})

export function registerSavedRefsIpc(): void {
  handle('proxy:list', () => listProxies())
  handle('proxy:save', (draft) => saveProxy(draft), z.tuple([proxyDraftSchema]))
  handle('proxy:delete', (id) => deleteProxy(id), z.tuple([z.string()]))

  handle('key:list', () => listPrivateKeys())
  handle('key:save', (draft) => savePrivateKey(draft), z.tuple([keyDraftSchema]))
  handle('key:delete', (id) => deletePrivateKey(id), z.tuple([z.string()]))
}
