import type { Terminal } from '@xterm/xterm'
import type { TermId } from '@shared/types'
import { ofs } from '@/ipc/api'

/**
 * termId → xterm 实例注册表（模块级，绕过 React/store —— 终端字节流永不进 store）。
 * term:data 直接写入 xterm；write 回调聚合后回发 flow-ack 形成背压闭环。
 */
const terminals = new Map<TermId, Terminal>()

let wired = false

export function wireTermData(): void {
  if (wired) return
  wired = true
  ofs.on('term:data', ({ termId, data }) => {
    const term = terminals.get(termId)
    if (!term) return
    term.write(data, () => {
      ofs.send('term:flow-ack', { termId, bytes: data.byteLength })
    })
  })
}

export function registerTerm(termId: TermId, term: Terminal): void {
  terminals.set(termId, term)
}

if (import.meta.env.DEV) {
  // dev 调试钩子：控制台里读终端缓冲（WebGL 渲染时 DOM 里没有文本节点）
  ;(window as unknown as Record<string, unknown>).__ofsDebug = {
    terminals,
    dumpBuffer(termId?: TermId): string {
      const term = termId ? terminals.get(termId) : [...terminals.values()][0]
      if (!term) return ''
      const buf = term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      }
      return lines.join('\n').replace(/\n+$/, '')
    }
  }
}

export function unregisterTerm(termId: TermId): void {
  terminals.delete(termId)
}

export function getTerm(termId: TermId): Terminal | undefined {
  return terminals.get(termId)
}
