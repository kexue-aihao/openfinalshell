import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, promises as fs, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventMap } from '@shared/ipc'
import type { ProfileDraft, TransferTask } from '@shared/types'
import { bindMainWindow } from '../../src/main/ipc/registry'
import { deleteProfile, saveProfile } from '../../src/main/store/connections'
import { patchSettings } from '../../src/main/services/settings'
import { promptBroker } from '../../src/main/ssh/PromptBroker'
import { sshManager } from '../../src/main/ssh/SshConnectionManager'
import { readdir, mkdir, rename, remove, chmod, realpath } from '../../src/main/sftp/SftpManager'
import { transferQueue } from '../../src/main/sftp/TransferQueue'

const PORT = 2240
let sftpRoot = ''
let localDir = ''
let server: ChildProcess
let sessionId = ''
let profileId = ''

const events: Array<{ channel: keyof EventMap; payload: unknown }> = []
function eventsOf<K extends keyof EventMap>(channel: K): Array<EventMap[K]> {
  return events.filter((e) => e.channel === channel).map((e) => e.payload as EventMap[K])
}
function taskState(taskId: string): TransferTask | undefined {
  return transferQueue.list().find((t) => t.id === taskId)
}
async function waitFor(pred: () => boolean, ms = 20000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}
async function waitTask(taskId: string, states: Array<TransferTask['state']>): Promise<TransferTask> {
  await waitFor(
    () => {
      const t = taskState(taskId)
      return Boolean(t && states.includes(t.state))
    },
    30000,
    `task ${taskId} → ${states.join('|')} (now ${taskState(taskId)?.state})`
  )
  return taskState(taskId)!
}

function draft(): ProfileDraft {
  return {
    name: 'sftp-fixture',
    groupId: null,
    host: '127.0.0.1',
    port: PORT,
    username: 'test',
    auth: { method: 'password', password: 'test123' },
    terminal: { charset: 'utf-8', termType: 'xterm-256color' },
    options: {
      keepaliveInterval: 15000,
      readyTimeout: 10000,
      legacyAlgorithms: false,
      autoReconnect: false,
      monitorEnabled: false,
      compress: false
    }
  }
}

beforeAll(async () => {
  sftpRoot = mkdtempSync(join(tmpdir(), 'ofs-sftp-srv-'))
  localDir = mkdtempSync(join(tmpdir(), 'ofs-sftp-local-'))
  bindMainWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: keyof EventMap, payload: unknown) => events.push({ channel, payload })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  server = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(PORT), sftpRoot], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000)
    server.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  // 预置远端内容
  await fs.mkdir(join(sftpRoot, 'sub'), { recursive: true })
  await fs.writeFile(join(sftpRoot, 'hello.txt'), 'hello sftp\n')
  await fs.writeFile(join(sftpRoot, '.hidden'), 'hidden\n')
  await fs.writeFile(join(sftpRoot, 'sub', 'nested.txt'), 'nested\n')

  const trustPrompts = setInterval(() => {
    for (const p of eventsOf('session:prompt')) {
      if (p.kind === 'hostkey-new' || p.kind === 'hostkey-changed') {
        promptBroker.reply({ requestId: p.requestId, ok: true, remember: true })
      }
    }
  }, 20)
  const profile = saveProfile(draft())
  profileId = profile.id
  ;({ sessionId } = await sshManager.open(profile.id))
  clearInterval(trustPrompts)

  patchSettings({
    sftp: {
      downloadDir: localDir,
      maxConcurrentPerSession: 2,
      maxConcurrentGlobal: 4,
      conflictPolicy: 'ask',
      showHiddenFiles: true,
      doubleClickAction: 'download'
    }
  })
})

afterAll(() => {
  transferQueue.cancelAll()
  sshManager.closeAll()
  if (profileId) deleteProfile(profileId)
  server?.kill()
})

describe('SFTP 浏览', () => {
  it('readdir 返回条目、类型、权限串与属主', async () => {
    const entries = await readdir(sessionId, '/')
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['.hidden', 'hello.txt', 'sub'])

    const file = entries.find((e) => e.name === 'hello.txt')!
    expect(file.type).toBe('file')
    expect(file.size).toBe(11)
    expect(file.modeStr).toMatch(/^-[rwx-]{9}$/)
    expect(file.path).toBe('/hello.txt')

    const dir = entries.find((e) => e.name === 'sub')!
    expect(dir.type).toBe('dir')
    expect(dir.modeStr.startsWith('d')).toBe(true)
  })

  it('realpath / mkdir / rename / chmod / 递归删除', async () => {
    expect(await realpath(sessionId, '.')).toBeTruthy()

    await mkdir(sessionId, '/newdir')
    expect((await readdir(sessionId, '/')).some((e) => e.name === 'newdir')).toBe(true)

    await rename(sessionId, '/newdir', '/renamed')
    const afterRename = await readdir(sessionId, '/')
    expect(afterRename.some((e) => e.name === 'renamed')).toBe(true)
    expect(afterRename.some((e) => e.name === 'newdir')).toBe(false)

    // chmod 请求必须能往返；Windows 的 fs.chmod 只认只读位，
    // 因此只在 POSIX 上断言精确权限位（fixture 平台限制，非客户端问题）
    await chmod(sessionId, '/hello.txt', 0o640)
    const file = (await readdir(sessionId, '/')).find((e) => e.name === 'hello.txt')!
    if (process.platform === 'win32') {
      expect(file.modeStr).toMatch(/^-/)
    } else {
      expect(file.mode & 0o777).toBe(0o640)
    }

    // 递归删除：目录里放个文件再删整棵
    await fs.writeFile(join(sftpRoot, 'renamed', 'inner.txt'), 'x')
    await remove(sessionId, '/renamed', true)
    expect(existsSync(join(sftpRoot, 'renamed'))).toBe(false)
  })

  it('Windows 反斜杠路径被规范化，不会打到错误目录', async () => {
    const entries = await readdir(sessionId, '\\sub')
    expect(entries.map((e) => e.name)).toEqual(['nested.txt'])
  })
})

