import { app } from 'electron'
import { z } from 'zod'
import { MAX_EDIT_BYTES, REMOTE_CHARSETS } from '@shared/constants'
import { handle } from './registry'
import { fastDelete, fastDeletePreview } from '../sftp/fastDelete'
import { saveRemoteTextFile } from '../sftp/fileSave'
import { viewRemoteFile } from '../sftp/fileView'
import { chmod, mkdir, readdir, realpath, remove, rename } from '../sftp/SftpManager'
import { sftpClose, sftpOpen, sftpStat } from '../sftp/sftpLowLevel'
import { toRemotePath } from '../sftp/remotePath'
import { transferQueue } from '../sftp/TransferQueue'
import { sshManager } from '../ssh/SshConnectionManager'

/**
 * 这个文件里所有 channel 都**只收远端路径**，一条本地路径都不收。
 *
 * 上一版这条铁律还有下半句（临时文件的位置 100% 由 main 派生、所以 shell.openPath 与
 * spawn(编辑器) 是安全的）—— 外部编辑器整条路已经删掉，那两个调用点也就都不存在了。
 * 留着上半句：`sftp:fileView` / `sftp:fileSave` 都只吃 (sessionId, remotePath)，
 * 内容以字符串来回，main 侧不落任何本地文件。哪天有人给这几个 channel 加上"本地路径"
 * 参数（哪怕只是为了"在文件夹中显示"），得先想清楚它会不会变成任意文件写。
 */
const sessionPath = z.object({ sessionId: z.string(), path: z.string().max(4096) })
/**
 * 快速删除的路径数组。zod 这一层只管形状（非空、不超长、条数有上限）——
 * 真正的守卫（必须绝对路径、不许 `.`/`..`、非空路径段至少两级）在 fastDelete.ts 里，
 * 那边是纯函数、有用例表。**别把守卫搬进 schema**：schema 拦不住的东西太多，
 * 而"守卫只有一处"是这条链路唯一好审计的形状。
 */
