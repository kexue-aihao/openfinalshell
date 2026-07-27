import type { SFTPWrapper } from 'ssh2'

/**
 * 内存版 SFTP 假服务器，按 ssh2 的回调签名实现。**给 main 侧写回那条路的单测共用。**
 *
 * 为什么它要"像真的一样难伺候"：用它跑的用例里最关键的几条是**负向**的 ——
 * "服务器不支持原子替换时远端一个字节都没变"、"远端被第三方改过就不许写"。
 * 假对象必须照抄真 SFTP 的四条语义，否则这些断言全是空的：
 *   1. open 'w' 立刻截断目标（于是"偷偷直接写目标"的实现会当场被内容断言抓住）；
 *   2. open 'wx' 撞上任何已存在项都失败（于是"用 'w' 建临时文件"的实现绕不过这一条）；
 *   3. 普通 rename 不覆盖已存在目标（于是"退化成 rename"的实现会失败而不是悄悄成功）；
 *   4. 未通告扩展时 ext_openssh_rename **同步 throw**（ssh2 1.17 的真实行为）。
 *
 * 放在 test/ 根下而不是某个测试文件里，理由和 test/sourceGuard.ts、test/posixSh.ts 一样：
 * 它当时有两个消费者 —— remoteEditManager.test.ts（外部编辑器那条路）与
 * fileSave.test.ts（内置编辑器那条路），而**前者迟早要随外部编辑器一起删掉**，
 * 那天不该顺手带走后者的地基。那一天已经到了：前者没了，这个文件与它的消费者都还在。
 */

interface FakeNode {
  /** 软链为 null（内容在目标那边） */
  content: Buffer | null
  /** 软链指向的路径；普通文件为 null */
  link: string | null
  /** 含文件类型位，和真 Stats.mode 一样 */
  mode: number
  mtime: number
}

type VoidCb = (err?: Error | null) => void
type OpenCb = (err: Error | undefined, handle: Buffer) => void
type ReadCb = (err: Error | undefined, bytesRead: number, buffer: Buffer, position: number) => void
type StatCb = (err: Error | undefined, stats: unknown) => void

export const S_IFREG = 0o100000
export const S_IFLNK = 0o120000

function sftpErr(message: string, code?: number): Error {
  const err = new Error(message)
  if (code !== undefined) (err as Error & { code?: number }).code = code
  return err
}

export class FakeServer {
  readonly nodes = new Map<string, FakeNode>()
  /** 调用轨迹：断言"用的是 posix-rename"、"没删过目标"全靠它 */
  readonly calls: string[] = []
  /** 关掉 = 模拟未通告 posix-rename 扩展的服务器 */
  posixRename = true
  /**
   * 打开 = 所有 'wx'（排他创建）都失败，模拟"随便换多少个随机名都撞得上"。
   * 真服务器上撞名和"目录不可写"回的是同一个 SSH_FX_FAILURE，分不开 —— 正好一起覆盖。
   */
  refuseExclusive = false
  /** 设了就让**第一次** posix-rename 卡在这个 promise 上：用来造"上传在飞时又存了一次" */
  posixRenameGate: Promise<void> | null = null
  /** 返回 true 就让这次 rename 失败（只失败 tmp→target 那一步，用来验残留回收） */
  renameFails: ((from: string, to: string) => boolean) | null = null
  /** 返回 true 就让这次 stat 失败：用来造"写回之后那次 stat 打不通" */
  statHook: ((path: string) => boolean) | null = null
  readonly sftp: SFTPWrapper

  private clock = 1000
  private handleSeq = 0
  private readonly handles = new Map<string, { path: string }>()

  constructor() {
    this.sftp = this.build()
  }

  putFile(path: string, content: Buffer | string, mode = 0o644): void {
    this.nodes.set(path, {
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      link: null,
      mode: S_IFREG | mode,
      mtime: ++this.clock
    })
  }

  putLink(path: string, target: string): void {
    const mtime = ++this.clock
    this.nodes.set(path, { content: null, link: target, mode: S_IFLNK | 0o777, mtime })
  }

  /** 读最终内容（跟随软链），不存在给 null */
  contentOf(path: string): string | null {
    const node = this.resolve(path)
    return node?.content ? node.content.toString('utf8') : null
  }

  modeOf(path: string): number | null {
    const node = this.resolve(path)
    return node ? node.mode & 0o7777 : null
  }

  paths(): string[] {
    return [...this.nodes.keys()].sort()
  }

  /** 第三方改动：内容与 mtime 都变（模拟别人 vim 存了一次） */
  thirdPartyWrite(path: string, content: string): void {
    const node = this.resolve(path)
    if (!node) throw new Error(`fixture 里没有 ${path}`)
    node.content = Buffer.from(content)
    node.mtime = ++this.clock
  }

  private resolvePath(path: string): string {
    let cur = path
    for (let i = 0; i < 8; i++) {
      const node = this.nodes.get(cur)
      if (!node?.link) return cur
      cur = node.link
    }
    return cur
  }

  private resolve(path: string): FakeNode | undefined {
    return this.nodes.get(this.resolvePath(path))
  }

  private statOf(node: FakeNode): { mode: number; size: number; mtime: number } {
    return { mode: node.mode, size: node.content?.length ?? 0, mtime: node.mtime }
  }

