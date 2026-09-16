import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterAll, describe, expect, it } from 'vitest'
import { database, databaseFile, closeDatabase, prepare, tx } from '../../src/main/store/Database'
import { DocStore } from '../../src/main/store/DocStore'
import { listAiProfiles, saveAiProfile, deleteAiProfile, getAiToken } from '../../src/main/services/aiProfiles'
import { encField, decField, _resetDataKeyCacheForTests } from '../../src/main/store/crypto'
import { saveProfile, listConnections, saveGroup, deleteGroup } from '../../src/main/store/connections'
import type { ProfileDraft } from '@shared/types'

afterAll(() => closeDatabase())

describe('shared configuration transactions', () => {
  it('refreshes documents from the DB and does not overwrite another window from a stale cache', () => {
    const a = new DocStore('multi-test', () => ({ x: 0, y: 0 }))
    const b = new DocStore('multi-test', () => ({ x: 0, y: 0 }))
    expect(a.data).toEqual({ x: 0, y: 0 })
    b.update((draft) => { draft.y = 12 })
    a.update((draft) => { draft.x = 9 })
    expect(b.data).toEqual({ x: 9, y: 12 })
    const other = new DatabaseSync(databaseFile())
    other.prepare('UPDATE documents SET json = ? WHERE name = ?').run('{"x":42,"y":12}', 'multi-test')
    other.close()
    expect(a.data.x).toBe(42)
  })

  it('rolls back nested writes and does not retain an encryption key created by a rolled back transaction', () => {
    prepare('DELETE FROM meta WHERE key = ?').run('data_key_v1')
    _resetDataKeyCacheForTests()
    expect(() => tx(() => { encField('discarded'); throw new Error('rollback') })).toThrow('rollback')
    const cipher = encField('kept')
    _resetDataKeyCacheForTests()
    expect(decField(cipher)).toBe('kept')
  })

  it('rejects stale AI edits before changing the stored token', () => {
    const a = saveAiProfile({ name: 'A', baseUrl: 'https://example.org/v1', model: 'm', token: 'first-token' })
    const b = saveAiProfile({ ...a, expectedUpdatedAt: a.updatedAt, model: 'new-model', token: 'second-token' })
    expect(() => saveAiProfile({ ...a, expectedUpdatedAt: a.updatedAt, model: 'stale', token: 'stale-token' })).toThrow('CONFIG_CONFLICT')
    expect(getAiToken(a.id).token).toBe('second-token')
    expect(getAiToken(a.id).profile.model).toBe(b.model)
    expect(JSON.stringify(listAiProfiles())).not.toContain('second-token')
  })

  it('initializes AI defaults once, including after all profiles have been deleted', () => {
    listAiProfiles()
    for (const p of listAiProfiles()) deleteAiProfile(p.id)
    expect(listAiProfiles()).toEqual([])
  })

  it('preserves different connections and rejects the second stale save of the same one', () => {
    const draft: ProfileDraft = { name: 'one', host: 'localhost', port: 22, username: 'test', groupId: null,
      auth: { method: 'password' }, terminal: { charset: 'utf8', termType: 'xterm' },
      options: { keepaliveInterval: 15000, readyTimeout: 10000, legacyAlgorithms: false, autoReconnect: false, monitorEnabled: false, compress: false } }
    const a = saveProfile(draft)
    const b = saveProfile({ ...draft, name: 'two' })
    saveProfile({ ...draft, id: a.id, expectedUpdatedAt: a.updatedAt, name: 'changed' })
    expect(() => saveProfile({ ...draft, id: a.id, expectedUpdatedAt: a.updatedAt, name: 'stale' })).toThrow('CONFIG_CONFLICT')
    expect(listConnections().profiles.map((p) => p.name)).toEqual(expect.arrayContaining(['changed', b.name]))
  })

  it('bounds busy retries while another thread holds a real SQLite write lock', async () => {
    database()
    const worker = new Worker(`
      const {parentPort, workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
      parentPort.on('message',()=>{ db.exec('ROLLBACK'); db.close(); process.exit(0); });
    `, { eval: true, workerData: databaseFile() })
    await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject) })
    try {
      const started = Date.now()
      expect(() => tx(() => prepare('INSERT INTO meta VALUES(?,?)').run('busy-test', '1'))).toThrow('DATABASE_BUSY')
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      worker.postMessage('release')
      await new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    }
    expect(() => tx(() => prepare('INSERT INTO meta VALUES(?,?)').run('busy-test', '1'))).not.toThrow()
  })

  it('rejects a stale group edit after deleting its parent reparents it', () => {
    saveGroup({ id: 'multi-parent', name: 'parent', parentId: null, order: 0 })
    saveGroup({ id: 'multi-child', name: 'child', parentId: 'multi-parent', order: 1 })
    const old = listConnections().groups.find((g) => g.id === 'multi-child')!
    deleteGroup('multi-parent')
    expect(() => saveGroup({ ...old, name: 'stale name' })).toThrow('CONFIG_CONFLICT')
    expect(listConnections().groups.find((g) => g.id === old.id)?.parentId).toBeNull()
  })
})
