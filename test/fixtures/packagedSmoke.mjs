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
import { tmpdir } from 'node:os'

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
  // 独立 user-data-dir：① 单实例锁按 userData 路径算，这样能与正在使用的实例并存；
  // ② 不再往真实连接列表里塞 packaged-smoke 条目（跑挂时会留下残留）
  const dataDir = join(tmpdir(), `ofs-smoke-${process.pid}`)
  app = spawn(exePath, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${dataDir}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
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
    // 在 Windows 上拿不到矩形，等于这条检查静默空过 —— 宁可红，不要假绿
    if (process.platform === 'win32') fail('Windows 上却拿不到 windowControlsOverlay 矩形，遮挡检查会空过')
    console.log('SKIP window controls overlay 不可用（非 Windows？）')
  } else {
    // 退化矩形（按钮区宽 0）会让下面的相交判断永远为假，检查从此永久假绿
    const w = overlay.controls.right - overlay.controls.left
    if (w < 60 || overlay.controls.bottom < 24) {
      fail(
        `原生按钮区矩形不可信：x ${overlay.controls.left}–${overlay.controls.right}（宽 ${w}）` +
          ` y 0–${overlay.controls.bottom}`
      )
    }
    if (!overlay.checkedDrawer) fail('没能打开连接编辑抽屉，遮挡检查没覆盖到它')
    if (overlay.hits.length > 0) {
      fail(`有 ${overlay.hits.length} 个可交互元素被原生窗口按钮遮挡：\n  ${overlay.hits.join('\n  ')}`)
    }
    const c = overlay.controls
    console.log(`OK 无元素落入原生窗口按钮区 (x ${c.left}–${c.right}, y 0–${c.bottom})`)
  }

  // 8) 走一遍真实表单保存连接
  //    此前所有用例都是直接调 conn:save 传一份手写的完整草稿，绕过了表单 ——
  //    于是"折叠面板没展开时表单少传字段、被主进程 zod 拒收"这种 bug 一路漏到了用户手上。
  //    这里刻意只填可见字段、不展开任何折叠面板，就是用户的真实操作路径。
  const formSave = await evaluate(`
    const setInput = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const openBtn = [...document.querySelectorAll('button[title]')].find(
      (b) => b.title === '新建连接' && b.className.includes('ant-btn')
    )
    if (!openBtn) return { error: '没找到新建连接按钮' }
    openBtn.click()
    await new Promise((r) => setTimeout(r, 1000))

    // 填的是能真连上的 fixture 服务器：这条连接接着要被双击用来验证界面能不能连上
    for (const [id, value] of [['name', 'form-smoke'], ['host', '127.0.0.1'],
                               ['port', '${sshPort}'], ['username', 'test'],
                               ['password', 'test123']]) {
      const el = document.getElementById(id)
      if (!el) return { error: '表单里找不到字段 ' + id }
      setInput(el, value)
    }
    await new Promise((r) => setTimeout(r, 300))

    const save = [...document.querySelectorAll('.ant-drawer-header button')].find(
      (b) => b.textContent.replace(/\\s/g, '') === '保存'
    )
    save.click()
    await new Promise((r) => setTimeout(r, 2000))

    const toasts = [...document.querySelectorAll('.ant-message-notice-content')].map((e) => e.innerText.trim())
    const { profiles } = await window.ofs.invoke('conn:list')
    const saved = profiles.find((p) => p.name === 'form-smoke')
    // 先不删：下一步要在树里双击它，验证界面真的能连上
    return {
      toasts,
      drawerStillOpen: Boolean(document.querySelector('.ant-drawer-open')),
      saved: saved
        ? {
            host: saved.host, port: saved.port, username: saved.username,
            charset: saved.terminal.charset, termType: saved.terminal.termType,
            keepaliveInterval: saved.options.keepaliveInterval,
            readyTimeout: saved.options.readyTimeout,
            hasRef: Boolean(saved.auth.passwordRef),
            leaked: JSON.stringify(saved).includes('form-pw'),
            proxy: saved.proxy ?? null
          }
        : null
    }
  `)
  if (formSave.error) fail(formSave.error)
  const bad = formSave.toasts.filter((t) => /失败|Error|error/.test(t))
  if (bad.length > 0) fail(`表单保存报错：${bad.join(' | ')}`)
  if (!formSave.saved) fail('表单保存后 conn:list 里找不到该连接')
  // 折叠面板里的字段必须带着默认值一起提交，而不是 undefined
  const s = formSave.saved
  if (!s.charset || !s.termType || !s.keepaliveInterval || !s.readyTimeout) {
    fail(`折叠面板内的字段未随表单提交：${JSON.stringify(s)}`)
  }
  if (!s.hasRef || s.leaked) fail('表单保存的凭据未走 Vault 引用')
  if (s.proxy) fail(`未配置代理却写入了 proxy：${JSON.stringify(s.proxy)}`)
  if (formSave.drawerStillOpen) fail('保存成功后抽屉未关闭')
  console.log(
    `OK 表单保存连接（未展开折叠面板）：charset=${s.charset} termType=${s.termType} ` +
      `keepalive=${s.keepaliveInterval} timeout=${s.readyTimeout}`
  )

  // 8.5) 在连接树里双击 —— 用户真正的连接姿势，确认界面真的能连上
  //    此前所有连接用例都直接调 IPC 看 session:state，那只证明**主进程**连上了；
  //    v0.1.1 就是这样发出去的：IPC 层全绿，而界面一直停在"正在连接"。
  //
  //    说明白这一步的边界：它只能保证"界面能连上"，**不是**那个竞态的护栏。
  //    根因是 session:state 事件（webContents.send）与 session:open 应答（invoke 回包）
  //    到达顺序没有保证，事件先到时渲染层按 sessionId 匹配落空。顺序无法在这里强制 ——
  //    实测同一个有 bug 的构建，这里能过、单独起一个实例就复现。
  //    竞态本身由 test/renderer/sessionStore.test.ts 钉住（那里能精确编排顺序）。
  //    autoReconnect 必须关掉：开着的话首连卡住后会掉线重连，重连的 ready 事件
  //    在 tab 已知 sessionId 之后到达，会把卡住的状态"修好"，这条判定就形同虚设
  //    （第一版就是这样在有 bug 的构建上照样通过的）。
  //    连接经 IPC 建好后 reload 一次窗口，让连接树从库里重新读 —— 之后才是纯界面操作。
  await evaluate(`
    await window.ofs.invoke('conn:save', {
      name: 'ui-smoke', groupId: null, host: '127.0.0.1', port: ${sshPort}, username: 'test',
      auth: { method: 'password', password: 'test123' },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      // monitorEnabled: true —— 下一步（8.55）要验"连上就自动打开监控"，而这个初值
      // 恰恰取自 profile.options.monitorEnabled。反向（false → 不开）由
      // test/renderer/sessionStore.test.ts 覆盖，那里两个方向都能精确摆出来。
      options: { keepaliveInterval: 15000, readyTimeout: 10000, legacyAlgorithms: false,
                 autoReconnect: false, monitorEnabled: true, compress: false }
    })
    return true
  `)
  await evaluate('location.reload(); return true').catch(() => {})
  await sleep(4000)

  const uiConnect = await evaluate(`
    // 判定要盯**直接反映 tab.state 的东西**：标签上的状态点 class 由 tab.state 决定
    // （dotReady / dotConnecting / dotClosed），CSS Modules 加了哈希后缀，故用包含匹配。
    //
    // 别拿"有没有 xterm 节点"当判据 —— TerminalPane 一挂载就建 xterm，
    // 连不上时它照样在，只是浮层盖在上面（这个坑踩过）。
    const ready = () => document.querySelectorAll('[class*=dotReady]').length
    const spinner = () => [...document.querySelectorAll('*')].some(
      (e) => e.children.length === 0 && /正在连接/.test(e.textContent || '')
    )
    if (typeof window.ofs !== 'object') return { error: 'reload 后 preload 桥没回来' }
    const before = ready()

    const title = [...document.querySelectorAll('.ant-tree-title')].find((n) =>
      n.textContent.includes('ui-smoke')
    )
    if (!title) return { error: 'reload 后连接树里找不到 ui-smoke' }
    // onDoubleClick 挂在 .ant-tree-title 里层的 span 上：事件只往上冒泡，
    // 派发到 .ant-tree-title 上 React 收不到
    const node = title.querySelector('span') || title
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))

    let sawSpinner = false
    for (let i = 0; i < 60; i++) {
      if (spinner()) sawSpinner = true
      if (ready() > before) break
      await new Promise((r) => setTimeout(r, 250))
    }
    return {
      就绪标签: ready() - before,
      浮层还在: spinner(),
      曾出现浮层: sawSpinner,
      终端节点: document.querySelectorAll('.xterm-screen').length
    }
  `)
  if (uiConnect.error) fail(uiConnect.error)
  if (uiConnect.就绪标签 < 1) {
    fail(
      '双击连接后标签始终没变成"已连接"' +
        (uiConnect.终端节点 > 0 ? '（终端容器建了，但会话没 ready）' : '') +
        ' —— 主进程大概已连上而渲染层没收到 ready（session:state 按 sessionId 匹配落空）'
    )
  }
  if (uiConnect.浮层还在) fail('会话已就绪，"正在连接"浮层却还在')
  console.log(
    `OK 界面双击连接：标签变为已连接，"正在连接"浮层${uiConnect.曾出现浮层 ? '出现过并已消失' : '未出现'}`
  )

  // 8.55) 连上就自动打开 SFTP 与监控
  //    两个初值来自**两处**，各自都能单独失效，所以分别断言：
  //      SFTP  ← 全局设置 sftp.autoOpenOnConnect（useSessionStore.openForProfile 读）
  //      监控  ← 连接自己的 profile.options.monitorEnabled（复活的死字段）
  //    "自动"的关键是**没有点任何按钮** —— 这一步不许出现 click。
  //    面板标记不用 [class*=panel]（MainLayout 的 .panels 也命中），改认监控头部那行标题；
  //    SFTP 认面包屑条（只有 SftpPane 有）。
  const autoOpen = await evaluate(`
    const sftpOpen = () => Boolean(document.querySelector('[class*=breadcrumbBar]'))
    const monitorOpen = () =>
      [...document.querySelectorAll('[class*=header]')].some((n) =>
        n.textContent.trim().startsWith('服务器监控')
      )
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (sftpOpen() && monitorOpen() && document.querySelector('.ant-table')) break
    }
    return {
      SFTP已展开: sftpOpen(),
      监控已展开: monitorOpen(),
      有文件表格: Boolean(document.querySelector('.ant-table')),
      仍然ready: document.querySelectorAll('[class*=dotReady]').length > 0
    }
  `)
  if (!autoOpen.SFTP已展开) {
    fail('连上后 SFTP 分屏没有自动展开（sftp.autoOpenOnConnect 没被 openForProfile 读到？）')
  }
  if (!autoOpen.有文件表格) fail('SFTP 分屏展开了却没渲染出文件表格')
  if (!autoOpen.监控已展开) {
    fail('连上后监控面板没有自动展开（profile.options.monitorEnabled 没被 openForProfile 读到？）')
  }
  if (!autoOpen.仍然ready) fail('自动展开两个面板后会话掉出了 ready')
  console.log('OK 连上即自动展开 SFTP 与监控（未点击任何按钮）')

  // 8.56) 监控面板里的连接数卡片。fixture 的 sockstat 是 TCP 12+4 / UDP 6+1 / tw 3，
  //    所以 TCP 总数必须是 16 —— 这一条同时证明了 v4+v6 相加与 SOCK 段真的被采到了
  //    （段名只能是大写字母，写成 SOCK_1 之类会被 splitSections 静默并进上一段）。
  //    按状态的明细只在每 5 tick 的那一帧才有，冒烟不等它，由 test/integration/monitor.test.ts 覆盖。
  const connCard = await evaluate(`
    const cardOf = (title) =>
      [...document.querySelectorAll('[class*=cardHead]')]
        .find((h) => h.textContent.trim().startsWith(title))
        ?.parentElement || null
    let card = null
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250))
      card = cardOf('连接数')
      if (card && /\\d/.test(card.textContent)) break
    }
    if (!card) return { error: '监控面板里没有"连接数"卡片' }
    // 逐个元素取值，不要整卡 textContent —— 相邻数字会粘成 "33716"，
    // 拿正则从里面找 16 是自找麻烦（第一版就是这么误报的）
    const big = card.querySelector('[class*=bigNumber]')
    const rows = [...card.querySelectorAll('[class*=kvRow]')].map((r) => {
      const cells = [...r.children].map((c) => c.textContent.trim())
      return cells.join('=')
    })
    return {
      tcp: big ? big.textContent.replace(/[^0-9]/g, '') : '',
      unit: big ? big.textContent.replace(/[0-9]/g, '').trim() : '',
      rows,
      text: card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120)
    }
  `)
  if (connCard.error) fail(connCard.error)
  if (connCard.tcp !== '16' || connCard.unit !== 'TCP') {
    fail(
      `连接数卡片的大数字应为 16 TCP（fixture 是 v4 12 + v6 4，证明两份 sockstat 都被采到并相加），` +
        `实际 "${connCard.tcp}" / "${connCard.unit}"，整卡文本："${connCard.text}"`
    )
  }
  const rowText = connCard.rows.join(' | ')
  if (!/TIME_WAIT=3/.test(rowText)) fail(`连接数卡片的 TIME_WAIT 应为 3，实际行：${rowText}`)
  if (!/UDP[^=]*=7/.test(rowText)) fail(`连接数卡片的 UDP 套接字应为 7（6+1），实际行：${rowText}`)
  console.log(`OK 监控连接数卡片：TCP ${connCard.tcp} / ${rowText}`)

  // 关掉监控面板，把主区域还成整宽 —— 下一步的 tooltip 遮挡检查要求悬浮工具条
  // 真的处在原生窗口按钮的水平范围内，监控面板占着右侧 14–40% 时它并不在，
  // 那条检查就会静默失去约束力（8.6 里有专门的反空转断言会把这件事挑明）。
  const monitorClosed = await evaluate(`
    const head = [...document.querySelectorAll('[class*=header]')].find((n) =>
      n.textContent.trim().startsWith('服务器监控')
    )
    if (!head) return { error: '找不到监控面板头部' }
    const btns = [...head.querySelectorAll('button')]
    if (btns.length === 0) return { error: '监控面板头部没有按钮' }
    btns[btns.length - 1].click()   // 最后一个是关闭
    await new Promise((r) => setTimeout(r, 900))
    return {
      监控已关闭: ![...document.querySelectorAll('[class*=header]')].some((n) =>
        n.textContent.trim().startsWith('服务器监控')
      ),
      仍然ready: document.querySelectorAll('[class*=dotReady]').length > 0
    }
  `)
  if (monitorClosed.error) fail(monitorClosed.error)
  if (!monitorClosed.监控已关闭) fail('点了监控面板的关闭按钮，面板却还在')
  if (!monitorClosed.仍然ready) fail('关掉监控面板后会话掉出了 ready')

  // 8.6) 顶部悬浮工具条的 tooltip 会不会被原生窗口按钮切掉
  //    step 7 扫的是"元素自己的矩形"，扫不到 tooltip，两个独立原因：① 它从不 hover，而 antd 的
  //    气泡是 hover 才挂到 body 的 portal，扫描那一刻 DOM 里没有它；② 就算挂着，气泡是
  //    div.ant-tooltip-inner，不在 step 7 的选择器名单里。于是"工具条贴在标题栏下方 +
  //    Tooltip 默认 placement=top"把气泡送进了原生按钮区 —— 用户看到的「打开文件管理」只剩「打开」。
  //
  //    这一步只覆盖终端悬浮工具条与查找条。监控面板头部的重试按钮同样在危险区，
  //    但它只在采集失败时才出现，冒烟里造不稳定，故不纳入 —— 不假装覆盖了。
  const tipEnv = await evaluate(`
    const wco = navigator.windowControlsOverlay
    if (!wco || !wco.visible) return { skipped: true }
    const bar = wco.getTitlebarAreaRect()
    // 原生按钮区 = 标题栏整条 减去 可用标题栏区。Windows 在右、macOS 在左，都不硬编码尺寸
    const controls =
      bar.x > 0
        ? { left: 0, right: Math.round(bar.x), bottom: Math.round(bar.height) }
        : { left: Math.round(bar.x + bar.width), right: window.innerWidth, bottom: Math.round(bar.height) }

    const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim()
    const api = { controls }
    window.__ofsTip = api

    // 只认"可见"气泡：rc-tooltip 是 removeOnLeave:false，关掉的气泡会留在 DOM 里带 -hidden 类，
    // 量到那种全零矩形永远不相交 —— 正是这条检查最容易被静默架空的地方
    api.visibleTips = () =>
      [...document.querySelectorAll('.ant-tooltip')].filter(
        (n) => !String(n.className).includes('-hidden') && n.getBoundingClientRect().width > 1
      )

    api.triggers = (kind) => {
      let root = null
      if (kind === 'hoverTools') root = document.querySelector('[class*=hoverTools]')
      // 查找条与"正在连接/已断开"浮层的 CSS Module 类名都叫 overlay，靠"里面有 input"区分
      else root = [...document.querySelectorAll('[class*=overlay]')].find((n) => n.querySelector('input'))
      if (!root) return null
      return [...root.querySelectorAll('button')].map((el) => {
        const r = el.getBoundingClientRect()
        return {
          cx: Math.round(r.left + r.width / 2),
          cy: Math.round(r.top + r.height / 2),
          // rc-tooltip 把这个 id 同时放在触发器的 aria-describedby 与气泡的 .ant-tooltip-inner 上，
          // 是精确的一对一。不靠"当前可见的第一个气泡" —— 上一颗还在淡出时会被认成这一颗，
          // 实测就是这样量出了两次「打开文件管理」
          id: el.getAttribute('aria-describedby') || ''
        }
      })
    }

    // React 18 的 id 形如 ":r7:"，只能 getElementById（querySelector('#:r7:') 会抛）
    api.tipOf = (id) => (id ? document.getElementById(id) : null)

    api.measure = async (id) => {
      for (let i = 0; i < 32; i++) {
        await new Promise((r) => setTimeout(r, 25))
        const inner = api.tipOf(id)
        if (!inner) continue
        const root = inner.closest('.ant-tooltip') || inner
        // 关掉的气泡留在 DOM 里（removeOnLeave:false + -hidden），量它永远不相交
        if (String(root.className).includes('-hidden')) continue
        const r = inner.getBoundingClientRect()
        // 对齐算完之前 rc-trigger 把气泡摆在 left:-1000vw，那一帧量到的是天外飞仙
        if (r.width < 1 || r.left < -500) continue
        const c = api.controls
        const ox = Math.min(r.right, c.right) - Math.max(r.left, c.left)
        const oy = Math.min(r.bottom, c.bottom) - Math.max(r.top, 0)
        return {
          text: clean(inner.textContent).slice(0, 30),
          placement: (String(root.className).match(/placement-([A-Za-z]+)/) || ['', '?'])[1],
          rect: {
            top: Math.round(r.top),
            left: Math.round(r.left),
            right: Math.round(r.right),
            bottom: Math.round(r.bottom)
          },
          covered: ox > 0 && oy > 0 ? Math.round(ox) : 0
        }
      }
      return null
    }

    /** 等这一颗气泡谢幕；返回此刻仍可见的气泡数（一直攒着说明取消 hover 没生效） */
    api.waitGone = async (id) => {
      for (let i = 0; i < 40; i++) {
        const inner = api.tipOf(id)
        const root = inner && (inner.closest('.ant-tooltip') || inner)
        if (!inner || String(root.className).includes('-hidden') || inner.getBoundingClientRect().width < 1) break
        await new Promise((r) => setTimeout(r, 25))
      }
      return api.visibleTips().length
    }

    // 停车点：hover 完把鼠标移到这里。落在终端里，既没有 tooltip 触发器，
    // 又能让 .pane:hover 保持成立（工具条不会闪回 opacity:0）
    const screen = document.querySelector('.xterm-screen')
    api.park = screen
      ? (() => {
          const r = screen.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.7) }
        })()
      : null
    return { controls, park: api.park, innerWidth: window.innerWidth }
  `)

  if (tipEnv.skipped) {
    // 在 Windows 上拿不到矩形，等于这条检查静默空过 —— 宁可红，不要假绿
    if (process.platform === 'win32') fail('Windows 上却拿不到 windowControlsOverlay 矩形，tooltip 遮挡检查会空过')
    console.log('SKIP tooltip 遮挡检查（windowControlsOverlay 不可用，非 Windows？）')
  } else {
    const cr = tipEnv.controls
    const crW = cr.right - cr.left
    // 退化矩形（宽 0）会让"相交"永远为假，检查从此永久假绿 —— 必须当场报错
    if (crW < 60 || cr.bottom < 24) {
      fail(`原生按钮区矩形不可信：x ${cr.left}–${cr.right}（宽 ${crW}）y 0–${cr.bottom}，innerWidth=${tipEnv.innerWidth}`)
    }
    if (!tipEnv.park) fail('找不到 .xterm-screen 作停车点，无法在候选之间取消 hover')

    // 用 CDP 注入真实鼠标移动，而不是 dispatchEvent(new MouseEvent('mouseover'))：
    // 真实注入会走 Chromium 的命中测试与 :hover —— .hoverTools 平时是 opacity:0 靠
    // .pane:hover 显形，被浮层压住的按钮也本该 hover 不到。合成事件会"hover"到用户
    // 其实点不到的元素，把结论做假。
    const moveTo = (x, y) =>
      send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 })

    const sweepTips = async (label, kind, expected) => {
      const pts = await evaluate(`return window.__ofsTip.triggers(${JSON.stringify(kind)})`)
      if (!pts || pts.length === 0) fail(`${label}：找不到工具条容器或里面没有按钮 —— 这一轮在空转`)
      const measured = []
      let leftover = 0
      for (const p of pts) {
        if (!p.id) continue // 没挂 Tooltip 的按钮（如查找条的关闭）直接跳过，不白等
        await moveTo(p.cx, p.cy)
        const m = await evaluate(`return await window.__ofsTip.measure(${JSON.stringify(p.id)})`)
        if (m) measured.push(m)
        await moveTo(tipEnv.park.x, tipEnv.park.y)
        leftover = Math.max(leftover, await evaluate(`return await window.__ofsTip.waitGone(${JSON.stringify(p.id)})`))
      }
      if (measured.length === 0) fail(`${label}：一个 tooltip 都没量到（候选 ${pts.length} 个）—— 这一轮在空转`)
      if (leftover > 1) fail(`${label}：气泡在累积（同时可见 ${leftover} 颗）—— 取消 hover 没生效，量到的可能是上一颗`)
      // 反空转：预期的气泡必须真的量到过。否则"什么都没测到"会伪装成"没问题"
      const texts = measured.map((m) => m.text)
      const missing = expected.filter((e) => !texts.includes(e))
      if (missing.length > 0) {
        fail(
          `${label}：没量到 tooltip「${missing.join('」「')}」（实际量到：${texts.join(' / ') || '一个都没有'}）` +
            ' —— hover 没生效或按钮被压住，这一轮的结论不可信'
        )
      }
      // 反空转（第二种）：气泡必须真的落在原生按钮区的**水平**范围内。
      // 否则纵向怎么摆都不可能相交，covered 恒为 0 —— 这条检查还在跑，但已经不约束任何东西。
      // 自动打开监控面板时就是这样：主区域被压到窗口 60–86%，工具条根本不在按钮区下方，
      // 于是把 placement 改回 top 也照样全绿。所以让它当场红，而不是无声地变成装饰。
      const inXRange = measured.filter((m) => m.rect.right > cr.left && m.rect.left < cr.right)
      if (inXRange.length === 0) {
        fail(
          `${label}：量到的 ${measured.length} 个气泡没有一个落在原生按钮区的水平范围内` +
            `（按钮区 x ${cr.left}–${cr.right}，气泡 x ${measured
              .map((m) => `${m.rect.left}–${m.rect.right}`)
              .join(' / ')}）` +
            ' —— 这一轮的遮挡检查没有约束力，请确认工具条确实贴在窗口右上角'
        )
      }

      const hits = measured.filter((m) => m.covered > 0)
      if (hits.length > 0) {
        fail(
          `${label}：${hits.length} 个 tooltip 落进原生窗口按钮区：\n  ` +
            hits
              .map(
                (h) =>
                  `「${h.text}」placement=${h.placement} 气泡 x ${h.rect.left}–${h.rect.right} ` +
                  `y ${h.rect.top}–${h.rect.bottom}，右侧 ${h.covered}px 被系统按钮压住`
              )
              .join('\n  ')
        )
      }
      return measured.length
    }

    // 前两个标签随面板开关状态变化，此刻的状态由 8.55 钉住：
    // SFTP 自动展开着（所以是"关闭文件管理"），监控刚被 8.55 关掉（所以是"打开服务器监控"）。
    const n1 = await sweepTips('终端悬浮工具条', 'hoverTools', [
      '关闭文件管理',
      '打开服务器监控',
      '查找',
      '清屏',
      '断开连接'
    ])

    // 查找条贴同一条边，且 z-index 10 会盖住工具条的 8 —— 必须排在工具条之后扫
    const searchOpen = await evaluate(`
      const btns = [...document.querySelectorAll('[class*=hoverTools] button')]
      if (btns.length < 3) return false
      btns[2].click()
      await new Promise((r) => setTimeout(r, 600))
      return Boolean([...document.querySelectorAll('input')].find((x) => String(x.placeholder || '').startsWith('查找内容')))
    `)
    if (!searchOpen) fail('点不开终端查找条 —— tooltip 遮挡检查漏掉了这块布局')
    const n2 = await sweepTips('终端查找条', 'search', ['上一个', '下一个', '区分大小写', '正则表达式'])

    await evaluate(`
      const inp = [...document.querySelectorAll('input')].find((x) => String(x.placeholder || '').startsWith('查找内容'))
      if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      return true
    `)
    console.log(
      `OK 顶部 tooltip 全部落在原生按钮区外（工具条 ${n1} 个 + 查找条 ${n2} 个，` +
        `按钮区 x ${cr.left}–${cr.right} y 0–${cr.bottom}）`
    )
  }

  // 8.7) 开 SFTP 分屏不能把会话搞死
  //    SessionView 早先写成 `sftpOpen ? <PanelGroup>…<TerminalPane/></PanelGroup> : <TerminalPane/>`，
  //    开关 SFTP 时该位置的元素类型变化 → React 卸载重建整棵子树 → TerminalPane 的清理逻辑
  //    invoke('term:close') 把 shell 关了 → main 回 term:exit(closed) → tab 变 closed →
  //    SftpPane 看到 state!=='ready' 就显示"等待会话"，一个文件都拉不到。
  //    判定用"tab 还是不是 ready"而不是"有没有列出文件"：后者受 RTT 影响（本地 readdir 够快时
  //    会在 term:exit 之前把文件填上，看着像好的），前者与延迟无关，必中。
  //
  //    自 SFTP 自动打开之后，这一步走的是"先关再开"的往返：元素类型变化在两个方向上都会发生，
  //    所以关那一下就足以踩中回归；开回来则保证结束状态与后续步骤一致。
  const sftpToggle = await evaluate(`
    const ready = () => document.querySelectorAll('[class*=dotReady]').length
    const sftpOpen = () => Boolean(document.querySelector('[class*=breadcrumbBar]'))
    if (ready() === 0) return { error: '开关 SFTP 之前 tab 就不是 ready' }
    if (!sftpOpen()) return { error: 'SFTP 本该已自动展开（见上一步），这里却是关着的' }
    const toggle = () => {
      const btns = [...document.querySelectorAll('[class*=hoverTools] button')]
      if (btns.length === 0) return false
      btns[0].click()   // 第一个是"打开/关闭文件管理"
      return true
    }

    let lostReady = false
    const watch = async (until, tries) => {
      for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, 250))
        if (ready() === 0) lostReady = true
        if (until()) break
      }
    }

    if (!toggle()) return { error: '找不到悬浮工具条按钮（第一个是打开文件管理）' }
    await watch(() => !sftpOpen(), 20)
    const 关掉了 = !sftpOpen()

    if (!toggle()) return { error: '第二次点不到悬浮工具条按钮' }
    await watch(() => sftpOpen() && Boolean(document.querySelector('.ant-table')), 40)
    await new Promise((r) => setTimeout(r, 1500))

    const body = document.body.innerText
    return {
      关掉了,
      仍然ready: ready() > 0,
      中途掉出ready: lostReady,
      出现会话已结束: /会话已结束|已断开/.test(body),
      等待会话: /等待会话/.test(body),
      有表格: Boolean(document.querySelector('.ant-table')),
      表格行数: document.querySelectorAll('.ant-table-row').length,
      xterm数: document.querySelectorAll('.xterm').length
    }
  `)
  if (sftpToggle.error) fail(sftpToggle.error)
  if (!sftpToggle.关掉了) fail('点了"关闭文件管理"，SFTP 分屏却还在')
  if (!sftpToggle.仍然ready || sftpToggle.中途掉出ready) {
    fail(
      '开 SFTP 分屏后会话掉出了 ready' +
        (sftpToggle.出现会话已结束 ? '（界面出现"会话已结束/已断开"）' : '') +
        ' —— TerminalPane 大概被重挂了，卸载时把 shell 关掉了'
    )
  }
  if (sftpToggle.等待会话) fail('SFTP 面板停在"等待会话"，没能列出文件')
  if (!sftpToggle.有表格) fail('SFTP 面板没渲染出文件表格')
  console.log(
    `OK 开 SFTP 分屏：会话保持 ready，文件表格 ${sftpToggle.表格行数} 行，xterm 仍为 ${sftpToggle.xterm数} 个`
  )

  // 8.75) 快速删除（rm -rf）：守卫真的随打包产物一起发了，且它在弹框之前就说话
  //    单测覆盖的是纯函数，接线护栏读的是源码文本 —— 两者都无法回答"装到用户机器上的那个
  //    二进制里，这道守卫还在不在"。而这条链路的失效后果是 rm -rf 打到 /etc 上，
  //    所以它值得在最外层再验一遍。
  //
  //    fixture 的 exec 只是面镜子（把收到的命令回显），没有真 shell 也没有真文件系统，
  //    所以这里**刻意不点确认** —— 能验的是"守卫拒得对、命令拼得对、菜单接得上"，
  //    `rm` 的真实语义归真机验收。
  const fdGuard = await evaluate(`
    const sid = '${session.sessionId}'
    const reject = async (p) => {
      try {
        await window.ofs.invoke('sftp:fastDeletePreview', { paths: [p] })
        return null
      } catch (e) {
        return String(e && e.message ? e.message : e)
      }
    }
    const 拒绝 = {
      根目录: await reject('/'),
      一级目录: await reject('/etc'),
      相对路径: await reject('data/x'),
      上跳: await reject('/a/../etc'),
      含换行: await reject('/data/a\\nb')
    }
    const 预览 = await window.ofs.invoke('sftp:fastDeletePreview', {
      paths: ['/data/foo', "/data/it's"]
    })
    return { 拒绝, command: 预览.command, count: 预览.count, batches: 预览.batches }
  `)
  for (const [label, msg] of Object.entries(fdGuard.拒绝)) {
    if (msg === null) fail(`快速删除守卫在打包产物里失效了：${label} 竟然被接受`)
  }
  if (!/层级过浅/.test(fdGuard.拒绝.根目录) || !/层级过浅/.test(fdGuard.拒绝.一级目录)) {
    fail(`拒的理由不是"层级过浅"，深度规则可能被别的检查抢先兜走了：${JSON.stringify(fdGuard.拒绝)}`)
  }
  // 期望值在这里**独立写一遍**（不从 main 抄）：转义错了才是这一片唯一致命的错
  const expectedHead = "rm -rf -- '/data/foo' '/data/it'\\''s'"
  if (!fdGuard.command.startsWith(expectedHead)) {
    fail(`命令首行的引号不对：\n期望以 ${expectedHead}\n开头，实际 ${JSON.stringify(fdGuard.command)}`)
  }
  if (!fdGuard.command.includes("printf 'OFSLEFT:%s\\n' \"$p\"")) {
    fail('命令里没有同条命令内的残留探测 —— "哪几条没删掉"就成了猜的')
  }
  if (!fdGuard.command.endsWith('(exit $__ofs_rm)')) {
    fail('命令末尾不是 (exit …)：裸 exit 会让 ExecRunner 的 RC 哨兵永远不执行')
  }
  console.log(`OK 快速删除守卫在打包产物里生效（拒 / 与 /etc），命令原文引号正确`)

  // 菜单接线：右键一个目录行，「删除」与「快速删除」必须是两个不同的条目；
  // 点「快速删除」时守卫先说话 —— 弹框一个都不许出来。
  const fdMenu = await evaluate(`
    const sid = '${session.sessionId}'
    await window.ofs.invoke('sftp:mkdir', { sessionId: sid, path: '/fd-smoke' })

    const openMenu = async (el) => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 5)
      }))
      await new Promise((r2) => setTimeout(r2, 400))
      return [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => ({
        text: e.textContent.trim(),
        disabled: e.className.includes('-disabled')
      }))
    }
    const closeMenu = async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r2) => setTimeout(r2, 250))
    }

    // 先在空白处右键，用菜单里的「刷新」把刚建的目录刷出来（顺带验证空白处右键真的出菜单）
    const body = document.querySelector('.ant-table-body') || document.querySelector('.ant-table')
    if (!body) return { error: '找不到 SFTP 文件表格' }
    const blankItems = await openMenu(body)
    if (blankItems.length === 0) return { error: '空白处右键没出菜单' }
    const refresh = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent.trim() === '刷新')
    if (!refresh) return { error: '菜单里没有「刷新」', blankItems }
    refresh.click()
    await new Promise((r2) => setTimeout(r2, 1200))

    const row = [...document.querySelectorAll('.ant-table-row')]
      .find((e) => e.innerText.includes('fd-smoke'))
    if (!row) return { error: '刷新后列表里没有 fd-smoke 这个目录', blankItems }

    const rowItems = await openMenu(row)
    const fast = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent.trim().startsWith('快速删除'))
    if (!fast) {
      await closeMenu()
      return { error: '右键目录行时菜单里没有「快速删除」', blankItems, rowItems }
    }
    if (fast.className.includes('-disabled')) {
      await closeMenu()
      return { error: '「快速删除」对一个目录行是灰的', blankItems, rowItems }
    }
    fast.click()
    await new Promise((r2) => setTimeout(r2, 900))

    const 出现弹框 = Boolean(document.querySelector('.ant-modal-confirm'))
    const 提示文字 = [...document.querySelectorAll('.ant-message-notice-content')]
      .map((e) => e.textContent.trim()).join(' | ')
    await closeMenu()
    await window.ofs.invoke('sftp:delete', { sessionId: sid, path: '/fd-smoke', recursive: true })
    return { blankItems, rowItems, 出现弹框, 提示文字 }
  `)
  if (fdMenu.error) fail(`${fdMenu.error}（菜单：${JSON.stringify(fdMenu.rowItems ?? fdMenu.blankItems)}）`)
  const labels = fdMenu.rowItems.map((i) => i.text)
  if (!labels.includes('删除')) fail(`菜单里没有普通「删除」：${labels.join(' / ')}`)
  if (labels.filter((t) => t.startsWith('快速删除')).length !== 1) {
    fail(`「快速删除」不是恰好一条：${labels.join(' / ')}`)
  }
  // `/fd-smoke` 只有一级，守卫必然拒 —— 拒的方式必须是"弹框之前就说话"
  if (fdMenu.出现弹框) {
    fail('层级不够的路径竟然弹出了确认框 —— 守卫跑在了用户点确认之后')
  }
  if (!/层级过浅/.test(fdMenu.提示文字)) {
    fail(`没看到守卫的提示（实际提示：${JSON.stringify(fdMenu.提示文字)}）`)
  }
  console.log(`OK 右键菜单：「删除」与「快速删除」并存，层级不够时守卫在弹框之前拒掉`)

  // 8.76) 打包传输：菜单里的勾选项真的写得进设置
  //    fixture 的 exec 只是面镜子（没有真 tar、没有真文件系统），所以**打包本身在它上面
  //    无法被验证** —— 硬要验就是测试文档自己警告过的循环论证。这里验的是接线：
  //    勾选项在菜单里、点它真的翻了那条全局设置、界面能看到勾。
  const packToggle = await evaluate(`
    const before = (await window.ofs.invoke('settings:get')).sftp.packedTransfer
    // 在**空白处**右键，不依赖表格里有没有行（上一步删掉的那条只是还没刷掉，
    // 拿它当锚点就等于让这一步依赖上一步的残留）
    const anchor = document.querySelector('.ant-table-body') || document.querySelector('.ant-table')
    if (!anchor) return { error: '找不到 SFTP 文件表格' }
    const openMenu = async () => {
      const r = anchor.getBoundingClientRect()
      anchor.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 5)
      }))
      await new Promise((r2) => setTimeout(r2, 400))
      return [...document.querySelectorAll('.ant-dropdown-menu-item')]
    }
    const find = (items) => items.find((e) => e.textContent.trim() === '打包传输')

    let items = await openMenu()
    const item = find(items)
    if (!item) {
      return { error: '菜单里没有「打包传输」', 菜单: items.map((e) => e.textContent.trim()) }
    }
    const 起初有勾 = Boolean(item.querySelector('.ant-dropdown-menu-item-icon, svg'))
    item.click()
    await new Promise((r2) => setTimeout(r2, 600))
    const after = (await window.ofs.invoke('settings:get')).sftp.packedTransfer

    // 再开一次菜单，看勾是否跟着变了
    items = await openMenu()
    const 之后有勾 = Boolean(find(items)?.querySelector('.ant-dropdown-menu-item-icon, svg'))
    find(items)?.click()
    await new Promise((r2) => setTimeout(r2, 600))
    const restored = (await window.ofs.invoke('settings:get')).sftp.packedTransfer
    return { before, after, restored, 起初有勾, 之后有勾 }
  `)
  if (packToggle.error) fail(`${packToggle.error}（${JSON.stringify(packToggle.菜单 ?? '')}）`)
  if (packToggle.before !== false) fail(`打包传输的默认值该是 false，实际 ${packToggle.before}`)
  if (packToggle.after !== true) fail('点了「打包传输」但设置没变 —— 勾选项没接上 patchSettings')
  if (packToggle.restored !== false) fail('再点一次没还原回去')
  if (packToggle.起初有勾) fail('默认关，菜单里却已经打了勾')
  if (!packToggle.之后有勾) fail('设置已经翻成 true，菜单里却看不到勾')
  console.log('OK 打包传输勾选项：默认关、点一次写进设置、勾随之出现')

  // 9) 设置 → 安全与数据：导出/导入面板能渲染出来且不被原生窗口按钮压住
  //    导入/导出都要弹系统文件对话框，CDP 关不掉它 —— 所以这里只验证到"面板可用"为止，
  //    真正的导入语义（冲突策略、凭据归属、指纹不被覆盖）由 test/unit/importData.test.ts 覆盖。
  const settingsPanel = await evaluate(`
    const btns = [...document.querySelectorAll('nav[class*=activityBar] button')]
    const gear = btns[btns.length - 1]
    if (!gear) return { error: '没找到设置按钮' }
    gear.click()
    await new Promise((r) => setTimeout(r, 900))
    // 关掉的 antd Modal 仍留在 DOM 里且 wrap 未必是 display:none（前面 hostkey 确认弹窗就是一个），
    // 所以不按"第一个/可见的弹窗"找，直接按内容认人
    const section = (m) =>
      [...m.querySelectorAll('.ant-menu-item')].find((e) => e.textContent.trim() === '安全与数据')
    const modal = [...document.querySelectorAll('.ant-modal-content')].find(section)
    if (!modal) return { error: '没找到设置弹窗（或它里面没有"安全与数据"分区）' }
    section(modal).click()
    await new Promise((r) => setTimeout(r, 700))

    const text = (e) => e.textContent.replace(/\\s/g, '')
    const buttons = [...modal.querySelectorAll('button')].map(text)

    // 原生窗口按钮区遮挡检查（设置弹窗是居中的，理论上不该撞上，但改布局时容易踩）
    const wco = navigator.windowControlsOverlay
    let hits = []
    let rectBad = ''
    if (wco && wco.visible) {
      const bar = wco.getTitlebarAreaRect()
      // 退化矩形（按钮区宽 0）会让下面的相交判断永远为假 —— 那样这条检查是假绿
      if (window.innerWidth - bar.width < 60 || bar.height < 24) {
        rectBad = '可用标题栏宽 ' + Math.round(bar.width) + ' / 视口 ' + window.innerWidth + '，高 ' + Math.round(bar.height)
      }
      for (const el of modal.querySelectorAll('button, input, .ant-menu-item')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.top < bar.height && r.right > bar.width) hits.push(text(el).slice(0, 30))
      }
    }

    const close = modal.querySelector('.ant-modal-close')
    if (close) close.click()
    await new Promise((r) => setTimeout(r, 400))
    return { buttons, hits, rectBad, crashed: modal.innerText.includes('该面板出现异常') }
  `)
  if (settingsPanel.error) fail(settingsPanel.error)
  if (settingsPanel.rectBad) fail(`原生按钮区矩形不可信，设置弹窗的遮挡检查会假绿：${settingsPanel.rectBad}`)
  if (settingsPanel.crashed) fail('安全与数据面板渲染崩溃（ErrorBoundary 兜住了）')
  for (const label of ['导出…', '选择文件导入…']) {
    if (!settingsPanel.buttons.includes(label)) {
      fail(`安全与数据面板里找不到「${label}」按钮，实际有：${settingsPanel.buttons.join(' / ')}`)
    }
  }
  if (settingsPanel.hits.length > 0) {
    fail(`设置弹窗里有元素被原生窗口按钮遮挡：${settingsPanel.hits.join(', ')}`)
  }
  console.log('OK 设置 → 安全与数据：导出/导入面板可用')

  // 选文件那步会弹系统对话框（CDP 关不掉），但用一个假 token 打一次 app:importData
  // 就足以证明整条通路是活的：channel 已注册、zod 放行了这份 payload、请求进到了服务里。
  const importWiring = await evaluate(`
    try {
      await window.ofs.invoke('app:importData', {
        token: 'definitely-not-a-real-token',
        conflict: 'skip',
        include: { profiles: true, snippets: true, forwards: true, knownHosts: true, settings: false }
      })
      return { error: '假 token 竟然导入成功了' }
    } catch (err) {
      return { message: String(err && err.message ? err.message : err) }
    }
  `)
  if (importWiring.error) fail(importWiring.error)
  if (!/会话已失效/.test(importWiring.message)) {
    fail(`app:importData 通路不对，期望"导入会话已失效"，实际：${importWiring.message}`)
  }
  console.log('OK app:importData 通路正常（假 token 被服务层拒绝，而非卡在校验或未注册）')

  // 10) 清理
  await evaluate(`
    await window.ofs.invoke('monitor:stop', '${session.sessionId}')
    await window.ofs.invoke('session:close', '${session.sessionId}')
    await window.ofs.invoke('conn:delete', '${profile.id}')
    // 表单建的那条留到最后删（前面双击连接要用它）
    const { profiles } = await window.ofs.invoke('conn:list')
    for (const p of profiles.filter((x) => x.name === 'form-smoke' || x.name === 'ui-smoke')) {
      await window.ofs.invoke('conn:delete', p.id)
    }
    return true
  `)
  console.log('OK cleanup done')
  console.log('ALL PASS')
  cleanup()
  process.exit(0)
}

main().catch((err) => fail(err.message))