  private build(): SFTPWrapper {
    const fake = {
      open: (path: string, flags: string, a: unknown, b?: unknown): void => {
        const cb = (typeof a === 'function' ? a : b) as OpenCb
        const mode = typeof a === 'number' ? a : undefined
        this.calls.push(`open ${path} ${flags}${mode === undefined ? '' : ` ${mode.toString(8)}`}`)
        const real = this.resolvePath(path)
        if (flags === 'wx') {
          /**
           * CREAT|EXCL：路径上已有任何东西（含符号链接）都当场失败，所以这里用**原始 path**
           * 判存在、也在原始 path 上建 —— EXCL 根本不会跟随软链，这正是它的价值。
           * SFTP v3 没有 EEXIST，OpenSSH 对 EXCL 冲突一律回 SSH_FX_FAILURE(4)。
           */
          if (this.refuseExclusive || this.nodes.has(path)) {
            cb(sftpErr('Failure', 4), Buffer.alloc(0))
            return
          }
          this.nodes.set(path, {
            content: Buffer.alloc(0),
            link: null,
            mode: S_IFREG | (mode ?? 0o644),
            mtime: ++this.clock
          })
          const fresh = String(++this.handleSeq)
          this.handles.set(fresh, { path })
          cb(undefined, Buffer.from(fresh))
          return
        }
        if (flags === 'w') {
          // 真服务器的 'w' 当场截断 —— 这条是本文件最重要的一句假实现
          this.nodes.set(real, {
            content: Buffer.alloc(0),
            link: null,
            mode: S_IFREG | (mode ?? 0o644),
            mtime: ++this.clock
          })
        } else if (!this.nodes.has(real)) {
          cb(sftpErr('No such file', 2), Buffer.alloc(0))
          return
        }
        const handle = String(++this.handleSeq)
        this.handles.set(handle, { path: real })
        cb(undefined, Buffer.from(handle))
      },
      close: (handle: Buffer, cb: VoidCb): void => {
        this.handles.delete(handle.toString())
        cb()
      },
      read: (
        handle: Buffer,
        buf: Buffer,
        offset: number,
        length: number,
        position: number,
        cb: ReadCb
      ): void => {
        const open = this.handles.get(handle.toString())
        const content = open ? this.nodes.get(open.path)?.content : null
        if (!content) return cb(sftpErr('Failure', 4), 0, buf, position)
        if (position >= content.length) return cb(sftpErr('EOF', 1), 0, buf, position)
        const slice = content.subarray(position, Math.min(position + length, content.length))
        slice.copy(buf, offset)
        cb(undefined, slice.length, buf, position)
      },
      write: (
        handle: Buffer,
        buf: Buffer,
        offset: number,
        length: number,
        position: number,
        cb: VoidCb
      ): void => {
        const open = this.handles.get(handle.toString())
        const node = open ? this.nodes.get(open.path) : undefined
        if (!node) return cb(sftpErr('Failure', 4))
        const before = node.content ?? Buffer.alloc(0)
        const next = Buffer.alloc(Math.max(before.length, position + length))
        before.copy(next)
        buf.copy(next, position, offset, offset + length)
        node.content = next
        node.mtime = ++this.clock
        cb()
      },
      stat: (path: string, cb: StatCb): void => {
        // 钩子先判：真服务器上 stat 也会因为连接抖动失败，而不是只在"文件不存在"时失败
        if (this.statHook?.(path)) return cb(sftpErr('Failure', 4), undefined)
        const node = this.resolve(path)
        if (!node) return cb(sftpErr('No such file', 2), undefined)
        cb(undefined, this.statOf(node))
      },
      lstat: (path: string, cb: StatCb): void => {
        const node = this.nodes.get(path)
        if (!node) return cb(sftpErr('No such file', 2), undefined)
        cb(undefined, this.statOf(node))
      },
      realpath: (path: string, cb: (err: Error | undefined, resolved: string) => void): void => {
        this.calls.push(`realpath ${path}`)
        cb(undefined, this.resolvePath(path))
      },
      chmod: (path: string, mode: number, cb: VoidCb): void => {
        this.calls.push(`chmod ${path} ${mode.toString(8)}`)
        const real = this.resolvePath(path)
        const node = this.nodes.get(real)
        if (!node) return cb(sftpErr('No such file', 2))
        node.mode = (node.mode & 0o170000) | (mode & 0o7777)
        cb()
      },
      rename: (from: string, to: string, cb: VoidCb): void => {
        this.calls.push(`rename ${from} -> ${to}`)
        if (this.renameFails?.(from, to)) return cb(sftpErr('Permission denied', 3))
        const node = this.nodes.get(from)
        if (!node) return cb(sftpErr('No such file', 2))
        // SFTP 的普通 rename 不覆盖已存在目标
        if (this.nodes.has(to)) return cb(sftpErr('File already exists', 4))
        this.nodes.delete(from)
        this.nodes.set(to, node)
        cb()
      },
      unlink: (path: string, cb: VoidCb): void => {
        this.calls.push(`unlink ${path}`)
        if (!this.nodes.delete(path)) return cb(sftpErr('No such file', 2))
        cb()
      },
      ext_openssh_rename: (from: string, to: string, cb: VoidCb): void => {
        if (!this.posixRename) {
          // ssh2 在拼包之前同步 throw（未通告扩展），一个字节都没上线
          throw new Error('Server does not support this extended request')
        }
        const apply = (): void => {
          this.calls.push(`posix-rename ${from} -> ${to}`)
          const node = this.nodes.get(from)
          if (!node) return cb(sftpErr('No such file', 2))
          this.nodes.delete(from)
          this.nodes.set(to, node) // 覆盖，这才是原子替换
          cb()
        }
        // 闸门只拦第一次：第二个 job 要能自己跑完，否则测试只能验到"卡住"
        const gate = this.posixRenameGate
        this.posixRenameGate = null
        if (gate) void gate.then(apply)
        else apply()
      }
    }
    return fake as unknown as SFTPWrapper
  }
}
