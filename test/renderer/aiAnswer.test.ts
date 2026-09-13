import { describe, expect, it } from 'vitest'
import { isShellBlock, parseAiAnswer } from '@/features/ai/aiAnswer'
import { prepareTerminalPaste } from '@/features/terminal/terminalPaste'

describe('AI answer rendering parser', () => {
  it('keeps prose and fenced shell blocks in order without duplicates', () => {
    expect(parseAiAnswer('说明\n```bash\necho hello\n```\n结尾')).toEqual([
      { kind: 'text', text: '说明' }, { kind: 'code', text: 'echo hello', language: 'bash', complete: true }, { kind: 'text', text: '结尾' }
    ])
  })
  it('supports tilde fences and incomplete streams', () => {
    expect(parseAiAnswer('~~~sh\r\nls\r\n~~~')).toEqual([{ kind: 'code', text: 'ls', language: 'sh', complete: true }])
    expect(parseAiAnswer('```python\nprint(1)')).toEqual([{ kind: 'code', text: 'print(1)', language: 'python', complete: false }])
  })
  it('recognizes only shell languages for fill actions', () => {
    expect(isShellBlock('bash')).toBe(true)
    expect(isShellBlock('python')).toBe(false)
  })
})

describe('safe terminal paste preparation', () => {
  it('does not append Enter and normalizes line endings', () => {
    expect(prepareTerminalPaste('echo hi\r\n', false)).toEqual({ data: 'echo hi' })
  })
  it('rejects unsafe unprotected multiline and control input', () => {
    expect(prepareTerminalPaste('echo 1\necho 2', false)).toEqual({ issue: 'multilineUnsupported' })
    expect(prepareTerminalPaste('echo\u0007', false)).toEqual({ issue: 'controlCharacters' })
  })
  it('uses bracketed paste for multiline input', () => {
    expect(prepareTerminalPaste('echo 1\necho 2', true)).toEqual({ data: '\u001b[200~echo 1\recho 2\u001b[201~' })
  })
})
