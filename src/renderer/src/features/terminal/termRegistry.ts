import type { Terminal } from '@xterm/xterm'
import type { TermId } from '@shared/types'
import { ofs } from '@/ipc/api'
import { PromptTracker } from './commandCapture'

/**
 * termId → xterm 实例注册表（模块级，绕过 React/store —— 终端字节流永不进 store）。
 * term:data 直接写入 xterm；write 回调聚合后回发 flow-ack 形成背压闭环。
 */
const terminals = new Map<TermId, Terminal>()

/**
 * termId → 提示符列跟踪器（命令历史采集用，语义见 commandCapture.ts）。
 *
 * 放在这里而不是 TerminalPane 的 ref 里，是因为**往终端里写字的人不止终端面板自己**：
 * 侧栏的快捷命令走 `term:exec`、历史浮层回填走 `term:input`，它们都得能说一句
 * "这一行我动过了"。跟踪器跟着 termId 走，谁写谁标记，只此一份。
 */
const trackers = new Map<TermId, PromptTracker>()

export function trackerFor(termId: TermId): PromptTracker {
  let tracker = trackers.get(termId)
  if (!tracker) {
    tracker = new PromptTracker()
    trackers.set(termId, tracker)
  }
  return tracker
}

/**
 * 声明"这一行是程序写进去的"。写之前调用 —— 那时光标还停在提示符末尾，
 * 记下来的行号才是要标记的那一行。
 *
 * 终端还没建起来（termId 已给但实例还没注册）时静默跳过：采集只会退回启发式，
 * 而为了一条历史记录去抛错不值得。
 */
export function noteProgrammaticWrite(termId: TermId): void {
  const term = terminals.get(termId)
  if (term) trackerFor(termId).noteProgrammaticWrite(term.buffer.active)
}

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
  // 跟踪器一起清掉：termId 是 randomUUID，留着就是每关一个终端漏一个对象
  trackers.delete(termId)
}

export function getTerm(termId: TermId): Terminal | undefined {
  return terminals.get(termId)
}