describe('SFTP 传输', () => {
  it('下载文件：.part 中转后 rename 为最终名，内容一致', async () => {
    const [taskId] = transferQueue.enqueue([
      {
        sessionId,
        kind: 'download',
        remotePath: '/hello.txt',
        localPath: join(localDir, 'hello.txt')
      }
    ])
    const task = await waitTask(taskId, ['done', 'error'])
    expect(task.state).toBe('done')
    expect(await fs.readFile(join(localDir, 'hello.txt'), 'utf8')).toBe('hello sftp\n')
    expect(existsSync(join(localDir, 'hello.txt.part'))).toBe(false)
  })

  it('上传文件：.ofspart 中转后 rename，远端内容一致', async () => {
    const src = join(localDir, 'upload-me.bin')
    const payload = Buffer.alloc(256 * 1024, 7)
    await fs.writeFile(src, payload)

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'upload', localPath: src, remotePath: '/uploaded.bin' }
    ])
    const task = await waitTask(taskId, ['done', 'error'])
    expect(task.state).toBe('done')
    const remote = await fs.readFile(join(sftpRoot, 'uploaded.bin'))
    expect(remote.length).toBe(payload.length)
    expect(remote.equals(payload)).toBe(true)
    expect(existsSync(join(sftpRoot, 'uploaded.bin.ofspart'))).toBe(false)
  })

  it('大文件下载有进度事件且字节数完整', async () => {
    const bigRemote = join(sftpRoot, 'big.bin')
    const size = 3 * 1024 * 1024
    await fs.writeFile(bigRemote, Buffer.alloc(size, 3))
    events.length = 0

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/big.bin', localPath: join(localDir, 'big.bin') }
    ])
    const task = await waitTask(taskId, ['done', 'error'])
    expect(task.state).toBe('done')
    expect((await fs.stat(join(localDir, 'big.bin'))).size).toBe(size)

    const progress = eventsOf('transfer:progress').filter((p) => p.taskId === taskId)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)!.total).toBe(size)
  })

  it('目录下载渐进式展开为子任务', async () => {
    const [dirTaskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/sub', localPath: join(localDir, 'sub') }
    ])
    await waitTask(dirTaskId, ['done', 'error'])

    // 子任务由目录任务入队，等其完成
    await waitFor(
      () => transferQueue.list().some((t) => t.remotePath === '/sub/nested.txt' && t.state === 'done'),
      20000,
      'nested file downloaded'
    )
    expect(await fs.readFile(join(localDir, 'sub', 'nested.txt'), 'utf8')).toBe('nested\n')
  })

  it('取消运行中的任务不留 .part 残留', async () => {
    const size = 8 * 1024 * 1024
    await fs.writeFile(join(sftpRoot, 'cancel-me.bin'), Buffer.alloc(size, 9))
    const target = join(localDir, 'cancel-me.bin')

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/cancel-me.bin', localPath: target }
    ])
    await waitFor(() => taskState(taskId)?.state === 'running', 10000, 'running')
    transferQueue.control(taskId, 'cancel')
    const task = await waitTask(taskId, ['canceled', 'done', 'error'])

    // 极小概率在取消前就传完；只在真的取消时校验残留
    if (task.state === 'canceled') {
      expect(existsSync(`${target}.part`)).toBe(false)
      expect(existsSync(target)).toBe(false)
    }
  })

  it('暂停后继续可完成传输（offset 续传）', async () => {
    const size = 6 * 1024 * 1024
    await fs.writeFile(join(sftpRoot, 'resume-me.bin'), Buffer.alloc(size, 5))
    const target = join(localDir, 'resume-me.bin')

    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/resume-me.bin', localPath: target }
    ])
    await waitFor(() => taskState(taskId)?.state === 'running', 10000, 'running')
    transferQueue.control(taskId, 'pause')
    const paused = await waitTask(taskId, ['paused', 'done'])

    if (paused.state === 'paused') {
      // .part 保留，续传接上
      expect(existsSync(`${target}.part`)).toBe(true)
      transferQueue.control(taskId, 'resume')
      const done = await waitTask(taskId, ['done', 'error'])
      expect(done.state).toBe('done')
    }
    expect((await fs.stat(target)).size).toBe(size)
  })

  it('远端文件不存在时报错，不产生本地文件', async () => {
    const target = join(localDir, 'nope.bin')
    const [taskId] = transferQueue.enqueue([
      { sessionId, kind: 'download', remotePath: '/does-not-exist', localPath: target }
    ])
    const task = await waitTask(taskId, ['error', 'done'])
    expect(task.state).toBe('error')
    expect(task.error).toBeTruthy()
    expect(existsSync(target)).toBe(false)
  })

  it('clearFinished 清掉终态任务', async () => {
    expect(transferQueue.list().some((t) => t.state === 'done')).toBe(true)
    transferQueue.clearFinished()
    expect(
      transferQueue.list().filter((t) => ['done', 'error', 'canceled'].includes(t.state))
    ).toHaveLength(0)
  })
})
