import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonFileStore, deepMerge } from '../../src/main/store/ConfigStore'
import { atomicWriteFile } from '../../src/main/utils/atomicWrite'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import type { AppSettings } from '../../src/shared/types'

interface Cfg {
  version: number
  a: number
  nested: { x: number; y: string }
}
const defaults = (): Cfg => ({ version: 1, a: 1, nested: { x: 1, y: 'd' } })

describe('deepMerge', () => {
  it('递归合并普通对象，保留未提及的键', () => {
    const base = { version: 1, a: 1, nested: { x: 1, y: 'd' } }
    expect(deepMerge(base, { nested: { x: 9 } })).toEqual({
      version: 1,
      a: 1,
      nested: { x: 9, y: 'd' }
    })
  })

  it('数组与标量整体替换而非合并', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] })
    expect(deepMerge({ v: 'old' }, { v: 'new' })).toEqual({ v: 'new' })
  })

  it('undefined patch 不改变 base', () => {
    const base = { a: 1 }
    expect(deepMerge(base, undefined)).toBe(base)
  })

  it('旧设置文档缺少 reduceTransparency 时沿用新的默认值 false', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
    delete legacy.reduceTransparency

    const migrated = deepMerge(DEFAULT_SETTINGS, legacy as Partial<AppSettings>)
    expect(migrated.reduceTransparency).toBe(false)
  })
})

describe('atomicWriteFile', () => {
  it('写入后不留 tmp 文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-atomic-'))
    const file = join(dir, 'sub', 'data.json')
    await atomicWriteFile(file, '{"v":1}')
    expect(readFileSync(file, 'utf8')).toBe('{"v":1}')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('并发写同一路径不互相踩踏，最后一次生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-atomic-'))
    const file = join(dir, 'data.json')
    await Promise.all([
      atomicWriteFile(file, 'first'),
      atomicWriteFile(file, 'second'),
      atomicWriteFile(file, 'third')
    ])
    expect(readFileSync(file, 'utf8')).toBe('third')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
})

describe('JsonFileStore', () => {
  it('文件不存在时用默认值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-store-'))
    const store = new JsonFileStore<Cfg>(join(dir, 'c.json'), defaults)
    expect(store.data).toEqual(defaults())
  })

  it('加载已有文件并与默认值合并（新增字段有兜底）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-store-'))
    const file = join(dir, 'c.json')
    writeFileSync(file, JSON.stringify({ version: 1, a: 42 }), 'utf8')
    const store = new JsonFileStore<Cfg>(file, defaults)
    expect(store.data.a).toBe(42)
    expect(store.data.nested).toEqual({ x: 1, y: 'd' })
  })

  it('文件损坏时备份为 .corrupt 并回退默认值，不抛异常', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-store-'))
    const file = join(dir, 'c.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const store = new JsonFileStore<Cfg>(file, defaults)
    expect(store.data).toEqual(defaults())
    expect(existsSync(`${file}.corrupt`)).toBe(true)
  })

  it('update + flush 落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-store-'))
    const file = join(dir, 'c.json')
    const store = new JsonFileStore<Cfg>(file, defaults, 10)
    store.update((d) => {
      d.a = 7
    })
    await store.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).a).toBe(7)
  })

  it('未变更时 flush 不写文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofs-store-'))
    const file = join(dir, 'c.json')
    const store = new JsonFileStore<Cfg>(file, defaults, 10)
    await store.flush()
    expect(existsSync(file)).toBe(false)
  })
})
