/**
 * 打包产物冒烟测试：驱动真实 Electron 应用（真 preload + 真 ssh2）走完整链路。
 *
 * 用 CDP（--remote-debugging-port）连上打包应用的渲染进程，
 * 通过 window.ofs 直接调 IPC：建连接 → 开会话 → 开 shell → 发命令 → 读 xterm 缓冲 →
 * SFTP readdir → 监控 start。全部在打包环境里跑，能抓到 asar/preload/原生依赖的打包问题。
 *
 * 前置：node test/fixtures/testSshServer.mjs <sshPort>
 * 用法：node test/fixtures/packagedSmoke.mjs [exePath] [sshPort] [cdpPort]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const exePath = process.argv[2] ?? join(process.cwd(), 'release', 'win-unpacked', 'OpenFinalShell.exe')
const sshPort = Number(process.argv[3] ?? 2270)
const cdpPort = Number(process.argv[4] ?? 9333)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
  cleanup()
  process.exit(1)
}

let app
let ws
function cleanup() {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  try {
    app?.kill()
  } catch {
    /* ignore */
  }
}

// ---------------- CDP 最小客户端 ----------------
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
    }, 30000)
  })
}

/** 在渲染进程里求值一段 async 代码，返回其结果（JSON 可序列化） */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(
      `renderer exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
    )
  }
  return result.result.value
}

async function main() {
  console.log(`launching ${exePath} (cdp ${cdpPort})`)
  app = spawn(exePath, [`--remote-debugging-port=${cdpPort}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  app.stderr.on('data', (d) => {
    const text = d.toString()
    if (/error|fail/i.test(text)) console.log(`[app stderr] ${text.trim().slice(0, 300)}`)
  })

  // 等 CDP 端口就绪并找到渲染进程 target
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {
      /* 还没起来 */
    }
  }
  if (!target) fail('CDP page target 未就绪（应用可能启动失败）')
  console.log(`OK app launched, page title = ${JSON.stringify(target.title)}`)

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP websocket 连接失败')), { once: true })
  })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  await send('Runtime.enable')

  // 1) preload 桥是否注入（打包后 preload 路径最容易错）
  const bridge = await evaluate(`
    return { hasOfs: typeof window.ofs === 'object', keys: Object.keys(window.ofs ?? {}) }
  `)
  if (!bridge.hasOfs) fail('window.ofs 未注入 —— preload 打包路径有问题')
  console.log(`OK preload bridge exposed: ${bridge.keys.join(', ')}`)

  const versions = await evaluate(`return await window.ofs.invoke('app:getVersions')`)
  console.log(`OK versions: app=${versions.app} electron=${versions.electron} node=${versions.node}`)

  const vaultOk = await evaluate(`return await window.ofs.invoke('vault:isAvailable')`)
  console.log(`OK safeStorage available = ${vaultOk}`)
  if (!vaultOk) fail('打包环境里 safeStorage 不可用（Windows 应走 DPAPI）')

  // 2) 建连接配置（密码明文进 main，加密落盘后只回引用）
  const profile = await evaluate(`
    const draft = {
      name: 'packaged-smoke',
      groupId: null,
      host: '127.0.0.1',
      port: ${sshPort},
      username: 'test',
      auth: { method: 'password', password: 'test123' },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      options: { keepaliveInterval: 15000, readyTimeout: 10000, legacyAlgorithms: false,
                 autoReconnect: false, monitorEnabled: true, compress: false }
    }
    const saved = await window.ofs.invoke('conn:save', draft)
    return { id: saved.id, hasRef: Boolean(saved.auth.passwordRef), leaked: JSON.stringify(saved).includes('test123') }
  `)
  if (!profile.hasRef) fail('凭据未写入 Vault')
  if (profile.leaked) fail('明文密码出现在回传给渲染层的 profile 里')
  console.log('OK credential stored as vault ref, no plaintext returned')

  // 3) 自动信任 hostkey + 开会话（真 ssh2 握手）
  await evaluate(`
    window.__smokePrompts = []
    window.ofs.on('session:prompt', (p) => {
      window.__smokePrompts.push(p.kind)
      window.ofs.invoke('session:promptReply', { requestId: p.requestId, ok: true, remember: true })
    })
    window.__smokeStates = []
    window.ofs.on('session:state', (s) => window.__smokeStates.push(s.state))
    window.__smokeTermData = ''
    window.ofs.on('term:data', ({ data }) => {
      window.__smokeTermData += new TextDecoder().decode(data)
      window.ofs.send('term:flow-ack', { termId: window.__smokeTermId, bytes: data.byteLength })
    })
    return true
  `)

  const session = await evaluate(`
    const { sessionId } = await window.ofs.invoke('session:open', '${profile.id}')
    return { sessionId, prompts: window.__smokePrompts, states: window.__smokeStates }
  `)
  if (!session.sessionId) fail('会话未建立')
  console.log(`OK ssh session ready (prompts: ${session.prompts.join(',') || 'none'})`)

  // 4) 开 shell、发命令、读 xterm 缓冲（走完整 IPC + 背压链路）
  const term = await evaluate(`
    const { termId } = await window.ofs.invoke('term:open', { sessionId: '${session.sessionId}', cols: 100, rows: 30 })
    window.__smokeTermId = termId
    await new Promise(r => setTimeout(r, 800))
    window.ofs.send('term:input', { termId, data: 'echo 打包冒烟-🚀\\r' })
    await new Promise(r => setTimeout(r, 1200))
    return { termId, output: window.__smokeTermData }
  `)
  if (!term.output.includes('打包冒烟-🚀')) {
    fail(`终端未回显预期内容，实际收到：${JSON.stringify(term.output.slice(-200))}`)
  }
  console.log('OK terminal roundtrip with CJK + emoji')

  // 5) SFTP 浏览（验证 sftp 子系统在打包环境可用）
  const sftp = await evaluate(`
    const home = await window.ofs.invoke('sftp:realpath', { sessionId: '${session.sessionId}', path: '.' })
    const entries = await window.ofs.invoke('sftp:readdir', { sessionId: '${session.sessionId}', path: home })
    return { home, count: entries.length }
  `)
  console.log(`OK sftp readdir ${sftp.home} → ${sftp.count} entries`)

  // 6) 监控采集（验证持久 exec 通道 + /proc 解析）
  const monitor = await evaluate(`
    window.__smokeSnapshots = 0
    window.ofs.on('monitor:data', () => { window.__smokeSnapshots++ })
    const info = await window.ofs.invoke('monitor:start', { sessionId: '${session.sessionId}', intervalMs: 1000 })
    await new Promise(r => setTimeout(r, 2600))
    return { info, snapshots: window.__smokeSnapshots }
  `)
  if (!monitor.info) fail('监控静态信息为空')
  if (monitor.snapshots < 1) fail('未收到任何监控快照')
  console.log(
    `OK monitor: ${monitor.info.distro} / ${monitor.info.cpuCores} cores, ${monitor.snapshots} snapshots`
  )

  // 7) 原生窗口按钮遮挡检查
  //    Windows 的 titleBarOverlay 由 OS 绘制、永远盖在页面之上，落到那块矩形里的
  //    按钮会被压住且点不到。这类问题只在真实窗口里才看得见 —— 单测与浏览器 mock 都抓不到，
  //    所以放在打包冒烟里，用 windowControlsOverlay 的实际矩形（不硬编码尺寸）来判。
  const overlay = await evaluate(`
    const wco = navigator.windowControlsOverlay
    if (!wco || !wco.visible) return { skipped: true }
    const bar = wco.getTitlebarAreaRect()
    // 可用标题栏区右侧剩下的就是原生按钮区
    const controls = { left: bar.width, top: 0, right: window.innerWidth, bottom: bar.height }

    const covered = (label) => {
      const hits = []
      for (const el of document.querySelectorAll('button, input, select, textarea, a, [role=radio], [role=tab], .ant-collapse-header')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.top < controls.bottom && r.right > controls.left && r.left < controls.right) {
          hits.push(label + ': ' + (el.textContent || el.getAttribute('placeholder') || el.className).replace(/\\s+/g, ' ').trim().slice(0, 30))
        }
      }
      return hits
    }

    const hits = covered('主界面')
    // 连接编辑抽屉贴着窗口右上角，是最容易撞上的一处
    const openBtn = [...document.querySelectorAll('button[title]')].find(
      (b) => b.title === '新建连接' && b.className.includes('ant-btn')
    )
    let checkedDrawer = false
    if (openBtn) {
      openBtn.click()
      await new Promise((r) => setTimeout(r, 1200))
      if (document.querySelector('.ant-drawer-open')) {
        checkedDrawer = true
        hits.push(...covered('连接编辑抽屉'))
      }
      const closeBtn = document.querySelector('.ant-drawer-close')
      if (closeBtn) closeBtn.click()
      await new Promise((r) => setTimeout(r, 600))
    }
    return { controls, hits, checkedDrawer }
  `)
  if (overlay.skipped) {
    console.log('SKIP window controls overlay 不可用（非 Windows？）')
  } else {
    if (!overlay.checkedDrawer) fail('没能打开连接编辑抽屉，遮挡检查没覆盖到它')
    if (overlay.hits.length > 0) {
      fail(`有 ${overlay.hits.length} 个可交互元素被原生窗口按钮遮挡：\n  ${overlay.hits.join('\n  ')}`)
    }
    const c = overlay.controls
    console.log(`OK 无元素落入原生窗口按钮区 (x ${c.left}–${c.right}, y 0–${c.bottom})`)
  }

  // 8) 清理
  await evaluate(`
    await window.ofs.invoke('monitor:stop', '${session.sessionId}')
    await window.ofs.invoke('session:close', '${session.sessionId}')
    await window.ofs.invoke('conn:delete', '${profile.id}')
    return true
  `)
  console.log('OK cleanup done')
  console.log('ALL PASS')
  cleanup()
  process.exit(0)
}

main().catch((err) => fail(err.message))
