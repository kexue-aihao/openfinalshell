import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCALE_TAGS } from '@shared/locales/registry'

/**
 * 语言包护栏：注册表与 locales 目录一一对应，且每种语言的键与 en-US **完全一致**。
 * 与 scripts/checkI18n.mjs 同义，但跑在 vitest 里，随测试套一起把关。
 */
const DIR = 'src/shared/locales'
const REFERENCE = 'en-US'

function flatten(obj: Record<string, unknown>, prefix = '', out = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out)
    else out.add(key)
  }
  return out
}
function load(tag: string): Set<string> {
  const obj = JSON.parse(readFileSync(join(DIR, `${tag}.json`), 'utf8')) as Record<string, unknown>
  delete obj._meta
  return flatten(obj)
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))

describe('locale 注册表 ↔ 文件', () => {
  it('注册表里的每种语言都有对应 json，且没有多余 json', () => {
    expect([...LOCALE_TAGS].sort()).toEqual([...files].sort())
  })
})

describe('N 语言键与 en-US 全等', () => {
  const ref = load(REFERENCE)
  it(`基准 ${REFERENCE} 至少有几百个键（防空文件）`, () => {
    expect(ref.size).toBeGreaterThan(500)
  })
  for (const tag of files) {
    if (tag === REFERENCE) continue
    it(`${tag} 与 ${REFERENCE} 键完全一致`, () => {
      const set = load(tag)
      const missing = [...ref].filter((k) => !set.has(k))
      const extra = [...set].filter((k) => !ref.has(k))
      expect({ tag, missing, extra }).toEqual({ tag, missing: [], extra: [] })
    })
  }
})
