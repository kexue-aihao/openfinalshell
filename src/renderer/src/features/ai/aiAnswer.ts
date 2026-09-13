export type AiAnswerPart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; language: string; complete: boolean }

/** Parse fenced blocks without interpreting model output as HTML or executable UI. */
export function parseAiAnswer(answer: string): AiAnswerPart[] {
  const parts: AiAnswerPart[] = []
  let text: string[] = []
  let block: { marker: string; language: string; lines: string[] } | undefined
  for (const line of answer.replace(/\r\n/g, '\n').split('\n')) {
    if (block) {
      const closing = /^\s{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (closing && closing[1][0] === block.marker[0] && closing[1].length >= block.marker.length) {
        parts.push({ kind: 'code', text: block.lines.join('\n'), language: block.language, complete: true })
        block = undefined
      } else block.lines.push(line)
      continue
    }
    const opening = /^\s{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line)
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      if (text.length) parts.push({ kind: 'text', text: text.join('\n') })
      text = []
      block = { marker: opening[1], language: opening[2].trim().split(/\s+/)[0].toLowerCase(), lines: [] }
    } else text.push(line)
  }
  if (block) parts.push({ kind: 'code', text: block.lines.join('\n'), language: block.language, complete: false })
  if (text.length) parts.push({ kind: 'text', text: text.join('\n') })
  return parts
}

export function isShellBlock(language: string): boolean {
  return ['', 'bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd', 'bat', 'console', 'terminal', 'shell-session', 'shellscript'].includes(language)
}