const fastDeletePaths = z.array(z.string().min(1).max(4096)).min(1).max(200)
export function registerSftpIpc(): void {
  handle('sftp:readdir', ({ sessionId, path }) => readdir(sessionId, path), z.tuple([sessionPath]))
  handle('sftp:realpath', ({ sessionId, path }) => realpath(sessionId, path), z.tuple([sessionPath]))
  handle('sftp:mkdir', ({ sessionId, path }) => mkdir(sessionId, path), z.tuple([sessionPath]))
  handle(
    'sftp:rename',
    ({ sessionId, from, to }) => rename(sessionId, from, to),
    z.tuple([z.object({ sessionId: z.string(), from: z.string().max(4096), to: z.string().max(4096) })])
  )
  handle(
    'sftp:delete',
    ({ sessionId, path, recursive }) => remove(sessionId, path, recursive),
    z.tuple([sessionPath.extend({ recursive: z.boolean() })])
  )
  handle(
    'sftp:chmod',
    ({ sessionId, path, mode }) => chmod(sessionId, path, mode),
    z.tuple([sessionPath.extend({ mode: z.number().int().min(0).max(0o7777) })])
  )

  /**
   * 新建空文件。用 'wx'（O_CREAT|O_EXCL）而不是现成的 writeRemoteFile ——
   * 那个是 'w'，会把已存在的同名文件截断成 0 字节：用户手滑点一次「新建 > 文件」
   * 就能清空自己的 nginx.conf。EXCL 的排他性由服务器保证，先 stat 再建挡不住竞态。
   * （ssh2 的 'wx' 里也带着 TRUNC，但 EXCL 已经把"已存在"挡在门外，截断轮不到发生。）
   *
   * 前面那次 stat 只为了给人话：SFTP v3 没有 EEXIST 这样的细分码，OpenSSH 对 EXCL 冲突
   * 一律回 SSH_FX_FAILURE，界面上只会看到一个干巴巴的 "Failure"。
   * 就地写而不是给 sftpLowLevel 加函数：那个文件不归本片改动管，而这里要的只是 open+close。
   */
  handle(
    'sftp:touch',
    async ({ sessionId, path }) => {
      const sftp = await sshManager.get(sessionId).browseSftpSession()
      const target = toRemotePath(path)
      if (await sftpStat(sftp, target)) throw new Error(`同名文件或目录已存在：${target}`)
      // 0o644 与传输侧新建文件的权限一致，免得"新建"出来的文件和"上传"出来的不一样
      const fd = await sftpOpen(sftp, target, 'wx', 0o644)
      await sftpClose(sftp, fd)
    },
    z.tuple([sessionPath])
  )

  /**
   * 快速删除。两条 channel 共用 fastDelete.ts 里同一个 buildFastDeleteCommand ——
   * 用户在确认框里看到的那条命令，和真正发出去的那条，是同一个函数产出的。
   *
   * preview 不收 sessionId（它是纯的）；fastDelete 里守卫会**重跑一遍**，
   * 因为没人能保证 preview 一定被调过。
   */
  handle(
    'sftp:fastDeletePreview',
    ({ paths }) => fastDeletePreview(paths),
    z.tuple([z.object({ paths: fastDeletePaths })])
  )

  handle(
    'sftp:fastDelete',
    ({ sessionId, paths }) => fastDelete(sessionId, paths),
    z.tuple([z.object({ sessionId: z.string(), paths: fastDeletePaths })])
  )

  /**
   * 内置编辑器的只读打开。
   *
   * `charset` 用 z.enum(REMOTE_CHARSETS) 卡死，**不是**为了给用户友好提示 ——
   * 它是安全边界：iconv-lite 还接受 'hex' / 'base64' 这类字节变换，
   * 而这个参数是渲染进程可控的（状态栏上能切编码）。可编辑之后，
   * 一个 'hex' 就意味着渲染进程能用 "0a1b2c…" 精确构造任意字节写到远端文件里。
   * 现在这条通道还只读，但白名单要从第一天就在 —— 补在"能写了之后"的那天是补不上的。
   */
  handle(
    'sftp:fileView',
    ({ sessionId, path, charset }) => viewRemoteFile(sessionId, path, charset),
    z.tuple([sessionPath.extend({ charset: z.enum(REMOTE_CHARSETS).optional() })])
  )

  /**
   * 内置编辑器的保存。这条 schema 的每一条都是在挡一种**静默改写文件**的路，
   * 逐条说明为什么不能松：
   *
   * - `charset` **必填**（fileView 那条可以缺省成 utf8，这条不行）：缺省值会把一个
   *   GBK 的配置按 UTF-8 存回去，整个文件变乱码而且没有任何报错。而且它就是
   *   fileView 那段注释里说的那个安全边界 —— 现在这条通道真的能写了，
   *   一个 `hex` 就意味着渲染进程能用 "0a1b2c…" 精确构造任意字节写到远端文件里。
   * - `eol` / `hasBom` **必填**：默认值会把 CRLF 文件整个翻面、会替用户删掉
   *   .bat / .ps1 的 BOM。两者都不报错、都在几天后才被发现。
   * - `gates` 三个开关**必填 boolean**，不许 `.optional()` 也不许 `.default()`：
   *   每一个都对应一次"用户看过风险并点了确认"，而缺省值的方向恰好是"放行"。
   *   `z.object` 默认会剥掉未声明的键，所以渲染进程塞第四个开关进来也穿不过去。
   * - `text` 的长度上限是**粗筛**（挡住荒唐的载荷跨过 IPC），真正的字节闸门在
   *   fileSave 里按**编码后**的长度判 —— 700K 个中文字符按 UTF-8 是 2.1MB、
   *   按 GBK 是 1.4MB，只有编码后的长度才是要写上去的那个数。
   */
  handle(
    'sftp:fileSave',
    (args) => saveRemoteTextFile(args),
    z.tuple([
      sessionPath.extend({
        text: z.string().max(MAX_EDIT_BYTES),
        charset: z.enum(REMOTE_CHARSETS),
        eol: z.enum(['lf', 'crlf']),
        hasBom: z.boolean(),
        gates: z.object({
          overwriteRemoteChanges: z.boolean(),
          allowNonAtomic: z.boolean(),
          allowShrink: z.boolean()
        })
      })
    ])
  )

  handle(
    'transfer:enqueue',
    (items) =>
      transferQueue.enqueue(
        items.map((item) => ({
          ...item,
          // 未指定本地目标目录时落到系统下载目录
          localPath: item.localPath || app.getPath('downloads')
        }))
      ),
    z.tuple([
      z
        .array(
          z.object({
            sessionId: z.string(),
            kind: z.enum(['upload', 'download']),
            localPath: z.string().max(4096),
            remotePath: z.string().max(4096)
          })
        )
        .max(5000)
    ])
  )

  handle(
    'transfer:control',
    ({ taskId, op }) => transferQueue.control(taskId, op),
    z.tuple([
      z.object({ taskId: z.string(), op: z.enum(['pause', 'resume', 'cancel', 'retry']) })
    ])
  )

  handle('transfer:clearFinished', () => transferQueue.clearFinished())
  handle('transfer:list', () => transferQueue.list())
}
