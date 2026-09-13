import { describe, expect, it } from 'vitest'
import { normalizeAiBaseUrl } from '../../src/main/services/aiProfiles'

describe('AI provider URL validation', () => {
  it('normalizes secure provider roots', () => {
    expect(normalizeAiBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(normalizeAiBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1')
  })

  it('rejects insecure or credential-bearing remote URLs', () => {
    expect(() => normalizeAiBaseUrl('http://example.com/v1')).toThrow(/HTTPS/)
    expect(() => normalizeAiBaseUrl('https://user:pass@example.com/v1')).toThrow(/账号|密码/)
    expect(() => normalizeAiBaseUrl('file:///tmp/model')).toThrow(/HTTPS/)
  })
})
