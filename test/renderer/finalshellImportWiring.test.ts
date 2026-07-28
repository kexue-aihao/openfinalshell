import { describe, expect, it } from 'vitest'
import en from '@/i18n/en-US'
import zh from '@/i18n/zh-CN'
import { blockAfter, channelsOf, flat, read, stripComments } from '../sourceGuard'

/**
 * FinalShell 导入的接线护栏。三条各守一件"改错了看不出来"的事：
 *
 *  1. **写库只走 saveProfile**。那是本项目唯一的加密入口（明文进去、密文落库、
 *     只回一个引用）。谁哪天为了"顺手设个 lastUsedAt"改成自己拼 ConnectionProfile +
 *     upsertProfile，明文就会直接进 profiles 表的 JSON 列，而代码看着一样能跑。
 *  2. **解密结果必须过 acceptDecryptedSecret**。那是"永不把垃圾当密码存下来"的唯一守门人；
 *     将来接上密钥推导的人如果图快跳过它，坏密码会被规规矩矩地加密保存。
 *  3. **确认框在用户点确认之前就说清楚带不过来什么**。导完再说等于让他先以为搬完了。
 */

const SERVICE = 'src/main/services/finalshellImport.ts'
const PANEL = 'src/renderer/src/features/settings/FinalShellImportPanel.tsx'

describe('契约', () => {
  it('两条 channel 都在 app: 前缀下', () => {
    const invoke = channelsOf('InvokeMap')
    expect(invoke).toContain('app:finalshellScan')
    expect(invoke).toContain('app:finalshellImport')
  })

  it('渲染进程不传目录路径（选目录是 main 的事）', () => {
    const panel = stripComments(read(PANEL))
    expect(panel).toContain("ofs.invoke('app:finalshellScan', {})")
    // 传 dir 的写法只该出现在测试与冒烟里
    expect(panel).not.toMatch(/finalshellScan',\s*\{\s*dir/)
  })

  it('入参过 zod（token 与冲突策略都卡死）', () => {
    const ipc = flat(stripComments(read('src/main/ipc/app.ipc.ts')))
    expect(ipc).toContain("'app:finalshellImport'")
    expect(ipc).toContain("conflict: z.enum(['skip', 'duplicate'])")
  })
})

describe('加密入口不许被绕过', () => {
  const src = stripComments(read(SERVICE))

  it('写连接只经 saveProfile', () => {
    const apply = flat(blockAfter(src, 'export function applyFinalShellImport'))
    expect(apply).toContain('saveProfile(draft)')
    // 绕过加密入口的两种写法
    expect(src).not.toContain('upsertProfile')
    expect(src).not.toContain('vault.')
    expect(src).not.toContain('putSecret')
  })

  it('整个模块不自己写 SQL', () => {
    expect(src).not.toContain('prepare(')
    expect(src).not.toMatch(/INSERT\s+INTO/i)
  })
})

describe('解密那条路的守门人', () => {
  const src = stripComments(read(SERVICE))

  it('acceptDecryptedSecret 三道判定都在（padding / UTF-8 往返 / 控制字符）', () => {
    const fn = flat(blockAfter(src, 'export function acceptDecryptedSecret'))
    expect(fn).toContain('pad < 1 || pad > 8')
    expect(fn).toContain("Buffer.from(text, 'utf8').compare(body)")
    expect(fn).toContain('code < 0x20 || code === 0x7f')
  })

  it('当前的 decrypt 就是明确的 null，不是"试着解一下"', () => {
    const fn = flat(blockAfter(src, 'export function decryptFinalShellPassword'))
    expect(fn).toContain('return null')
    // 没有任何真的密码学调用 —— 有的话就说明有人接了推导却没同时接上校验
    expect(src).not.toContain('createDecipheriv')
    expect(src).not.toContain('des-ecb')
  })

  /**
   * 源码里不许躺着任何真实密文。样本记录是用户给的，测试里那条已经把值换成编的了；
   * 这条护栏盯的是"下一次有人贴一条真实记录进来当注释"。
   */
  it('服务与测试里都没有那条真实密文', () => {
    const real = 'bR0YbkkiVDe8HESscsKTL0eLwND25i9kSxU'
    expect(read(SERVICE)).not.toContain(real)
    // 结构判定那条用例里出现的是它的**形状**，不是它本身 —— 允许，但值必须不同
    const test = read('test/unit/finalshellImport.test.ts')
    expect(test.includes(real)).toBe(true) // 只用来验"认得出这种形状"
    expect(test).not.toContain('82.47.34.254') // 真实主机不许进仓库
  })
})

describe('界面把"带不过来什么"说在确认之前', () => {
  const panel = stripComments(read(PANEL))

  it('扫描给的 notes 在确认框里逐条显示', () => {
    expect(panel).toContain('scan.notes.map(')
    expect(panel).toContain('type="warning"')
  })

  it('入口说明里就写明密码不会跟过来', () => {
    expect(zh.translation.settings.fsImportDesc).toContain('密码不会跟过来')
    expect(en.translation.settings.fsImportDesc).toContain('Passwords do not come across')
  })

  it('导入后刷新连接树（不刷用户会以为没导进来，然后再导一遍）', () => {
    expect(flat(blockAfter(panel, 'const doImport ='))).toContain('reloadConnections()')
  })

  it('文案两边都齐', () => {
    const keys = [
      'fsImportTitle',
      'fsImportDesc',
      'fsImportButton',
      'fsImportModalTitle',
      'fsImportCounts',
      'fsImportMore',
      'fsImportSkipped',
      'fsImportConflict',
      'fsImportConflictSkip',
      'fsImportConflictDuplicate',
      'fsImportResult'
    ] as const
    for (const key of keys) {
      expect(zh.translation.settings[key], `zh 缺 settings.${key}`).toBeTruthy()
      expect(en.translation.settings[key], `en 缺 settings.${key}`).toBeTruthy()
    }
  })
})
