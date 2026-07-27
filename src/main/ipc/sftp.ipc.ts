import { app, dialog } from 'electron'
import { z } from 'zod'
import { REMOTE_CHARSETS } from '@shared/constants'
import { emit, handle } from './registry'
import { remoteEditManager, type EditId, type RemoteEditInfo } from '../sftp/RemoteEditManager'
import { fastDelete, fastDeletePreview } from '../sftp/fastDelete'
import { viewRemoteFile } from '../sftp/fileView'
import { chmod, mkdir, readdir, realpath, remove, rename } from '../sftp/SftpManager'
import { sftpClose, sftpOpen, sftpStat } from '../sftp/sftpLowLevel'
import { toRemotePath } from '../sftp/remotePath'
import { transferQueue } from '../sftp/TransferQueue'
import { assertUsableEditor, getSettings, patchSettings } from '../services/settings'
import { sshManager } from '../ssh/SshConnectionManager'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('sftp-ipc')

/**
 * 远端编辑相关 channel 的一条铁律：**没有任何 channel 接受本地路径**。
 * 临时文件的位置 100% 由 main 从 (sessionId, remotePath) 派生（RemoteEditManager.land），
 * 渲染进程只能拿到不透明的 editId 和一个只读的 localPath 展示值。
 *
 * 这一条就是 RemoteEditManager 里那句 shell.openPath / spawn(编辑器) 得以存在的唯一理由：
 * 被打开/被执行的路径不可能来自渲染进程。哪天有人给这几个 channel 加上"本地路径"参数
 * （哪怕只是为了"在文件夹中显示"），那一行就立刻变成任意文件打开/执行。
 *
 * 但那句话此前只覆盖了 spawn 的 **argv**，没覆盖 **file** —— 被执行的那个 exe 来自
 * settings.sftp.externalEditorPath，而 settings:set 曾经对内容零校验，于是
 * 「下载任意文件到任意本地路径 → 把这个字段指向它 → 编辑任何远端文件」三步就是任意程序执行。
 * 补上的另一半分两层，两层都在 services/settings.ts 里：
 *  - **写入侧**：这个字段只由下面 sftp:pickEditor 一条路写入（对话框 + assertUsableEditor），
 *    settings:set 与导入配置这两个外来入口都会把这一键剥掉（stripMainOnlyPaths）；
 *  - **使用侧**：spawn 之前再调一次 assertUsableEditor —— 库里的值可能是老版本、
 *    导入文件或手改 SQLite 留下的，写入时校验管不到它们。
 */

const sessionPath = z.object({ sessionId: z.string(), path: z.string().max(4096) })
/**
 * 快速删除的路径数组。zod 这一层只管形状（非空、不超长、条数有上限）——
 * 真正的守卫（必须绝对路径、不许 `.`/`..`、非空路径段至少两级）在 fastDelete.ts 里，
 * 那边是纯函数、有用例表。**别把守卫搬进 schema**：schema 拦不住的东西太多，
 * 而"守卫只有一处"是这条链路唯一好审计的形状。
 */
const fastDeletePaths = z.array(z.string().min(1).max(4096)).min(1).max(200)
/** editId 是 main 侧 randomUUID 生成的不透明串，除了"非空且不长"没有别的要校验 */
const editRef = z.object({ editId: z.string().min(1).max(128) })

/** 写 externalEditorPath 的唯一去处：写完主动推一次设置，界面（含设置页回显）跟着刷 */
function saveEditorPath(exePath: string): void {
  const next = patchSettings({ sftp: { ...getSettings().sftp, externalEditorPath: exePath } })
  emit('settings:changed', next)
}

/** 状态转发：main 侧的 message 按状态拆成 error / warning（见 EventMap 的说明） */
function forwardEditState(info: RemoteEditInfo): void {
  const halted = info.state === 'conflict' || info.state === 'blocked' || info.state === 'error'
  emit('sftp:editState', {
    editId: info.id,
    sessionId: info.sessionId,
    remotePath: info.remotePath,
    state: info.state,
    error: halted ? info.message : undefined,
    warning: halted ? undefined : info.message,
    eolWarning: info.eolWarning
  })
}

