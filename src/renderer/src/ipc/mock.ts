import type { EventMap, OfsApi } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { ConnectionGroup, ConnectionProfile, ProfileDraft } from '@shared/types'

/**
 * DEV-only：在普通浏览器里打开 renderer（无 preload）时的 mock IPC。
 * 提供一个自回显的假终端，用于在没有 Electron 的情况下调试 UI 与终端渲染。
 * 生产构建下 window.ofs 恒存在，不会走到这里。
 */
export function createMockOfs(): OfsApi {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const profiles: ConnectionProfile[] = []
  const groups: ConnectionGroup[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const encoder = new TextEncoder()

  const emit = <K extends keyof EventMap>(channel: K, payload: EventMap[K]): void => {
    for (const fn of listeners.get(channel) ?? []) fn(payload)
  }
  const writeTerm = (termId: string, text: string): void =>
    emit('term:data', { termId, data: encoder.encode(text) })

  const toProfile = (draft: ProfileDraft): ConnectionProfile => ({
    id: draft.id ?? crypto.randomUUID(),
    name: draft.name,
    groupId: draft.groupId,
    color: draft.color,
    host: draft.host,
    port: draft.port,
    username: draft.username,
    auth: {
      method: draft.auth.method,
      passwordRef: draft.auth.password ? 'mock-ref' : undefined,
      privateKeyPath: draft.auth.privateKeyPath
    },
    terminal: draft.terminal,
    options: draft.options,
    note: draft.note,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  /** sessionId → 该会话的 profile 描述，用于假终端提示符 */
  const sessions = new Map<string, { label: string }>()
  const terms = new Map<string, { sessionId: string; line: string }>()

  const handlers: Record<string, (...args: never[]) => unknown> = {
    'settings:get': () => settings,
    'settings:set': (patch: never) => Object.assign(settings, patch),
    'app:getVersions': () => ({ app: '0.1.0-mock', electron: 'browser', node: '-', chrome: '-' }),
    'app:pickPath': () => null,
    'app:openExternal': () => undefined,
    'app:openPath': () => undefined,
    'vault:isAvailable': () => false,

    'conn:list': () => ({ profiles, groups }),
    'conn:save': (draft: never) => {
      const p = toProfile(draft as unknown as ProfileDraft)
      const idx = profiles.findIndex((x) => x.id === p.id)
      if (idx >= 0) profiles[idx] = p
      else profiles.push(p)
      return p
    },
    'conn:delete': (id: never) => {
      const idx = profiles.findIndex((x) => x.id === (id as unknown as string))
      if (idx >= 0) profiles.splice(idx, 1)
    },
    'conn:duplicate': (id: never) => {
      const src = profiles.find((x) => x.id === (id as unknown as string))
      if (!src) throw new Error('连接不存在')
      const copy = { ...structuredClone(src), id: crypto.randomUUID(), name: `${src.name} (副本)` }
      profiles.push(copy)
      return copy
    },
    'group:save': (group: never) => {
      const g = group as unknown as ConnectionGroup
      const idx = groups.findIndex((x) => x.id === g.id)
      if (idx >= 0) groups[idx] = g
      else groups.push(g)
    },
    'group:delete': (id: never) => {
      const idx = groups.findIndex((x) => x.id === (id as unknown as string))
      if (idx >= 0) groups.splice(idx, 1)
    },

    // --- 假会话：立刻 ready ---
    'session:open': (profileId: never) => {
      const p = profiles.find((x) => x.id === (profileId as unknown as string))
      if (!p) throw new Error('连接配置不存在')
      const sessionId = crypto.randomUUID()
      sessions.set(sessionId, { label: `${p.username}@${p.host}` })
      setTimeout(() => emit('session:state', { sessionId, state: 'ready' }), 150)
      return { sessionId }
    },
    'session:close': (sessionId: never) => {
      sessions.delete(sessionId as unknown as string)
    },
    'session:reconnect': () => undefined,
    'session:promptReply': () => undefined,

    // --- 假终端：本地回显 + 少量内建命令 ---
    'term:open': (arg: never) => {
      const { sessionId } = arg as unknown as { sessionId: string }
      const termId = crypto.randomUUID()
      terms.set(termId, { sessionId, line: '' })
      const label = sessions.get(sessionId)?.label ?? 'mock'
      setTimeout(() => {
        writeTerm(
          termId,
          `\x1b[36m浏览器调试模式\x1b[0m：这是本地模拟终端，未连接真实服务器。\r\n` +
            `可用命令：\x1b[33mecho\x1b[0m <文本> · \x1b[33mcolors\x1b[0m · \x1b[33mclear\x1b[0m\r\n` +
            `\x1b[32m${label}\x1b[0m:\x1b[34m~\x1b[0m$ `
        )
      }, 60)
      return { termId }
    },
    'term:resize': () => undefined,
    'term:close': (termId: never) => {
      terms.delete(termId as unknown as string)
    },
    'term:exec': (arg: never) => {
      const { termId, command } = arg as unknown as { termId: string; command: string }
      writeTerm(termId, command)
    },

    'snippet:list': () => ({ groups: [], snippets: [] }),
    'snippet:save': () => undefined,
    'snippet:delete': () => undefined,
    'snippetGroup:save': () => undefined,
    'snippetGroup:delete': () => undefined,
    'forward:list': () => [],
    'forward:save': () => undefined,
    'forward:delete': () => undefined,
    'forward:control': () => undefined,
    'transfer:list': () => [],
    'transfer:enqueue': () => [],
    'transfer:control': () => undefined,
    'transfer:clearFinished': () => undefined,
    'monitor:start': () => null,
    'monitor:stop': () => undefined,
    'monitor:setInterval': () => undefined
  }

  const handleInput = (termId: string, data: string): void => {
    const term = terms.get(termId)
    if (!term) return
    const prompt = (): void =>
      writeTerm(termId, `\x1b[32m${sessions.get(term.sessionId)?.label ?? 'mock'}\x1b[0m:\x1b[34m~\x1b[0m$ `)

    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        writeTerm(termId, '\r\n')
        const cmd = term.line.trim()
        term.line = ''
        if (cmd === 'clear') {
          writeTerm(termId, '\x1b[2J\x1b[H')
        } else if (cmd === 'colors') {
          let out = ''
          for (let i = 0; i < 8; i++) out += `\x1b[4${i}m  \x1b[0m`
          writeTerm(termId, `${out}\r\n`)
        } else if (cmd.startsWith('echo ')) {
          writeTerm(termId, `${cmd.slice(5)}\r\n`)
        } else if (cmd !== '') {
          writeTerm(termId, `sh: ${cmd}: command not found\r\n`)
        }
        prompt()
      } else if (ch === '\x7f') {
        if (term.line.length > 0) {
          term.line = term.line.slice(0, -1)
          writeTerm(termId, '\b \b')
        }
      } else if (ch === '\x03') {
        writeTerm(termId, '^C\r\n')
        term.line = ''
        prompt()
      } else {
        term.line += ch
        writeTerm(termId, ch)
      }
    }
  }

  return {
    invoke: (channel, ...args) => {
      const h = handlers[channel]
      if (!h) {
        return Promise.reject(
          new Error(`浏览器调试模式不支持 ${channel}（该能力需要 Electron 主进程）`)
        )
      }
      try {
        // 真实 IPC 会对返回值做结构化克隆；这里同样克隆，避免 mock 泄漏内部引用
        const result = h(...(args as never[]))
        return Promise.resolve((result === undefined ? undefined : structuredClone(result)) as never)
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
    },
    send: (channel, payload) => {
      if (channel === 'term:input') {
        const p = payload as { termId: string; data: string }
        handleInput(p.termId, p.data)
      }
    },
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener as (payload: unknown) => void)
      listeners.set(channel, set)
      return () => set.delete(listener as (payload: unknown) => void)
    }
  }
}
