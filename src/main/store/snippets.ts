import { randomUUID } from 'node:crypto'
import type { Snippet, SnippetGroup } from '@shared/types'
import { metaGet, metaSet, prepare, tx } from './Database'

/** 首次使用时铺一组常用命令，空面板对新用户不友好 */
function seedIfEmpty(): void {
  if (metaGet('snippets_seeded')) return
  const count = prepare('SELECT COUNT(*) AS c FROM snippets').get() as { c: number }
  if (count.c === 0) {
    tx(() => {
      prepare('INSERT INTO snippet_groups(id, name, sort_order) VALUES(?, ?, ?)').run(
        'default',
        '常用',
        0
      )
      const seed: Array<[string, string]> = [
        ['磁盘占用', 'df -h'],
        ['内存', 'free -h'],
        ['占用最高的进程', 'ps aux --sort=-%cpu | head -n 11'],
        ['监听端口', 'ss -tulnp']
      ]
      seed.forEach(([name, command], i) => {
        const snippet: Snippet = {
          id: randomUUID(),
          groupId: 'default',
          name,
          command,
          autoEnter: true,
          order: i
        }
        prepare('INSERT INTO snippets(id, group_id, json, sort_order) VALUES(?, ?, ?, ?)').run(
          snippet.id,
          snippet.groupId,
          JSON.stringify(snippet),
          i
        )
      })
    })
  }
  metaSet('snippets_seeded', String(Date.now()))
}

export function listSnippets(): { groups: SnippetGroup[]; snippets: Snippet[] } {
  seedIfEmpty()
  const groups = (
    prepare('SELECT id, name, sort_order FROM snippet_groups ORDER BY sort_order, name').all() as Array<{
      id: string
      name: string
      sort_order: number
    }>
  ).map((g) => ({ id: g.id, name: g.name, order: g.sort_order }))
  const snippets = (
    prepare('SELECT json FROM snippets ORDER BY sort_order').all() as Array<{ json: string }>
  ).map((r) => JSON.parse(r.json) as Snippet)
  return { groups, snippets }
}

export function saveSnippet(snippet: Snippet): void {
  const s: Snippet = { ...snippet, id: snippet.id || randomUUID() }
  prepare(
    `INSERT INTO snippets(id, group_id, json, sort_order) VALUES(?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, json = excluded.json,
                                   sort_order = excluded.sort_order`
  ).run(s.id, s.groupId, JSON.stringify(s), s.order)
}

export function deleteSnippet(id: string): void {
  prepare('DELETE FROM snippets WHERE id = ?').run(id)
}

export function saveSnippetGroup(group: SnippetGroup): void {
  const g: SnippetGroup = { ...group, id: group.id || randomUUID() }
  prepare(
    `INSERT INTO snippet_groups(id, name, sort_order) VALUES(?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order`
  ).run(g.id, g.name, g.order)
}

export function deleteSnippetGroup(id: string): void {
  tx(() => {
    prepare('DELETE FROM snippets WHERE group_id = ?').run(id)
    prepare('DELETE FROM snippet_groups WHERE id = ?').run(id)
  })
}

/** 写入即落库，保留此方法只为兼容退出前的 flush 调用 */
export async function flushSnippets(): Promise<void> {
  /* no-op */
}