/**
 * forceSave / retry 都不回快照（它们只管把内容写上去），写完从注册表里再取一次。
 * 取不到只有一种可能：这期间用户点了"停止编辑"。
 *
 * 这两个入口在 pending 为空时是**抛错**的（"没有待保存的内容（可能已经写回成功了）…"），
 * 那句人话会原样穿过 invoke 抛回渲染进程 —— 界面要能把它显示出来，不许当成"未知错误"吞掉。
 */
function afterWriteBack(editId: EditId): RemoteEditInfo {
  const info = remoteEditManager.list().find((e) => e.id === editId)
  if (!info) throw new Error('该编辑已结束')
  return info
}

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

  // ---- 远端文件编辑（本地路径只出不进，见文件顶部） ----
  remoteEditManager.onState(forwardEditState)

  handle(
    'sftp:editOpen',
    ({ sessionId, path }) => remoteEditManager.open(sessionId, path),
    z.tuple([sessionPath])
  )

  handle(
    'sftp:editList',
    ({ sessionId }) => remoteEditManager.list().filter((e) => e.sessionId === sessionId),
    z.tuple([z.object({ sessionId: z.string() })])
  )

  handle(
    'sftp:editSave',
    async ({ editId, force }) => {
      /**
       * 只认 force === true。这个 channel 对应的是 forceSave —— 跳过冲突检测、
       * 允许在服务器不支持原子替换时退化；普通存盘是本地文件监视自动触发的、界面催不动。
       * 所以缺省值这里必须拒 —— 否则一个叫"保存"的按钮会悄悄走上覆盖别人改动的那条路。
       * 想"再试一次但别跳过检测"的走 sftp:editRetry。
       */
      if (force !== true) {
        throw new Error('普通存盘由本地文件监视自动触发；此接口只用于用户确认后的"仍然覆盖"')
      }
      await remoteEditManager.forceSave(editId)
      return afterWriteBack(editId)
    },
    z.tuple([editRef.extend({ force: z.boolean().optional() })])
  )

  /**
   * 重试：**保留冲突检测**，只是把 main 侧留着的 pending 再走一遍写回。
   * error 态的默认出口（那些"会话未就绪"之类的瞬时故障重试一下就好），
   * 和上面那条"仍然覆盖"是两个不同的按钮、两个不同的语义。
   */
  handle(
    'sftp:editRetry',
    async ({ editId }) => {
      await remoteEditManager.retry(editId)
      return afterWriteBack(editId)
    },
    z.tuple([editRef])
  )

  handle('sftp:editStop', ({ editId }) => remoteEditManager.stop(editId), z.tuple([editRef]))

  /**
   * 选外部编辑器。对话框在 main 侧弹、路径在 main 侧校验、设置在 main 侧写 ——
   * 渲染进程从头到尾只拿回一个字符串用于回显（它自己写不进这个字段，见文件顶部）。
   */
  handle('sftp:pickEditor', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择编辑远端文件用的编辑器',
      properties: ['openFile'],
      // 只是过滤器，不是校验 —— 真正的校验在 assertUsableEditor（用户可以把过滤器切成"全部文件"），
      // 那个函数现在归 services/settings.ts，spawn 之前也要再调一次（见文件顶部）
      filters:
        process.platform === 'win32' ? [{ name: '可执行文件', extensions: ['exe'] }] : undefined
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const picked = r.filePaths[0]
    await assertUsableEditor(picked)
    saveEditorPath(picked)
    log.info(`external editor set to ${picked}`)
    return picked
  })

  /** 清空 = 回到"系统默认打开方式"（shell.openPath），不是"禁用编辑" */
  handle('sftp:clearEditor', () => {
    saveEditorPath('')
  })

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
