import { randomUUID } from 'node:crypto'
import type { ForwardId, ForwardRule, ProfileId } from '@shared/types'
import { prepare } from './Database'

export function listForwards(profileId: ProfileId | null): ForwardRule[] {
  const rows = (
    profileId === null
      ? prepare('SELECT json FROM forwards').all()
      : prepare('SELECT json FROM forwards WHERE profile_id = ?').all(profileId)
  ) as Array<{ json: string }>
  return rows.map((r) => JSON.parse(r.json) as ForwardRule)
}

export function getForward(id: ForwardId): ForwardRule | undefined {
  const row = prepare('SELECT json FROM forwards WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(row.json) as ForwardRule) : undefined
}

export function saveForward(rule: ForwardRule): ForwardRule {
  const saved: ForwardRule = { ...rule, id: rule.id || randomUUID() }
  prepare(
    `INSERT INTO forwards(id, profile_id, json) VALUES(?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, json = excluded.json`
  ).run(saved.id, saved.profileId, JSON.stringify(saved))
  return saved
}

export function deleteForward(id: ForwardId): void {
  prepare('DELETE FROM forwards WHERE id = ?').run(id)
}

/** 连接建立后自动启动的规则 */
export function autoStartRules(profileId: ProfileId): ForwardRule[] {
  return listForwards(profileId).filter((r) => r.autoStart)
}

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushForwards(): Promise<void> {
  /* no-op */
}
