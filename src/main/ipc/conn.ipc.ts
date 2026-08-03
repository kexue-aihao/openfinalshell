import { z } from 'zod'
import { handle } from './registry'
import {
  deleteGroup,
  deleteProfile,
  duplicateProfile,
  listConnections,
  saveGroup,
  saveProfile
} from '../store/connections'
import { deleteKnownHost, listKnownHosts } from '../ssh/hostkeys'

const profileDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  groupId: z.string().nullable(),
  color: z.string().max(20).optional(),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(120),
  auth: z.object({
    method: z.enum(['password', 'privateKey', 'agent']),
    password: z.string().max(1024).optional(),
    /** 引用一条已保存的私钥。v0.4 起路径与口令都归那条记录，不再随连接走 */
    privateKeyId: z.string().max(200).optional(),
    clearPassword: z.boolean().optional()
  }),
  terminal: z.object({
    charset: z.string().max(40),
    termType: z.string().max(40),
    startupCommand: z.string().max(4096).optional()
  }),
  options: z.object({
    keepaliveInterval: z.number().int().min(0).max(600_000),
    readyTimeout: z.number().int().min(1000).max(120_000),
    legacyAlgorithms: z.boolean(),
    autoReconnect: z.boolean(),
    monitorEnabled: z.boolean(),
    compress: z.boolean()
  }),
  /** 引用一条已保存的代理；无值 = 直连。内联代理那套已随 v0.4 迁移移除 */
  proxyId: z.string().max(200).optional(),
  jumpHostId: z.string().optional(),
  note: z.string().max(4096).optional(),
  lastUsedAt: z.number().optional()
})

const groupSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  parentId: z.string().nullable(),
  order: z.number()
})

export function registerConnIpc(): void {
  handle('conn:list', () => listConnections())
  handle('conn:save', (draft) => saveProfile(draft), z.tuple([profileDraftSchema]))
  handle('conn:delete', (id) => deleteProfile(id), z.tuple([z.string()]))
  handle('conn:duplicate', (id) => duplicateProfile(id), z.tuple([z.string()]))
  handle('conn:knownHosts', () => listKnownHosts())
  handle('conn:knownHostsDelete', (key) => deleteKnownHost(key), z.tuple([z.string().min(1).max(500)]))
  handle('group:save', (group) => saveGroup(group), z.tuple([groupSchema]))
  handle('group:delete', (id) => deleteGroup(id), z.tuple([z.string()]))
}
