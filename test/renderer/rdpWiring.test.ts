import { describe, expect, it } from 'vitest'
import { flat, read, stripComments } from '../sourceGuard'

/**
 * RDP 接线护栏。护的核心是两条：
 *  - 走系统远程桌面（shell.openPath），**不**引入 child_process（否则触碰 localTar 那条铁律）；
 *  - RDP 连接**不**建 SSH 会话 tab（分派在 launchProfile 里按 protocol 走）。
 */

const rdp = stripComments(read('src/main/services/rdpLaunch.ts'))
const store = stripComments(read('src/renderer/src/stores/useSessionStore.ts'))
const ipc = stripComments(read('src/main/ipc/conn.ipc.ts'))

describe('RDP：main 侧', () => {
  it('用 shell.openPath 打开 .rdp，绝不 spawn/exec mstsc', () => {
    expect(rdp).toContain('shell.openPath')
    expect(rdp).not.toContain('child_process')
    expect(rdp).not.toContain('spawn(')
    expect(rdp).not.toContain('execFile')
  })

  it('.rdp 里不写密码指令（凭据由系统接管）', () => {
    // 生成器里不许出现写密码的 .rdp 指令
    expect(rdp.toLowerCase()).not.toContain('password 51:')
    expect(rdp).toContain('prompt for credentials:i:1')
  })

  it('launchRdp channel 有 zod 校验且按 id 查 profile', () => {
    const flatIpc = flat(ipc)
    expect(flatIpc).toContain("'conn:launchRdp'")
    // 该 handler 块里查 profile、调 launchRdp、带 zod tuple
    expect(flatIpc).toMatch(/'conn:launchRdp'[\s\S]{0,200}getProfile\(id\)/)
    expect(flatIpc).toMatch(/'conn:launchRdp'[\s\S]{0,300}z\.tuple/)
  })
})

describe('RDP：分派', () => {
  it('launchProfile 按 protocol 分派：rdp 走 conn:launchRdp，不建 tab', () => {
    expect(store).toContain("if (profile.protocol === 'rdp')")
    expect(store).toContain("ofs.invoke('conn:launchRdp', profile.id)")
    // rdp 分支必须在 openForProfile 之前 return —— 不能又建了个 SSH tab
    const rdpAt = store.indexOf("profile.protocol === 'rdp'")
    const launchBlock = store.slice(rdpAt, rdpAt + 200)
    expect(launchBlock).toContain("return 'rdp'")
  })
})
