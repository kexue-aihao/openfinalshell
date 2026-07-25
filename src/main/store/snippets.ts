import { randomUUID } from 'node:crypto'
import type { Snippet, SnippetGroup } from '@shared/types'
import { JsonFileStore } from './ConfigStore'
import { configFile } from './paths'

interface SnippetsFile {
  version: number
  groups: SnippetGroup[]
  snippets: Snippet[]
}

let store: JsonFileStore<SnippetsFile> | null = null

function snippetStore(): JsonFileStore<SnippetsFile> {
  if (!store) {
    store = new JsonFileStore<SnippetsFile>(configFile.snippets(), () => ({
      version: 1,
      groups: [{ id: 'default', name: '常用', order: 0 }],
      snippets: [
        { id: randomUUID(), groupId: 'default', name: '磁盘占用', command: 'df -h', autoEnter: true, order: 0 },
        { id: randomUUID(), groupId: 'default', name: '内存', command: 'free -h', autoEnter: true, order: 1 },
        {
          id: randomUUID(),
          groupId: 'default',
          name: '占用最高的进程',
          command: 'ps aux --sort=-%cpu | head -n 11',
          autoEnter: true,
          order: 2
        },
        {
          id: randomUUID(),
          groupId: 'default',
          name: '监听端口',
          command: 'ss -tulnp',
          autoEnter: true,
          order: 3
        }
      ]
    }))
  }
  return store
}

export function listSnippets(): { groups: SnippetGroup[]; snippets: Snippet[] } {
  const d = snippetStore().data
  return { groups: d.groups, snippets: d.snippets }
}

export function saveSnippet(snippet: Snippet): void {
  snippetStore().update((d) => {
    const s = { ...snippet, id: snippet.id || randomUUID() }
    const idx = d.snippets.findIndex((x) => x.id === s.id)
    if (idx >= 0) d.snippets[idx] = s
    else d.snippets.push(s)
  })
}

export function deleteSnippet(id: string): void {
  snippetStore().update((d) => {
    d.snippets = d.snippets.filter((x) => x.id !== id)
  })
}

export function saveSnippetGroup(group: SnippetGroup): void {
  snippetStore().update((d) => {
    const g = { ...group, id: group.id || randomUUID() }
    const idx = d.groups.findIndex((x) => x.id === g.id)
    if (idx >= 0) d.groups[idx] = g
    else d.groups.push(g)
  })
}

export function deleteSnippetGroup(id: string): void {
  snippetStore().update((d) => {
    d.groups = d.groups.filter((x) => x.id !== id)
    d.snippets = d.snippets.filter((x) => x.groupId !== id)
  })
}

export async function flushSnippets(): Promise<void> {
  await snippetStore().flush()
}
