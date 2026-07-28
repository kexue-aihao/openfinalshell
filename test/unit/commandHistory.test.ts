import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_HISTORY_MAX_CHARS, COMMAND_HISTORY_MAX_ROWS } from '@shared/constants'

const { database } = await import('../../src/main/store/Database')
const {
  clearCommandHistory,
  listCommandHistory,
  normalizeCommand,
  pushCommandHistory
} = await import('../../src/main/store/commandHistory')

/**
 * 命令历史的存储语义。三条里每一条都能被"顺手简化"掉，而简化之后功能看着还在：
 *
 *  1. 去重靠**主键**（同一条命令一行、use_count +1）。改成每次 INSERT 一行的话，
 *     列表看着一样，但淘汰会被同一条 `ls` 的上百次执行吃满。
 *  2. 淘汰与写入在**同一个事务**里。挪去定时/退出前，就等于崩溃时不做。
 *  3. 入库前再卡一次长度 —— IPC 那侧的 zod 不是唯一入口。
 */

beforeAll(() => {
  database() // 建表（SCHEMA 里 CREATE TABLE IF NOT EXISTS，所以老库升级上来也有）
})

beforeEach(() => {
  clearCommandHistory()
})

describe('规范化', () => {
  it('去首尾空白', () => {
    expect(normalizeCommand('  ls -al \t')).toBe('ls -al')
  })

  it('空白与超长一律不记', () => {
    expect(normalizeCommand('')).toBeNull()
    expect(normalizeCommand('   \t  ')).toBeNull()
    expect(normalizeCommand('a'.repeat(COMMAND_HISTORY_MAX_CHARS + 1))).toBeNull()
    expect(normalizeCommand('a'.repeat(COMMAND_HISTORY_MAX_CHARS))).toHaveLength(
      COMMAND_HISTORY_MAX_CHARS
    )
  })

  it('push 用的是同一份规范化（返回值说明它到底记没记）', () => {
    expect(pushCommandHistory('   ')).toBe(false)
    expect(pushCommandHistory('b'.repeat(COMMAND_HISTORY_MAX_CHARS + 1))).toBe(false)
    expect(pushCommandHistory('  uptime  ')).toBe(true)
    expect(listCommandHistory().map((e) => e.command)).toEqual(['uptime'])
  })
})

describe('去重与排序', () => {
  it('同一条命令执行多次只占一行，use_count 累加、时间刷新', () => {
    pushCommandHistory('ls -al', 1_000)
    pushCommandHistory('ls -al', 2_000)
    pushCommandHistory('ls -al', 3_000)
    const entries = listCommandHistory()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ command: 'ls -al', lastUsedAt: 3_000, useCount: 3 })
  })

  it('按最近使用倒序 —— 重新用一条老命令会把它顶到最前', () => {
    pushCommandHistory('第一条', 1_000)
    pushCommandHistory('第二条', 2_000)
    pushCommandHistory('第三条', 3_000)
    expect(listCommandHistory().map((e) => e.command)).toEqual(['第三条', '第二条', '第一条'])

    pushCommandHistory('第一条', 4_000)
    expect(listCommandHistory().map((e) => e.command)).toEqual(['第一条', '第三条', '第二条'])
  })

  it('中文与 emoji 原样存取（命令原文是主键，编码错一点就变成两条）', () => {
    pushCommandHistory('echo "你好 🌏"', 5_000)
    pushCommandHistory('echo "你好 🌏"', 6_000)
    const entries = listCommandHistory()
    expect(entries).toHaveLength(1)
    expect(entries[0].command).toBe('echo "你好 🌏"')
  })
})

describe('淘汰', () => {
  it('只留最近 MAX_ROWS 条，淘汰的是最老的', () => {
    const over = 5
    for (let i = 0; i < COMMAND_HISTORY_MAX_ROWS + over; i++) {
      pushCommandHistory(`cmd-${i}`, 1_000 + i)
    }
    const entries = listCommandHistory()
    expect(entries).toHaveLength(COMMAND_HISTORY_MAX_ROWS)
    // 最新的在最前、最老的那 5 条已经不在
    expect(entries[0].command).toBe(`cmd-${COMMAND_HISTORY_MAX_ROWS + over - 1}`)
    const kept = new Set(entries.map((e) => e.command))
    for (let i = 0; i < over; i++) expect(kept.has(`cmd-${i}`)).toBe(false)
    expect(kept.has(`cmd-${over}`)).toBe(true)
  })

  it('重复执行不消耗额度（去重靠主键，这是淘汰能正确工作的前提）', () => {
    for (let i = 0; i < COMMAND_HISTORY_MAX_ROWS + 100; i++) {
      pushCommandHistory('ls', 1_000 + i)
    }
    pushCommandHistory('唯一的另一条', 9_999_999)
    const entries = listCommandHistory()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.command)).toEqual(['唯一的另一条', 'ls'])
    expect(entries[1].useCount).toBe(COMMAND_HISTORY_MAX_ROWS + 100)
  })
})

describe('清空', () => {
  it('清空之后是空的，且还能继续记', () => {
    pushCommandHistory('systemctl status nginx', 1_000)
    clearCommandHistory()
    expect(listCommandHistory()).toEqual([])
    pushCommandHistory('journalctl -xe', 2_000)
    expect(listCommandHistory()).toHaveLength(1)
  })
})
