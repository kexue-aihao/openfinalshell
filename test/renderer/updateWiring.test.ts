import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { blockAfter, channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * 自动更新这一片的源码护栏。
 *
 * `services/updater.ts` 在 node 测试环境里**加载不了**（它 import electron-updater：
 * CJS + 要真 electron 运行时），所以那里面的接线只能靠读源码守。唯一有后果的那条判断
 * 已经提到 updateGate.ts，有真正的行为用例（test/unit/updateGate.test.ts）。
 *
 * 每一条守的都是"改错了编译得过、界面看着正常，只是某天把用户的会话全断了"：
 */

const UPDATER = 'src/main/services/updater.ts'
const IPC = 'src/main/ipc/update.ipc.ts'

describe('契约', () => {
  it('三条 channel 在 InvokeMap、状态走 EventMap', () => {
    const invoke = channelsOf('InvokeMap')
    expect(invoke).toContain('update:check')
    expect(invoke).toContain('update:download')
    expect(invoke).toContain('update:install')
    expect(channelsOf('EventMap')).toContain('update:state')
  })

  it("'update:' 在 preload 的前缀白名单里", () => {
    const src = stripComments(read('src/shared/ipc.ts'))
    const at = src.indexOf('export const CHANNEL_PREFIXES')
    expect(src.slice(at, src.indexOf('] as const', at))).toContain("'update:'")
  })

  /**
   * force 必须是**必填** boolean。可选字段配 `?? false` 是最容易被顺手写成 `?? true`
   * 的地方，而这里默认值的方向恰好是"不问就装"——那一下断掉用户所有会话。
   * （与 RemoteSaveGates 那三个必填开关同一条理由。）
   */
  it('install 的 force 是必填 boolean，没有 optional', () => {
    const ipc = flat(stripComments(read(IPC)))
    expect(ipc).toContain('z.object({ force: z.boolean() })')
    expect(ipc).not.toContain('force: z.boolean().optional()')
  })
})

describe('绝不自己重启', () => {
  const src = stripComments(read(UPDATER))

  it('autoInstallOnAppQuit 关掉 —— 不许在退出时偷偷装', () => {
    expect(flat(src)).toContain('autoUpdater.autoInstallOnAppQuit = false')
    expect(flat(src)).not.toContain('autoInstallOnAppQuit = true')
  })

  it('quitAndInstall 只有一处，且排在收摊之后', () => {
    expect(src.match(/quitAndInstall\(/g) ?? []).toHaveLength(1)
    const body = flat(blockAfter(src, 'export function installUpdate'))
    for (const step of [
      'transferQueue.cancelAll()',
      'monitorManager.stopAll()',
      'forwardManager.stopAll()',
      'sshManager.closeAll()',
      'closeDatabase()'
    ]) {
      expect(body).toContain(step)
      expect(body.indexOf(step)).toBeLessThan(body.indexOf('quitAndInstall('))
    }
  })

  it('判断走 updateGate，不在这儿再写一遍', () => {
    expect(src).toContain('decideInstall({')
    // 第二份判断的特征
    expect(flat(blockAfter(src, 'export function installUpdate'))).not.toContain(
      'activity.sessions > 0'
    )
  })
})

describe('两道短路', () => {
  const src = stripComments(read(UPDATER))

  it('免安装与 Debian 都由 capability 统一分流', () => {
    expect(src).toContain('process.env.PORTABLE_EXECUTABLE_DIR')
    expect(src).toContain('resolveUpdateCapability({')
    expect(flat(blockAfter(src, 'function wire'))).toContain(
      "autoUpdater.autoDownload = capability === 'install'"
    )
    expect(flat(blockAfter(src, 'export async function downloadUpdate'))).toContain(
      "capability !== 'install'"
    )
    const check = flat(blockAfter(src, 'export async function checkForUpdate'))
    expect(check).toContain("capability === 'manual'")
    expect(check).toContain('checkLatestRelease(app.getVersion())')
  })

  it('dev 里整个短路（app.isPackaged）', () => {
    expect(flat(blockAfter(src, 'export async function checkForUpdate'))).toContain(
      'if (!app.isPackaged) return'
    )
    expect(flat(blockAfter(src, 'export function startUpdateChecks'))).toContain(
      'if (!app.isPackaged) return'
    )
  })

  it('自动检查受设置开关约束，且默认开', () => {
    expect(flat(blockAfter(src, 'export function startUpdateChecks'))).toContain(
      'getSettings().autoCheckUpdate'
    )
    expect(DEFAULT_SETTINGS.autoCheckUpdate).toBe(true)
  })
})

describe('发布侧', () => {
  const eb = readFileSync('electron-builder.yml', 'utf8')
  const wf = readFileSync('.github/workflows/build-windows.yml', 'utf8')

  /**
   * Windows 上 latest.yml 不带架构后缀，两个 job 会写同名文件互相覆盖。
   * 这一行是"两个架构都能收到更新"的全部前提。
   */
  it('publish.channel 按架构分', () => {
    expect(eb).toContain('channel: latest-${arch}')
  })

  it('CI 会断言不许出现裸 latest.yml（那意味着架构间覆盖）', () => {
    expect(wf).toContain('出现裸 latest.yml')
    // per-arch 与合并后各断一次
    expect(wf.match(/裸 latest\.yml/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('CI 会重算 sha512 与 feed 对照，并要求 blockmap 在', () => {
    expect(wf).toContain('openssl dgst -sha512')
    expect(wf).toContain('.blockmap')
  })

  it('artifact 与 Release 都带上 feed 与 blockmap', () => {
    expect(wf).toContain('release/latest-*.yml')
    expect(wf).toContain('dist/latest-*.yml')
    expect(wf).toContain('dist/*.exe.blockmap')
  })
})

describe('文案', () => {
  const keys = [
    'idle', 'check', 'checking', 'upToDate', 'availableTag', 'readyTag', 'install',
    'failed', 'portable', 'manualAvailableTag', 'openReleases', 'manualNote', 'note',
    'confirmTitle', 'confirmBody', 'confirmTail', 'confirmOk'
  ] as const

  it('update.* 两边都齐', () => {
    for (const k of keys) {
      expect(zh.translation.update[k], `zh 缺 update.${k}`).toBeTruthy()
      expect(en.translation.update[k], `en 缺 update.${k}`).toBeTruthy()
    }
  })

  it('确认框把"会断掉什么"说成具体数字，而不是含糊的"可能影响当前操作"', () => {
    expect(zh.translation.update.confirmBody).toContain('{{sessions}}')
    expect(zh.translation.update.confirmBody).toContain('{{transfers}}')
    expect(zh.translation.update.confirmBody).toContain('{{forwards}}')
  })

  it('说明里写明了"装不装由你点"', () => {
    expect(zh.translation.update.note).toContain('由你点')
  })
})
