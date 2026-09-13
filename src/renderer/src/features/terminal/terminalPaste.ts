export type TerminalPasteIssue = 'empty' | 'tooLong' | 'controlCharacters' | 'multilineUnsupported'
export type TerminalPaste = { data: string; issue?: never } | { issue: TerminalPasteIssue; data?: never }

/** Prepare user-chosen AI text without an Enter keystroke or embedded terminal controls. */
export function prepareTerminalPaste(text: string, bracketedPaste: boolean): TerminalPaste {
  if (text.length > 32_768) return { issue: 'tooLong' }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (!normalized.trim()) return { issue: 'empty' }
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(normalized)) return { issue: 'controlCharacters' }
  // Unprotected newlines execute commands; tabs can invoke shell completion.
  if (!bracketedPaste && /[\n\t]/.test(normalized)) return { issue: 'multilineUnsupported' }
  return { data: bracketedPaste ? `\x1b[200~${normalized.replace(/\n/g, '\r')}\x1b[201~` : normalized }
}
