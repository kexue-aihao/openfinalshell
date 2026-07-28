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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
/** 渲染进程 console 的全部输出（Runtime.consoleAPICalled），供各步骤事后核查 */
const consoleLog = []

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
      return
    }
    /*
     * 收集渲染进程的 console。
     *
     * 有一整类问题只在这里现形：CodeMirror 对认不出来的高亮标签打 console.warn，
     * 而那意味着"这一类词在编辑器里永远没有颜色"—— 界面看着能用、构建全绿、
     * 类型检查也过。不收集的话，这个信号在打包产物里就彻底看不见了。
     */
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? '')
        .join(' ')
        .slice(0, 300)
      consoleLog.push({ level: msg.params.type, text })
    }
  })
  await send('Runtime.enable')

  // ---- 通用输入助手（编辑器与命令历史两步共用；放这里是因为 const 有 TDZ，
  //      定义必须排在两个使用点之前）----
  /**
   * 按一个**功能键或组合键**（Ctrl+S、Backspace、End…）。
   * 用 rawKeyDown 是因为它只走按键处理、不产生文本输入 —— 快捷键要的正是这个。
   */
  const press = async (key, code, vk, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        modifiers,
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk
      })
    }
  }
  /**
   * 敲一个**字符**。这里必须用 `keyDown` 并带上 `text`，不能用 `rawKeyDown` ——
   * 后者不产生文本输入，字符压根不会进文档。（第一版就是拿 press 去敲 'x'，
   * 报的是"编辑器卡在组词态"，而真实产物一切正常。这类"测法造出来的红"
   * 和真 bug 长得一模一样，与 Ctrl+F 那次合成 KeyboardEvent 是同一个坑的另一面：
   * **快捷键要 rawKeyDown，打字要 keyDown+text**。）
   */
  const typeChar = async (ch, code, vk) => {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ch,
      code,
      text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ch,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk
    })
  }

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

  /*
   * 8.57) 命令历史：真窗口里走完"在终端里敲一条 → 浮层里点回来"整条链路。
   *
   * 这一步回答的是几个**只有真 xterm 能回答**的问题 —— 单测那侧喂的是一个假缓冲，
   * 它能验切法，验不了"接线接对了没有"：
   *
   *  - 采集读的是真实缓冲：真提示符（fixture 打的是 `test@fixture:~$ `）、真回显、
   *    真光标列，promptCol 那条路在真 xterm 上到底成不成立；
   *  - 回车的 keydown 确实在 shell 处理之前跑到我们的 handler（顺序反了就永远采到上一条）；
   *  - 点一条历史**只回填、不执行**。判据是"**没有**出现新的提示符" ——
   *    fixture 每执行一条命令必然重打一次提示符，所以这条判据不依赖任何解析；
   *  - 设置里那个开关真的关得掉记录；
   *  - 「清空列表」这条 UI 路径真的清得掉。
   */
  const HIST_CMD = 'echo mark-9137'
  /**
   * 敲一串 ASCII。必须 keyDown+text（rawKeyDown 不产生文本输入，见 typeChar 的注释）。
   *
   * ⚠️ **虚拟键码不能拿字符码顶替**。第一版把 `-` 的 vk 写成 `'-'.charCodeAt(0)` = 45，
   * 而 45 是 **VK_INSERT** —— xterm 按键码判断这是 Insert 键，于是那个字符压根没发出去，
   * shell 收到的是 `echo mark9137`。报出来的错却是"命令没进历史（采集没成立）"，
   * 指着一个完全没问题的地方。标点必须查表：`-` 是 VK_OEM_MINUS(189)。
   */
  const VK = { ' ': 32, '-': 189, '.': 190, '/': 191, '=': 187 }
  const typeAscii = async (text) => {
    for (const ch of text) {
      const code = /[a-z]/i.test(ch)
        ? `Key${ch.toUpperCase()}`
        : /[0-9]/.test(ch)
          ? `Digit${ch}`
          : ch === ' '
            ? 'Space'
            : ch === '-'
              ? 'Minus'
              : ''
      const vk = VK[ch] ?? ch.toUpperCase().charCodeAt(0)
      await typeChar(ch, code, vk)
      await sleep(15)
    }
  }

  const histPrep = await evaluate(`
    await window.ofs.invoke('history:clear')
    await window.ofs.invoke('settings:set', { terminal: { saveCommandHistory: true } })
    const tas = [...document.querySelectorAll('.xterm-helper-textarea')]
    if (tas.length === 0) {
      return {
        error:
          '界面上没有终端（.xterm-helper-textarea），命令历史无从验证。现场：' +
          JSON.stringify({
            xterm: document.querySelectorAll('.xterm').length,
            screen: document.querySelectorAll('.xterm-screen').length,
            textarea: document.querySelectorAll('textarea').length,
            标签: [...document.querySelectorAll('.ant-tabs-tab')].map((e) => e.textContent.trim()),
            欢迎页: Boolean(document.body.innerText.includes('快速连接')),
            弹窗: document.querySelectorAll('.ant-modal').length
          })
      }
    }
    /*
     * 可能有多个终端（前面几步建过几条会话）。要挑**活动 tab 里那个** ——
     * 非活动 tab 的 xterm 仍然挂在 DOM 上（SessionViewHost 是全部常驻叠放的），
     * 往那个里面敲键，字会进另一条会话，而断言看的是历史库，
     * 于是失败信息会指向"采集坏了"，其实是敲错了终端。
     */
    const visible = tas.find((ta) => {
      const view = ta.closest('[class*="viewActive"]') ?? ta.closest('div')
      return ta.getBoundingClientRect().width > 0 && view
    })
    const ta = visible ?? tas[tas.length - 1]
    ta.focus()
    return { focused: document.activeElement === ta, 终端数: tas.length }
  `)
  if (histPrep.error) fail(histPrep.error)
  if (!histPrep.focused) fail('终端没拿到焦点，敲进去的键不会经过 xterm')

  await typeAscii(HIST_CMD)
  await press('Enter', 'Enter', 13)
  await sleep(900)

  const recorded = await evaluate(`
    const list = await window.ofs.invoke('history:list')
    return { list: list.map((e) => e.command), first: list[0] }
  `)
  if (recorded.error) fail(recorded.error)
  if (!recorded.list.includes(HIST_CMD)) {
    fail(
      `真终端里敲的命令没进历史（采集在真 xterm 上没成立）。库里现有：${JSON.stringify(recorded.list)}`
    )
  }
  console.log(`OK 命令历史采集：真终端敲「${HIST_CMD}」→ 已记录（用过 ${recorded.first.useCount} 次）`)

  // Ctrl+Shift+H 浮出列表
  await press('H', 'KeyH', 72, 10) // modifiers: Ctrl(2) | Shift(8)
  await sleep(500)
  const histOverlay = await evaluate(`
    const input = document.querySelector('input[placeholder="过滤命令…"]')
    if (!input) return { error: 'Ctrl+Shift+H 没打开命令历史浮层（找不到过滤框）' }
    const box = input.closest('div')
    const rows = [...document.querySelectorAll('[data-row]')].map((e) => e.textContent.trim())
    // 原生窗口按钮区遮挡：浮层贴着底边，理论上撞不上，但改布局时容易踩
    const wco = navigator.windowControlsOverlay
    let hits = []
    if (wco && wco.visible) {
      const bar = wco.getTitlebarAreaRect()
      for (const el of box.querySelectorAll('button, input, [data-row]')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.top < bar.height && r.right > bar.width) hits.push(el.textContent.trim().slice(0, 20))
      }
    }
    return { rows, hits }
  `)
  if (histOverlay.error) fail(histOverlay.error)
  if (!histOverlay.rows.includes(HIST_CMD)) {
    fail(`浮层里没有刚敲的那条命令，列出来的是：${JSON.stringify(histOverlay.rows)}`)
  }
  if (histOverlay.hits.length > 0) {
    fail(`命令历史浮层里有元素被原生窗口按钮遮挡：${histOverlay.hits.join(', ')}`)
  }
  console.log(`OK 命令历史浮层：Ctrl+Shift+H 打开，列出 ${histOverlay.rows.length} 条`)

  // 点一条 → 只回填。判据：命令回显了，但**没有新的提示符**（执行必然重打提示符）
  const refill = await evaluate(`
    window.__histData = ''
    window.__histOff = window.ofs.on('term:data', ({ data }) => {
      window.__histData += new TextDecoder().decode(data)
    })
    const row = [...document.querySelectorAll('[data-row]')].find(
      (e) => e.textContent.trim() === ${JSON.stringify(HIST_CMD)}
    )
    if (!row) return { error: '浮层里那一行不见了' }
    row.click()
    await new Promise((r) => setTimeout(r, 900))
    window.__histOff()
    return {
      tail: window.__histData,
      浮层还开着: Boolean(document.querySelector('input[placeholder="过滤命令…"]'))
    }
  `)
  if (refill.error) fail(refill.error)
  if (!refill.tail.includes('mark-9137')) {
    fail(`点了历史但命令没回填到命令行，终端这段时间收到的是：${JSON.stringify(refill.tail)}`)
  }
  if (/test@fixture:~\$/.test(refill.tail)) {
    fail(
      `点一条历史竟然执行了它 —— 终端打出了新的提示符：${JSON.stringify(refill.tail.slice(-120))}`
    )
  }
  if (refill.浮层还开着) fail('回填之后浮层没有收起')
  console.log('OK 点历史只回填不执行（回显到了命令行，且没有新提示符）')

  // Ctrl+C 收拾掉命令行上那条，免得干扰下一段的输入
  await press('c', 'KeyC', 67, 2)
  await sleep(400)

  // 开关关掉之后不再记新的
  await evaluate(`
    await window.ofs.invoke('settings:set', { terminal: { saveCommandHistory: false } })
    document.querySelector('.xterm-helper-textarea')?.focus()
    return true
  `)
  await typeAscii('echo off-9137')
  await press('Enter', 'Enter', 13)
  await sleep(900)
  const gated = await evaluate(`
    const list = await window.ofs.invoke('history:list')
    await window.ofs.invoke('settings:set', { terminal: { saveCommandHistory: true } })
    return { list: list.map((e) => e.command) }
  `)
  if (gated.error) fail(gated.error)
  if (gated.list.some((c) => c.includes('off-9137'))) {
    fail(`关掉「记录命令历史」之后还在记：${JSON.stringify(gated.list)}`)
  }
  if (!gated.list.includes(HIST_CMD)) {
    fail('关掉开关顺带把已有记录弄丢了 —— 它只该停止记录新的')
  }
  console.log('OK 「记录命令历史」开关：关掉后不再记新的，已有记录不动')

  // 「清空列表」这条 UI 路径
  await press('H', 'KeyH', 72, 10)
  await sleep(500)
  const cleared = await evaluate(`
    const norm = (s) => s.replace(/\\s+/g, '')
    const clearBtn = [...document.querySelectorAll('button')].find((b) => norm(b.textContent) === '清空列表')
    if (!clearBtn) return { error: '浮层里找不到「清空列表」按钮' }
    clearBtn.click()
    await new Promise((r) => setTimeout(r, 400))
    const ok = [...document.querySelectorAll('.ant-popconfirm button')].find((b) => norm(b.textContent) === '确定')
    if (!ok) return { error: '「清空列表」没有弹二次确认（不可逆操作必须有）' }
    ok.click()
    await new Promise((r) => setTimeout(r, 600))
    const list = await window.ofs.invoke('history:list')
    return { left: list.length }
  `)
  if (cleared.error) fail(cleared.error)
  if (cleared.left !== 0) fail(`点了「清空列表」但库里还剩 ${cleared.left} 条`)
  console.log('OK 「清空列表」：有二次确认，确认后库里为空')

  // Esc 收起浮层：它贴在终端底部，留着会挡住后面几步要 hover / 点击的东西
  await press('Escape', 'Escape', 27)
  await sleep(300)
  const overlayGone = await evaluate(
    `return { 还开着: Boolean(document.querySelector('input[placeholder="过滤命令…"]')) }`
  )
  if (overlayGone.还开着) fail('Esc 关不掉命令历史浮层')

  /*
   * 换一个**退路认不出来的提示符**再采一次。
   *
   * 这一步补的是上面那几条断言的一个盲区：fixture 默认的 `test@fixture:~$ ` 里有 `$ `，
   * 于是"提示符列"这条主路即使坏掉，"认 $ / # / %"那条退路也会把命令切出来 ——
   * 断言照样绿。exotic 提示符（`➜  ~ `）里没有任何退路认得的符号，
   * 所以它一响，主路就是唯一能把命令切对的东西：这条断言只对主路负责。
   */
  await evaluate(`document.querySelector('.xterm-helper-textarea')?.focus(); return true`)
  await typeAscii('ps1 exotic')
  await press('Enter', 'Enter', 13)
  await sleep(700)
  await typeAscii('df -h /data')
  await press('Enter', 'Enter', 13)
  await sleep(900)
  const exotic = await evaluate(`
    const list = await window.ofs.invoke('history:list')
    return { list: list.map((e) => e.command) }
  `)
  if (exotic.error) fail(exotic.error)
  if (!exotic.list.includes('df -h /data')) {
    fail(
      '提示符里没有 $ / # / % 时命令没进历史 —— "提示符列"那条主路在真 xterm 上没成立，' +
        `退路也认不出这种提示符。库里现有：${JSON.stringify(exotic.list)}`
    )
  }
  // 切出来的必须是**干净的命令**，不许带上提示符的残渣
  for (const bad of exotic.list) {
    if (/➜|~ df/.test(bad)) fail(`历史里记下了带提示符残渣的命令：${JSON.stringify(bad)}`)
  }
  console.log('OK 提示符里没有 $/#/% 时也切得对（走的是"提示符列"那条主路）')
  await typeAscii('ps1 default')
  await press('Enter', 'Enter', 13)
  await sleep(600)


  // 收尾：这台机器是真的用户数据目录，别把冒烟造的历史留下
  await evaluate(`await window.ofs.invoke('history:clear'); return true`)

  /*
   * 8.58) 命令编辑器：从**界面**打开 → 输入 → 发送，一路走真按钮。
   *
   * 只有真窗口能回答的三件事：
   *  - 侧栏切到「快捷命令」之后那个铅笔按钮真的在（图标按钮没有可访问名字，
   *    所以按"紧邻「新建命令」的那个按钮"定位 —— 布局改了这条会红，那正是要它红的时候）；
   *  - 文本框里的内容真的发到了当前会话（判据是 fixture 回显了它）；
   *  - 多行 + 真执行时那道确认框真的弹（单测只能证明代码里判了 confirmMultilinePaste，
   *    证不了它在真 antd 里弹得出来）。
   */
  const openEditor = await evaluate(`
    // 活动栏按钮顺序固定：连接 / 快捷命令 / 端口转发 / 传输队列 / (间隔) 主题 / 设置
    const navButtons = [...document.querySelectorAll('nav button')]
    if (navButtons.length < 4) return { error: '活动栏按钮少于 4 个，界面结构变了' }
    navButtons[1].click()
    await new Promise((r) => setTimeout(r, 500))

    const newBtn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === '新建命令'
    )
    if (!newBtn) return { error: '切到「快捷命令」之后找不到「新建命令」按钮' }
    const toolbar = newBtn.parentElement
    const pencil = [...toolbar.querySelectorAll('button')].find((b) => b !== newBtn)
    if (!pencil) return { error: '「新建命令」旁边没有命令编辑器按钮' }
    pencil.click()
    await new Promise((r) => setTimeout(r, 600))

    const modal = [...document.querySelectorAll('.ant-modal')].find((m) =>
      m.textContent.includes('命令编辑器')
    )
    if (!modal) return { error: '点了按钮但命令编辑器没打开' }
    const ta = modal.querySelector('textarea')
    if (!ta) return { error: '命令编辑器里没有文本框' }
    ta.focus()
    return {
      focused: document.activeElement === ta,
      按钮: [...modal.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)
    }
  `)
  if (openEditor.error) fail(openEditor.error)
  if (!openEditor.focused) fail('命令编辑器的文本框没拿到焦点')
  for (const label of ['保存为快捷命令', '发送']) {
    if (!openEditor.按钮.some((b) => b.replace(/\s+/g, '') === label)) {
      fail(`命令编辑器里找不到「${label}」按钮，实际有：${openEditor.按钮.join(' / ')}`)
    }
  }

  // 单行：不该弹确认框，直接发出去
  await send('Input.insertText', { text: 'echo editor-4471' })
  await sleep(200)
  const singleSend = await evaluate(`
    window.__edData = ''
    const off = window.ofs.on('term:data', ({ data }) => {
      window.__edData += new TextDecoder().decode(data)
    })
    const modal = [...document.querySelectorAll('.ant-modal')].find((m) =>
      m.textContent.includes('命令编辑器')
    )
    const sendBtn = [...modal.querySelectorAll('button')].find(
      (b) => b.textContent.replace(/\\s+/g, '') === '发送'
    )
    sendBtn.click()
    await new Promise((r) => setTimeout(r, 1200))
    off()
    return {
      tail: window.__edData,
      弹框: document.querySelectorAll('.ant-modal-confirm').length,
      历史: (await window.ofs.invoke('history:list')).map((e) => e.command)
    }
  `)
  if (singleSend.error) fail(singleSend.error)
  if (!singleSend.tail.includes('editor-4471')) {
    fail(`命令编辑器发送后终端没有回显：${JSON.stringify(singleSend.tail.slice(-160))}`)
  }
  if (singleSend.弹框 > 0) fail('单行命令不该弹多行确认框')
  if (!singleSend.历史.includes('echo editor-4471')) {
    fail(`命令编辑器发出去的命令没进历史：${JSON.stringify(singleSend.历史)}`)
  }
  console.log('OK 命令编辑器：界面打开 → 单行发送 → 终端回显 + 进历史，且没有多余确认框')

  // 多行 + 自动回车：必须先弹一次确认（与终端粘贴同一条规矩）
  const multiConfirm = await evaluate(`
    const modal = [...document.querySelectorAll('.ant-modal')].find((m) =>
      m.textContent.includes('命令编辑器')
    )
    const ta = modal.querySelector('textarea')
    ta.focus()
    ta.setSelectionRange(0, ta.value.length)
    return true
  `)
  if (multiConfirm.error) fail(multiConfirm.error)
  await send('Input.insertText', { text: 'echo line-1\necho line-2' })
  await sleep(200)
  const multiSend = await evaluate(`
    const norm = (s) => s.replace(/\\s+/g, '')
    const modal = [...document.querySelectorAll('.ant-modal')].find((m) =>
      m.textContent.includes('命令编辑器')
    )
    const sendBtn = [...modal.querySelectorAll('button')].find((b) => norm(b.textContent) === '发送')
    sendBtn.click()
    await new Promise((r) => setTimeout(r, 600))
    const dlg = [...document.querySelectorAll('.ant-modal-confirm')].at(-1)
    if (!dlg) return { error: '多行 + 自动回车没有弹确认框' }
    const title = dlg.querySelector('.ant-modal-confirm-title')?.textContent ?? ''
    window.__edData = ''
    const off = window.ofs.on('term:data', ({ data }) => {
      window.__edData += new TextDecoder().decode(data)
    })
    const ok = [...dlg.querySelectorAll('.ant-btn')].find((b) => norm(b.textContent) === '确定')
    if (!ok) return { error: '确认框里没有「确定」按钮' }
    ok.click()
    await new Promise((r) => setTimeout(r, 1200))
    off()
    return { title, tail: window.__edData }
  `)
  if (multiSend.error) fail(multiSend.error)
  if (!/粘贴多行/.test(multiSend.title)) {
    fail(`多行确认框的标题不对：${JSON.stringify(multiSend.title)}`)
  }
  if (!multiSend.tail.includes('line-1') || !multiSend.tail.includes('line-2')) {
    fail(`确认之后两行都该发出去，实际回显：${JSON.stringify(multiSend.tail.slice(-200))}`)
  }
  console.log('OK 命令编辑器：多行 + 自动回车先弹确认框，确认后两行都发出去了')

  // 关掉编辑器与历史，别把状态留给后面几步
  await evaluate(`
    const modal = [...document.querySelectorAll('.ant-modal')].find((m) =>
      m.textContent.includes('命令编辑器')
    )
    modal?.querySelector('.ant-modal-close')?.click()
    await new Promise((r) => setTimeout(r, 400))
    // 侧栏切回连接树：后面几步要在树里双击
    const nav = [...document.querySelectorAll('nav button')]
    nav[0].click()
    await new Promise((r) => setTimeout(r, 400))
    await window.ofs.invoke('history:clear')
    return true
  `)

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
      // 命令历史那颗按钮就长在这条工具条上，也就长在原生按钮区正下方 ——
      // 不列进来这一轮就不会 hover 它，它的气泡被系统按钮切掉也没人知道
      '命令历史（Ctrl+Shift+H）',
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

  // 8.77) 拖到文件夹行上：那一行真的亮起来，文件真的落进那一行的目录
  //    这条原本记在计划里的"人工验证"一栏。它值得自动化，因为唯一真会坏的那件事
  //    只有真浏览器能回答：`.dropRow > :global(.ant-table-cell)` 这个选择器得在 antd
  //    **虚拟**表格的 DOM 上命中。虚拟模式下行与单元格是 div 而不是 tr/td，
  //    中间只要多一层包裹，类名照样加得上、高亮却静默不出现 —— 类型检查看不见，
  //    源码护栏也看不见（rowClassName 那行写得完全正确）。
  //
  //    用 CDP 的 Input.dispatchDragEvent 注入**带真实文件路径**的拖拽，
  //    而不是 dispatchEvent(new DragEvent(...))：合成 DataTransfer 里的 File 没有磁盘路径，
  //    webUtils.getPathForFile 返回空串 → localPathsOf 过滤成空 → handleDrop 在
  //    "不支持的拖拽内容"那一支就返回了，落点那行代码根本不会执行。
  //    那样测出来的绿是假的：高亮或许验到了，"落进哪个目录"一个字节都没验。
  //    真注入还顺带走了 Chromium 自己的 dragenter/dragleave 配对，
  //    于是"从目录行移到文件行"这个切换也是真的在被测。
  const dndLocal = join(tmpdir(), `ofs-dnd-${process.pid}.txt`)
  const dndName = basename(dndLocal)
  writeFileSync(dndLocal, 'openfinalshell drag-and-drop smoke\n')

  const dndPrep = await evaluate(`
    const sid = '${session.sessionId}'
    // 前面的步骤可能留着传输抽屉（它带遮罩，会吃掉注入的拖拽）
    document.querySelector('.ant-drawer-open .ant-drawer-close')?.click()
    await new Promise((s) => setTimeout(s, 400))
    if (document.querySelector('.ant-drawer-open')) return { error: '开始拖拽前传输抽屉还开着' }

    // 先清场再造：这一步中途失败过一次（就发生过）就会把 /dnd-dir 留在那儿，
    // 于是后面每一次 mkdir 都撞 EEXIST —— 一次失败污染所有后续运行，
    // 排查起来还长得像"SFTP 坏了"。顺带扫掉历史遗留的上传件（名字带 pid，每次不同）
    const rm = async (p, r) => {
      try {
        await window.ofs.invoke('sftp:delete', { sessionId: sid, path: p, recursive: r })
      } catch {
        /* 不存在就算了 */
      }
    }
    await rm('/dnd-dir', true)
    await rm('/dnd-file.txt', false)
    for (const e of await window.ofs.invoke('sftp:readdir', { sessionId: sid, path: '/' })) {
      if (/^ofs-dnd-.*\\.txt$/.test(e.name)) await rm('/' + e.name, false)
    }

    await window.ofs.invoke('sftp:mkdir', { sessionId: sid, path: '/dnd-dir' })
    await window.ofs.invoke('sftp:touch', { sessionId: sid, path: '/dnd-file.txt' })

    // 刷新走空白处右键的「刷新」（这条路径在 8.75 已被证明可用），
    // 顺带把选中项清空 —— 选中行的底色不同，会污染下面的基线比对
    const anchor = document.querySelector('.ant-table-body') || document.querySelector('.ant-table')
    if (!anchor) return { error: '找不到 SFTP 文件表格' }
    const ar = anchor.getBoundingClientRect()
    anchor.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(ar.left + 20), clientY: Math.round(ar.top + 5)
    }))
    await new Promise((s) => setTimeout(s, 400))
    const refresh = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent.trim() === '刷新')
    if (!refresh) return { error: '菜单里没有「刷新」' }
    refresh.click()
    await new Promise((s) => setTimeout(s, 1200))

    const api = {}
    api.rowOf = (name) =>
      [...document.querySelectorAll('.ant-table-row')].find((e) => e.innerText.includes(name)) ?? null
    // 高亮画在单元格上（选择器是 .dropRow > .ant-table-cell），所以量的是行首单元格
    api.styleOf = (row) => {
      const cell = row?.querySelector('.ant-table-cell')
      if (!cell) return null
      const cs = getComputedStyle(cell)
      return { bg: cs.backgroundColor, shadow: cs.boxShadow }
    }
    api.marked = () =>
      [...document.querySelectorAll('.ant-table-row')]
        .filter((e) => /dropRow/.test(String(e.className)))
        .map((e) => e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40))
    api.mask = () => {
      const m = [...document.querySelectorAll('div')].find((e) => /dropMask/.test(String(e.className)))
      return m ? m.textContent.trim() : null
    }
    api.probe = () => ({
      dir: api.styleOf(api.rowOf('dnd-dir')),
      file: api.styleOf(api.rowOf('dnd-file.txt')),
      marked: api.marked(),
      mask: api.mask()
    })
    // 虚拟列表里行会被回收：滚进视野之后必须重新取一次元素再量矩形，
    // 否则拿到的是一个已经被复用给别人的 div 的坐标
    api.center = async (name) => {
      const first = api.rowOf(name)
      if (!first) return null
      first.scrollIntoView({ block: 'center' })
      await new Promise((s) => setTimeout(s, 250))
      const row = api.rowOf(name)
      if (!row) return null
      const b = row.getBoundingClientRect()
      const body = (document.querySelector('.ant-table-body') || anchor).getBoundingClientRect()
      const pt = { x: Math.round(b.left + Math.min(b.width * 0.5, 160)), y: Math.round(b.top + b.height / 2) }
      // 落点必须真的在表格可视区里，否则注入的坐标打在别的元素上，
      // 这一步会以"没有行被标成落点"的形式假红/假绿
      pt.inBody = pt.y > body.top + 1 && pt.y < body.bottom - 1
      return pt
    }
    window.__ofsDnd = api
    const dirAt = await api.center('dnd-dir')
    const fileAt = await api.center('dnd-file.txt')
    return { dirAt, fileAt, base: api.probe() }
  `)
  if (dndPrep.error) fail(dndPrep.error)
  if (!dndPrep.dirAt) fail('刷新后文件列表里没有 dnd-dir 这一行')
  if (!dndPrep.fileAt) fail('刷新后文件列表里没有 dnd-file.txt 这一行')
  if (!dndPrep.dirAt.inBody) fail(`dnd-dir 行滚不进表格可视区（y=${dndPrep.dirAt.y}）—— 注入的坐标会打在别处`)
  if (!dndPrep.fileAt.inBody) fail(`dnd-file.txt 行滚不进表格可视区（y=${dndPrep.fileAt.y}）`)
  if (!dndPrep.base.dir || !dndPrep.base.file) fail('量不到行首单元格的样式 —— 表格 DOM 结构与预期不符')
  if (dndPrep.base.marked.length > 0) {
    fail(`还没开始拖，就已经有行被标成落点：${dndPrep.base.marked.join(' / ')}`)
  }
  if (dndPrep.base.mask) fail(`还没开始拖，上传遮罩就已经在了（内容：${dndPrep.base.mask}）`)
  // 反空转：两行的基线必须一致。否则"拖过之后与另一行不同"这种比法本来就成立，
  // 高亮压根没画出来也照样绿
  if (dndPrep.base.dir.bg !== dndPrep.base.file.bg) {
    fail(
      `基线不干净：目录行与文件行的底色本就不同（${dndPrep.base.dir.bg} vs ${dndPrep.base.file.bg}）` +
        ' —— 可能有行处于选中/hover 态，这一轮的比对没有约束力'
    )
  }

  const dragData = { items: [], files: [dndLocal], dragOperationsMask: 1 }
  const drag = async (type, at) => {
    await send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: dragData })
    await sleep(180)
  }

  await drag('dragEnter', dndPrep.dirAt)
  await drag('dragOver', dndPrep.dirAt)
  const overDir = await evaluate('return window.__ofsDnd.probe()')
  if (overDir.marked.length !== 1 || !overDir.marked[0].includes('dnd-dir')) {
    fail(
      `拖到目录行上，被标成落点的不是恰好那一行（实际：${overDir.marked.join(' / ') || '一行都没有'}）` +
        ' —— 行级 onDragOver 没生效，或 CDP 注入的拖拽没走到那一行'
    )
  }
  if (overDir.dir.bg === dndPrep.base.dir.bg && overDir.dir.shadow === dndPrep.base.dir.shadow) {
    fail(
      `落点行的类名加上了，行首单元格的底色与阴影却一点没变（底色仍是 ${overDir.dir.bg}）` +
        ' —— .dropRow > .ant-table-cell 在虚拟表格的 DOM 上没命中，用户看不到任何高亮'
    )
  }
  if (!/inset/.test(overDir.dir.shadow)) {
    fail(`落点行少了上下两条 inset 边框（box-shadow 实际是 ${overDir.dir.shadow}）`)
  }
  if (overDir.file.bg !== dndPrep.base.file.bg) {
    fail('拖到 dnd-dir 行上，dnd-file.txt 行的底色也跟着变了 —— 高亮没有限定在落点行')
  }
  if (!overDir.mask || !overDir.mask.includes('/dnd-dir')) {
    fail(`上传遮罩没有说落点是 /dnd-dir（实际：${JSON.stringify(overDir.mask)}）`)
  }

  // 移到一个**文件**行上：它不该成为落点（!isDir(entry) 那道判断），遮罩要退回当前目录
  await drag('dragOver', dndPrep.fileAt)
  const overFile = await evaluate('return window.__ofsDnd.probe()')
  if (overFile.marked.length > 0) {
    fail(`拖到一个文件行上时它被标成了落点（${overFile.marked.join(' / ')}）—— !isDir(entry) 没挡住`)
  }
  if (overFile.mask && overFile.mask.includes('/dnd-dir')) {
    fail('已经离开目录行，遮罩却还指着 /dnd-dir —— 行的 onDragLeave 没清掉落点')
  }

  // 放在目录行上 → 必须进 /dnd-dir，且**不能**同时进当前目录
  await drag('dragOver', dndPrep.dirAt)
  await drag('drop', dndPrep.dirAt)
  const landed = await evaluate(`
    const sid = '${session.sessionId}'
    const ls = async (p) =>
      (await window.ofs.invoke('sftp:readdir', { sessionId: sid, path: p })).map((e) => e.name)
    for (let i = 0; i < 50; i++) {
      if ((await ls('/dnd-dir')).includes(${JSON.stringify(dndName)})) break
      await new Promise((s) => setTimeout(s, 300))
    }
    return { inside: await ls('/dnd-dir'), root: await ls('/'), mask: window.__ofsDnd.mask() }
  `)
  if (!landed.inside.includes(dndName)) {
    fail(
      `拖到 /dnd-dir 行上放下，文件没落进那个目录` +
        `（/dnd-dir 里有 [${landed.inside.join(' ')}]，当前目录里有 [${landed.root.join(' ')}]）`
    )
  }
  if (landed.root.includes(dndName)) {
    fail('文件同时也落进了当前目录 —— 行与容器的 onDrop 都跑了一遍，行里的 stopPropagation 没生效')
  }
  if (landed.mask) fail(`放下之后上传遮罩还留在界面上（内容：${landed.mask}）`)

  // 上一次 enqueue 会把传输抽屉弹出来（useTransferStore.enqueue 里写死的），
  // 它带遮罩、盖在表格上 —— 不关掉的话下一次注入的坐标打在抽屉上，
  // 这一步会以"没退回当前目录"的形式假红。关掉之后行的位置也可能变，重新量一次
  const reMeasured = await evaluate(`
    document.querySelector('.ant-drawer-open .ant-drawer-close')?.click()
    await new Promise((s) => setTimeout(s, 500))
    const stillOpen = Boolean(document.querySelector('.ant-drawer-open'))
    return { stillOpen, fileAt: await window.__ofsDnd.center('dnd-file.txt') }
  `)
  if (reMeasured.stillOpen) fail('传输抽屉关不掉，后面的拖拽会打在抽屉上')
  if (!reMeasured.fileAt?.inBody) fail('关掉抽屉后 dnd-file.txt 行不在表格可视区里')

  // 放在文件行上 → 退回当前目录（而不是往一个文件里面塞东西）
  await drag('dragEnter', reMeasured.fileAt)
  await drag('dragOver', reMeasured.fileAt)
  await drag('drop', reMeasured.fileAt)
  const fellBack = await evaluate(`
    const sid = '${session.sessionId}'
    const ls = async (p) =>
      (await window.ofs.invoke('sftp:readdir', { sessionId: sid, path: p })).map((e) => e.name)
    for (let i = 0; i < 50; i++) {
      if ((await ls('/')).includes(${JSON.stringify(dndName)})) break
      await new Promise((s) => setTimeout(s, 300))
    }
    return { root: await ls('/') }
  `)
  if (!fellBack.root.includes(dndName)) {
    fail(`放在一个文件行上时没有退回当前目录（当前目录里有 [${fellBack.root.join(' ')}]）`)
  }
  console.log('OK 拖到文件夹行：那一行真的高亮、文件真的进了那个目录；放在文件行上退回当前目录')

  // 收尾：删掉本步造的远端痕迹，并把上传抽屉关回去（它 enqueue 时会自己弹出来，
  // 留着会挡住后面几步要点的东西）
  await evaluate(`
    const sid = '${session.sessionId}'
    const rm = async (p, r) => {
      try { await window.ofs.invoke('sftp:delete', { sessionId: sid, path: p, recursive: r }) } catch {}
    }
    await rm('/dnd-dir', true)
    await rm('/dnd-file.txt', false)
    await rm('/' + ${JSON.stringify(dndName)}, false)
    document.querySelector('.ant-drawer-open .ant-drawer-close')?.click()
    await new Promise((s) => setTimeout(s, 400))
    delete window.__ofsDnd
    return true
  `)
  rmSync(dndLocal, { force: true })

  // 8.8) 内置编辑器：CM6 在 file:// + 严格 CSP + 根元素 CSS zoom 里到底能不能用
  //    这一步存在的理由是"只有真实打包窗口能回答"的那几个问题：
  //      ① 严格 CSP（无 unsafe-eval、无 blob:）下 CodeMirror 能不能起来、样式注得进去；
  //      ② legacy 模式的 tokenTable 在真实产物里完不完整（认不出的标签会 console.warn，
  //         后果是那一类词永远没颜色 —— 界面看着能用、构建全绿）；
  //      ③ body 上的 user-select:none 有没有把代码区变成"看得见选不中"；
  //      ④ 根元素的 CSS zoom 会不会让点击坐标与光标落点错位（125%/150% 是常用档）。
  //    ⚠️ 只读查看**验不到输入法**：不接受输入就没有组词过程。那条移到片 3（可编辑）。
  const edLocal = join(tmpdir(), `ofs-ed-${process.pid}.conf`)
  const ED_LINES = [
    '# openfinalshell 内置编辑器冒烟样本',
    '[mysqld]',
    'port = 3306',
    'max_connections = 500',
    'datadir = /var/lib/mysql',
    '; 下一行 key 后面是一个全角空格，应该被标成不可见字符',
    'charset =　utf8mb4',
    '# 中文注释：这一行用来确认 CJK 不会把行高撑歪',
    ''
  ]
  writeFileSync(edLocal, ED_LINES.join('\n'), 'utf8')

  // 先把样本传上去（走真实传输队列，顺带再验一次上传通路）
  const edUpload = await evaluate(`
    const sid = '${session.sessionId}'
    try { await window.ofs.invoke('sftp:delete', { sessionId: sid, path: '/ed-smoke.conf', recursive: false }) } catch {}
    await window.ofs.invoke('transfer:enqueue', [{
      sessionId: sid, kind: 'upload',
      localPath: ${JSON.stringify(edLocal)}, remotePath: '/ed-smoke.conf'
    }])
    for (let i = 0; i < 60; i++) {
      const list = await window.ofs.invoke('sftp:readdir', { sessionId: sid, path: '/' })
      if (list.some((e) => e.name === 'ed-smoke.conf' && e.size > 0)) return { ok: true, size: list.find((e) => e.name === 'ed-smoke.conf').size }
      await new Promise((s) => setTimeout(s, 300))
    }
    return { ok: false }
  `)
  if (!edUpload.ok) fail('编辑器样本文件没能传上去，后面几步无从验证')

  // 右键那一行 → 「内置编辑器查看」
  const edOpen = await evaluate(`
    const sid = '${session.sessionId}'
    document.querySelector('.ant-drawer-open .ant-drawer-close')?.click()
    await new Promise((s) => setTimeout(s, 400))

    const body = document.querySelector('.ant-table-body') || document.querySelector('.ant-table')
    if (!body) return { error: '找不到 SFTP 文件表格' }
    const openMenu = async (el) => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 5)
      }))
      await new Promise((s) => setTimeout(s, 400))
      return [...document.querySelectorAll('.ant-dropdown-menu-item')]
    }
    // 用菜单里的「刷新」把刚传上去的文件刷出来
    const refresh = (await openMenu(body)).find((e) => e.textContent.trim() === '刷新')
    if (!refresh) return { error: '菜单里没有「刷新」' }
    refresh.click()
    await new Promise((s) => setTimeout(s, 1200))

    const row = [...document.querySelectorAll('.ant-table-row')].find((e) => e.innerText.includes('ed-smoke.conf'))
    if (!row) return { error: '刷新后列表里没有 ed-smoke.conf' }
    const items = await openMenu(row)
    const view = items.find((e) => e.textContent.trim() === '内置编辑器查看')
    if (!view) return { error: '右键菜单里没有「内置编辑器查看」', 菜单: items.map((e) => e.textContent.trim()) }
    if (view.className.includes('-disabled')) return { error: '「内置编辑器查看」对一个普通文件是灰的' }
    view.click()

    // 等 CM 起来并渲染出行
    for (let i = 0; i < 60; i++) {
      if (document.querySelectorAll('.cm-editor .cm-line').length >= 5) break
      await new Promise((s) => setTimeout(s, 200))
    }
    const editor = document.querySelector('.cm-editor')
    if (!editor) return { error: 'CodeMirror 没有挂出来（CSP 拦住了？看 console）' }

    const lines = [...document.querySelectorAll('.cm-editor .cm-line')]
    const spans = [...document.querySelectorAll('.cm-editor .cm-line span')]
    const colors = new Set(spans.map((s) => getComputedStyle(s).color).filter(Boolean))
    const content = document.querySelector('.cm-editor .cm-content')
    return {
      行数: lines.length,
      首行: lines[0]?.textContent ?? '',
      span数: spans.length,
      颜色数: colors.size,
      颜色: [...colors].slice(0, 8),
      特殊字符标记: document.querySelectorAll('.cm-editor .cm-specialChar').length,
      行号槽: Boolean(document.querySelector('.cm-editor .cm-gutters')),
      内容可选中: content ? getComputedStyle(content).userSelect : null,
      背景: getComputedStyle(editor).backgroundColor,
      状态条文本: [...document.querySelectorAll('[class*=status]')].map((e) => e.textContent.trim()).join(' | ').slice(0, 300)
    }
  `)
  if (edOpen.error) fail(`${edOpen.error}${edOpen.菜单 ? `（菜单：${JSON.stringify(edOpen.菜单)}）` : ''}`)
  if (edOpen.行数 < 8) fail(`编辑器只渲染出 ${edOpen.行数} 行，样本有 ${ED_LINES.length - 1} 行`)
  if (!edOpen.首行.includes('内置编辑器冒烟样本')) fail(`编辑器首行不是样本内容：${JSON.stringify(edOpen.首行)}`)
  if (!edOpen.行号槽) fail('没有行号槽 —— lineNumbers 扩展没生效')
  // 语法着色：span 数与**不同颜色数**都要够。只看 span 数不够 ——
  // tokenTable 缺失时 CM 仍会给每个 token 生成 span，只是全部落回默认前景色
  if (edOpen.span数 < 5) fail(`语法着色只产出 ${edOpen.span数} 个 span，几乎等于没着色`)
  if (edOpen.颜色数 < 3) {
    fail(
      `语法着色只有 ${edOpen.颜色数} 种颜色（${edOpen.颜色.join(' / ')}）—— ` +
        'legacy 模式的 tokenTable 很可能不完整，注释之外的词全落回默认色'
    )
  }
  if (edOpen.特殊字符标记 < 1) fail('样本里那个全角空格没有被标出来（highlightSpecialChars 的字符集漏了 U+3000）')
  if (edOpen.内容可选中 !== 'text') {
    fail(`代码区 user-select = ${edOpen.内容可选中}，应为 text —— body 上那条 user-select:none 继承进来了，代码看得见选不中`)
  }
  console.log(
    `OK 内置编辑器：${edOpen.行数} 行、${edOpen.span数} 个着色 span / ${edOpen.颜色数} 种颜色、` +
      `全角空格标记 ${edOpen.特殊字符标记} 处、可选中`
  )

  // CSP 与高亮标签：这两类问题只会在 console 里留痕
  const cspNoise = consoleLog.filter((m) => /Content Security Policy|Refused to/i.test(m.text))
  if (cspNoise.length > 0) {
    fail(`CSP 拦下了东西：\n  ${cspNoise.map((m) => m.text).join('\n  ')}`)
  }
  const tagNoise = consoleLog.filter((m) => /Unknown highlighting tag/i.test(m.text))
  if (tagNoise.length > 0) {
    fail(
      `CodeMirror 报了认不出的高亮标签（这些词在编辑器里没有颜色）：\n  ` +
        `${[...new Set(tagNoise.map((m) => m.text))].join('\n  ')}\n  ` +
        '把它们加进 src/renderer/src/features/editor/legacyTokens.ts'
    )
  }
  console.log(`OK 渲染进程 console 干净：无 CSP 拒绝、无未知高亮标签（共 ${consoleLog.length} 条输出）`)

  /*
   * Ctrl+F 查找条。
   *
   * 必须用 CDP 注入**真按键**，不能 dispatchEvent(new KeyboardEvent(...))：
   * CodeMirror 靠 w3c-keyname 从事件里认按键名，而合成事件的 keyCode 是 0 ——
   * 认不出按键，绑定一条都不会触发。第一版就是这么写的，报的是"searchKeymap 没接上"，
   * 而真实产物里它接得好好的。这类"测法造出来的红"和真 bug 长得一模一样。
   */
  const focused = await evaluate(`
    const content = document.querySelector('.cm-editor .cm-content')
    if (!content) return { error: '找不到代码区' }
    content.focus()
    await new Promise((s) => setTimeout(s, 200))
    return { 拿到焦点: document.activeElement?.classList.contains('cm-content') === true }
  `)
  if (focused.error) fail(focused.error)
  if (!focused.拿到焦点) fail('代码区拿不到焦点 —— 键盘相关的功能都无从验证')
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      modifiers: 2, // Ctrl
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      nativeVirtualKeyCode: 70
    })
  }
  await sleep(400)
  const edSearch = await evaluate(`
    const panel =
      document.querySelector('.cm-editor .cm-panel.cm-search') ||
      document.querySelector('.cm-editor [class*=cm-search]')
    // 失败时把编辑器里出现过的容器类名都带回去 —— 否则只知道"没找到"，不知道找错了还是真没有
    const 诊断 =
      [...document.querySelectorAll('.cm-editor > *')].map((e) => e.className).join(' | ') +
      ' ||| panels 内: ' +
      (document.querySelector('.cm-editor .cm-panels')?.innerHTML ?? '（没有 .cm-panels）').slice(0, 400)
    // CM 的查找框是 <input class="cm-textfield" name="search">，**没有 type 属性** ——
    // 按 input[type=text] 找是空的（第一版就是这么写的，而且主题里也这么写，
    // 于是整个面板留着原生外观没人发现）
    const input = panel?.querySelector('input.cm-textfield')
    const bg = panel ? getComputedStyle(panel.closest('.cm-panels') ?? panel).backgroundColor : null
    const 输入框底色 = input ? getComputedStyle(input).backgroundColor : null
    if (panel) {
      document.querySelector('.cm-editor .cm-panel.cm-search [name=close]')?.click()
      await new Promise((s) => setTimeout(s, 250))
    }
    return {
      出现查找条: Boolean(panel),
      有输入框: Boolean(input),
      面板背景: bg,
      输入框底色: 输入框底色,
      诊断,
      关掉了: !document.querySelector('.cm-editor [class*=cm-search]')
    }
  `)
  if (edSearch.error) fail(edSearch.error)
  if (!edSearch.出现查找条 || !edSearch.有输入框) {
    fail(`Ctrl+F 没有唤出查找条（编辑器里的直接子元素：${edSearch.诊断}）`)
  }
  /*
   * 面板与输入框都必须被我们的主题接管。查输入框那一条是**这一步真正抓到过 bug 的地方**：
   * 主题里写的是 input[type=text]，而 CM 的查找框没有 type 属性 ——
   * 面板容器（.cm-panels）由另一条规则命中所以看着"有主题"，里面那个输入框却是原生白。
   * 判据用"不是白、也不是透明"：深浅两个主题下我们给的都是 --ofs-bg-panel，
   * 深色是 #1d2026、浅色是 #ffffff —— 所以只在深色主题下这条才有约束力，
   * 而冒烟跑的就是默认深色。
   */
  for (const [what, color] of [
    ['查找面板', edSearch.面板背景],
    ['查找输入框', edSearch.输入框底色]
  ]) {
    if (color === 'rgba(0, 0, 0, 0)' || /255,\s*255,\s*255/.test(String(color))) {
      fail(`${what}的背景是 ${color} —— 主题没接管它（选择器没命中？），深色下会白得刺眼`)
    }
  }
  console.log(
    `OK Ctrl+F 查找条：出得来、面板 ${edSearch.面板背景} / 输入框 ${edSearch.输入框底色} 都跟主题、关得掉`
  )

  /*
   * 点击落点 vs 根元素 CSS zoom。
   *
   * 这是这一片最大的未知：界面缩放走的是 document.documentElement.style.zoom，
   * 而 CodeMirror 完全靠 DOM 量字符宽度来把像素坐标换算成文档位置。
   * 两边对"1 个 CSS 像素"的理解一旦不一致，点第 5 行会落到第 7 行 ——
   * 而这种错位在 100% 下永远看不见。判据用 .cm-activeLine 的文本（那是光标真正落在哪一行）。
   */
  const clickAtLine = async (zoom, lineText) => {
    await evaluate(`
      await window.ofs.invoke('settings:set', { uiZoom: ${zoom} })
      await new Promise((s) => setTimeout(s, 700))
      return true
    `)
    const pt = await evaluate(`
      const line = [...document.querySelectorAll('.cm-editor .cm-line')]
        .find((e) => e.textContent.includes(${JSON.stringify(lineText)}))
      if (!line) return null
      line.scrollIntoView({ block: 'center' })
      await new Promise((s) => setTimeout(s, 200))
      const again = [...document.querySelectorAll('.cm-editor .cm-line')]
        .find((e) => e.textContent.includes(${JSON.stringify(lineText)}))
      const r = again.getBoundingClientRect()
      return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2), h: Math.round(r.height) }
    `)
    if (!pt) fail(`uiZoom=${zoom}：找不到包含「${lineText}」的那一行`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(350)
    const hit = await evaluate(`
      const el = document.querySelector('.cm-editor .cm-activeLine')
      return { 命中行: el ? el.textContent : null }
    `)
    return { ...hit, 行高: pt.h }
  }

  for (const zoom of [100, 150]) {
    const target = 'datadir = /var/lib/mysql'
    const r = await clickAtLine(zoom, target)
    if (r.命中行 === null) {
      fail(`uiZoom=${zoom}：点下去之后没有活动行 —— 点击没落进代码区（坐标换算错位？）`)
    }
    if (!r.命中行.includes(target)) {
      fail(
        `uiZoom=${zoom}：点第「${target}」行，光标落到了「${r.命中行}」—— ` +
          '根元素 CSS zoom 与 CodeMirror 的坐标换算不一致'
      )
    }
    console.log(`OK uiZoom=${zoom}%：点击落点正确（行高 ${r.行高}px）`)
  }
  await evaluate(`await window.ofs.invoke('settings:set', { uiZoom: 100 }); return true`)

  /*
   * 8.9) 可编辑 + 输入法 + 保存往返 + 闸门循环。
   *
   * 这一步补的是片 2 明确记着"没验到"的那条：**输入法**。只读查看不接受输入，
   * 就没有组词过程，所以那时候写下的"IME 未验证"是实话。现在能写了，用 CDP 的
   * Input.imeSetComposition 造出真实的 composition 事件序列 ——
   * CodeMirror 对组词是特殊处理的（组词期间要暂停自己的 DOM 读回），
   * 接错的症状是拼音残留在文档里（"nihao你好"）或者内容被插两遍。
   *
   * 顺带这一步把整条闸门循环在**真产物**里跑一遍，而这是 fixture 服务器白送的：
   * 它不通告 posix-rename 扩展，所以每一次保存都必然先撞上 nonAtomic 那道闸门 ——
   * 于是"闸门 → 确认框 → 只打开那一个开关 → 再来一次"这条路每次都被走到。
   * 后面那段还故意从背后改一次远端，逼出 conflict + nonAtomic **两个连着弹**：
   * 老那种一个 force 管三件事的设计在这里只会弹一次，两个连弹正是三个开关拆开的证据。
   */
  /** 找当前那个确认框：回标题、正文与按钮文字，供断言与诊断 */
  const readModal = () => `
    const dlg = [...document.querySelectorAll('.ant-modal-confirm')].at(-1)
    if (!dlg) return { 有框: false, 页面上的框: document.querySelectorAll('.ant-modal').length }
    return {
      有框: true,
      标题: dlg.querySelector('.ant-modal-confirm-title')?.textContent ?? '',
      正文: dlg.querySelector('.ant-modal-confirm-content')?.textContent ?? '',
      按钮: [...dlg.querySelectorAll('.ant-btn')].map((b) => b.textContent.trim())
    }
  `
  /**
   * 点确认框上写着某段文字的那个按钮。
   *
   * 比较前要**去掉所有空白**：antd 会给两个汉字的按钮自动插一个空格
   * （autoInsertSpaceInButton），于是「取消」在 DOM 里是「取 消」——
   * 按原文比对找不到它，而报出来的错长得像"按钮没渲染"。
   */
  const clickModalBtn = (label) => `
    const norm = (s) => s.replace(/\\s+/g, '')
    const dlg = [...document.querySelectorAll('.ant-modal-confirm')].at(-1)
    const btn = dlg && [...dlg.querySelectorAll('.ant-btn')].find((b) => norm(b.textContent) === norm(${JSON.stringify(label)}))
    if (!btn) return { ok: false, 有的按钮: dlg ? [...dlg.querySelectorAll('.ant-btn')].map((b) => b.textContent.trim()) : null }
    btn.click()
    await new Promise((s) => setTimeout(s, 700))
    return { ok: true }
  `
  /**
   * 读回远端那份内容。带重试是因为写回的两条路都有"目标短暂不存在"的窗口：
   * 传输队列覆盖同名文件是先删后写，而非原子替换是"改名备份 → 改名就位"。
   * 这里要断言的是**最终内容**，不是"任一瞬间都读得到"，所以重试不掩盖任何东西。
   */
  const remoteText = async () => {
    for (let i = 0; i < 10; i++) {
      const r = await evaluate(`
        try {
          const v = await window.ofs.invoke('sftp:fileView', {
            sessionId: '${session.sessionId}', path: '/ed-smoke.conf'
          })
          return { text: v.text, bytes: v.bytes }
        } catch (e) { return { soft: String(e && e.message || e) } }
      `)
      if (r.error) fail(`读回远端文件失败：${r.error}`)
      if (!r.soft) return r
      await sleep(300)
    }
    fail('十次都没读到 /ed-smoke.conf —— 它是真的没了，不是撞上替换窗口')
  }

  // 光标放到 'port = 3306' 那一行的行尾
  const caret = await clickAtLine(100, 'port = 3306')
  if (!caret.命中行 || !caret.命中行.includes('port = 3306')) {
    fail('没能把光标放到指定行，输入法与保存都无从验证')
  }
  await press('End', 'End', 35)

  // 组词：ni → nihao → 提交「你好」
  await send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
  await sleep(120)
  await send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await sleep(120)
  await send('Input.insertText', { text: '你好' })
  await sleep(500)

  const ime = await evaluate(`
    const doc = [...document.querySelectorAll('.cm-editor .cm-line')].map((e) => e.textContent).join('\\n')
    const 那一行 = [...document.querySelectorAll('.cm-editor .cm-line')]
      .map((e) => e.textContent).find((s) => s.includes('port = 3306')) ?? ''
    return { doc, 那一行, 有脏点: Boolean(document.querySelector('[data-ofs-dirty="1"]')) }
  `)
  if (ime.error) fail(ime.error)
  if (!ime.那一行.includes('你好')) {
    fail(`输入法提交的内容没有进文档：那一行是「${ime.那一行}」`)
  }
  if (/nihao/.test(ime.doc)) {
    fail(`拼音残留在文档里 —— CodeMirror 的组词处理没接对：「${ime.那一行}」`)
  }
  if ((ime.doc.match(/你好/g) ?? []).length !== 1) {
    fail(`「你好」出现了 ${(ime.doc.match(/你好/g) ?? []).length} 次 —— 组词提交被插了多遍`)
  }
  if (!ime.有脏点) fail('改了内容但标签上没有未保存标记')

  /*
   * 组词结束之后普通按键还得正常落下去。
   *
   * 这一条替掉了原来那句"检查有没有 .cm-composing 类" —— CM6 里**没有**这个类
   * （查过 @codemirror/view 的产物，一次都没有），所以那个断言永远为真、
   * 永远不会红。一个测不出任何东西的检查比没有检查更糟：它会让人以为验过了。
   * 换成"再按一个键看落没落对"，这才真的能抓住"编辑器卡在组词态"。
   */
  await typeChar('x', 'KeyX', 88)
  await sleep(250)
  const afterIme = await evaluate(`
    const 那一行 = [...document.querySelectorAll('.cm-editor .cm-line')]
      .map((e) => e.textContent).find((s) => s.includes('port = 3306')) ?? ''
    return { 那一行 }
  `)
  if (!afterIme.那一行.includes('你好x')) {
    fail(`组词提交之后普通按键没落在光标后面：那一行是「${afterIme.那一行}」—— 卡在组词态了？`)
  }
  await press('Backspace', 'Backspace', 8)
  await sleep(250)
  console.log(`OK 输入法：组词提交进了文档且无拼音残留（「${ime.那一行.trim()}」），之后普通按键正常，脏标记亮了`)

  // Ctrl+S 第一次：fixture 不通告 posix-rename，所以必然先撞 nonAtomic 那道闸门
  const beforeSave = await remoteText()
  await evaluate(`document.querySelector('.cm-editor .cm-content')?.focus(); return true`)
  await press('s', 'KeyS', 83, 2)
  await sleep(900)
  const gate1 = await evaluate(readModal())
  if (!gate1.有框) {
    fail(
      `Ctrl+S 之后没有出现确认框。fixture 服务器不支持 posix-rename，` +
        `所以这一次保存必须被 nonAtomic 拦住（页面上的 modal 数：${gate1.页面上的框}）`
    )
  }
  if (!/原子替换/.test(gate1.标题)) {
    fail(`第一次保存弹的不是"不支持原子替换"那个框，而是「${gate1.标题}」`)
  }
  console.log(`OK Ctrl+S 触发保存，并被 nonAtomic 闸门拦下（「${gate1.标题}」）`)

  // 先取消：一个字节都不许写
  const cancelled = await evaluate(clickModalBtn('取消'))
  if (!cancelled.ok) fail(`确认框上找不到「取消」（有的按钮：${JSON.stringify(cancelled.有的按钮)}）`)
  const afterCancel = await remoteText()
  if (afterCancel.text !== beforeSave.text) {
    fail('取消了确认框，远端文件却被改了 —— 闸门没拦住写入')
  }
  const stillDirty = await evaluate(`return { 有脏点: Boolean(document.querySelector('[data-ofs-dirty="1"]')) }`)
  if (!stillDirty.有脏点) fail('取消保存之后脏标记被清掉了 —— 用户会以为内容已经存上去了')
  console.log('OK 取消确认框：远端一个字节没变，脏标记还在')

  // 再来一次并确认
  await evaluate(`document.querySelector('.cm-editor .cm-content')?.focus(); return true`)
  await press('s', 'KeyS', 83, 2)
  await sleep(900)
  const okBtn = await evaluate(clickModalBtn('知道风险，继续保存'))
  if (!okBtn.ok) fail(`nonAtomic 框上找不到确认按钮（有的按钮：${JSON.stringify(okBtn.有的按钮)}）`)
  await sleep(1200)

  const saved = await evaluate(`
    return {
      有脏点: Boolean(document.querySelector('[data-ofs-dirty="1"]')),
      提示: [...document.querySelectorAll('.ant-message-notice-content')].map((e) => e.textContent).join(' | '),
      还有框: document.querySelectorAll('.ant-modal-confirm').length
    }
  `)
  const roundTrip = await remoteText()
  if (!roundTrip.text.includes('你好')) {
    fail(`保存往返失败：远端读回来的内容里没有「你好」（${roundTrip.bytes} 字节）`)
  }
  if (saved.有脏点) fail('保存成功了但脏标记没清掉')
  console.log(
    `OK 保存往返：远端读回来含「你好」（${roundTrip.bytes} 字节），脏标记已清，提示「${saved.提示.trim()}」`
  )

  /*
   * 撤销。片 2 的只读查看里 history() 压根没装（historyKeymap 空转、defaultKeymap 不含撤销），
   * 只读时没人按 Ctrl+Z 所以一直没暴露。这一条在真产物里钉住它。
   *
   * 判据刻意用**一次刚打下去的、独一无二的字符**，而不是"撤销之后『你好』还在不在"——
   * 第一版就是后者，结果它红了，而产物一切正常：那时撤销栈顶是保存前删掉 'x' 的那次退格，
   * 一次 Ctrl+Z 撤销的是**它**，「你好」当然还在。断言必须对准"我刚做的那一步"。
   *
   * 顺带验一件事：撤回到与远端一致之后脏标记要**灭掉** —— 脏的判据是"内容和远端一不一样"，
   * 不是"有没有编辑过"。改一个字再改回来不该让用户在关标签时白答一次确认框。
   */
  await evaluate(`document.querySelector('.cm-editor .cm-content')?.focus(); return true`)
  await typeChar('Q', 'KeyQ', 81)
  await sleep(300)
  const typedQ = await evaluate(`
    const 那一行 = [...document.querySelectorAll('.cm-editor .cm-line')]
      .map((e) => e.textContent).find((s) => s.includes('port = 3306')) ?? ''
    return { 那一行, 有脏点: Boolean(document.querySelector('[data-ofs-dirty="1"]')) }
  `)
  if (!typedQ.那一行.includes('Q')) fail(`保存之后又打了一个字符却没进文档：「${typedQ.那一行}」`)
  if (!typedQ.有脏点) fail('保存之后再改一次，脏标记没有重新亮起')

  await press('z', 'KeyZ', 90, 2)
  await sleep(500)
  const undone = await evaluate(`
    const 那一行 = [...document.querySelectorAll('.cm-editor .cm-line')]
      .map((e) => e.textContent).find((s) => s.includes('port = 3306')) ?? ''
    return { 那一行, 有脏点: Boolean(document.querySelector('[data-ofs-dirty="1"]')) }
  `)
  if (undone.那一行.includes('Q')) {
    fail(`Ctrl+Z 没有撤销掉刚打的那个字符：那一行还是「${undone.那一行}」—— history() 没装？`)
  }
  if (!undone.那一行.includes('你好')) {
    fail(`Ctrl+Z 撤销过头了，把上一次保存的内容也退掉了：「${undone.那一行}」`)
  }
  if (undone.有脏点) {
    fail('撤回到与远端一致之后脏标记还亮着 —— 脏的判据变成了"有没有编辑过"而不是"内容一不一样"')
  }
  console.log('OK Ctrl+Z 撤销生效（且没撤销过头），撤回到与远端一致后脏标记自动灭掉')

  /*
   * 从背后改一次远端 → 下一次保存必须**两个框连着弹**：先 conflict（远端变过了），
   * 确认之后再 nonAtomic（这台服务器不支持原子替换）。
   *
   * 这一条是三个开关拆开的**真产物红证**：老那种一个 force 管三件事的设计在这里只会弹
   * 一次框 —— 用户确认的是"覆盖别人的改动"，却顺带承担了"文件会短暂不存在"。
   */
  writeFileSync(edLocal, '# 别人改的\nport = 9999\n', 'utf8')
  const pushed = await evaluate(`
    const sid = '${session.sessionId}'
    await window.ofs.invoke('transfer:enqueue', [{
      sessionId: sid, kind: 'upload',
      localPath: ${JSON.stringify(edLocal)}, remotePath: '/ed-smoke.conf'
    }])
    // 读要吞掉异常：传输队列覆盖同名文件是"先删后写"，中间有一个窗口文件不存在，
    // 而这一轮轮询很容易正好落在那里 —— 让它抛出去会变成一个看不懂的渲染进程异常
    for (let i = 0; i < 60; i++) {
      try {
        const v = await window.ofs.invoke('sftp:fileView', { sessionId: sid, path: '/ed-smoke.conf' })
        if (v.text.includes('别人改的')) return { ok: true }
      } catch {}
      await new Promise((s) => setTimeout(s, 300))
    }
    return { ok: false }
  `)
  if (!pushed.ok) fail('没能从背后改掉远端文件，冲突那条路无从验证')

  // 再改一笔，然后存 —— 编辑器手里那份与远端此刻那份完全无关，正是冲突的定义
  await evaluate(`document.querySelector('.cm-editor .cm-content')?.focus(); return true`)
  await typeChar('W', 'KeyW', 87)
  await sleep(300)
  await press('s', 'KeyS', 83, 2)
  await sleep(900)
  const gConflict = await evaluate(readModal())
  if (!gConflict.有框 || !/被改过/.test(gConflict.标题)) {
    fail(`远端被第三方改过之后保存，没有弹冲突确认框（弹的是「${gConflict.标题 ?? '无'}」）`)
  }
  // main 给的原话必须出现在框里 —— "远端没了"和"被改过"是两种不同的冲突
  if (!/改动过|不存在/.test(gConflict.正文)) {
    fail(`冲突框里没带上 main 给的具体原因：「${gConflict.正文}」`)
  }
  // 打印尾巴而不是开头：正文是「路径 + 我们的说明 + main 给的原因」，
  // 而这里唯一值得人眼确认的是最后那段 —— main 的原话真的接上来了
  console.log(
    `OK 远端被改过 → 弹冲突框（「${gConflict.标题}」，main 的原话「…${gConflict.正文.slice(-24)}」）`
  )

  const confirmOverwrite = await evaluate(clickModalBtn('仍然覆盖'))
  if (!confirmOverwrite.ok) {
    fail(`冲突框上找不到「仍然覆盖」（有的按钮：${JSON.stringify(confirmOverwrite.有的按钮)}）`)
  }
  const gate2 = await evaluate(readModal())
  if (!gate2.有框 || !/原子替换/.test(gate2.标题)) {
    fail(
      '点了"仍然覆盖"之后应当**再**弹一次"不支持原子替换"（两道闸门各要一次确认）。' +
        `实际弹的是「${gate2.标题 ?? '没有框'}」—— 一次确认放行了两道闸门？`
    )
  }
  console.log('OK 两道闸门各弹一次：确认"仍然覆盖"没有顺带放行非原子替换')
  await evaluate(clickModalBtn('知道风险，继续保存'))
  await sleep(1200)
  const finalText = await remoteText()
  if (finalText.text.includes('别人改的')) {
    fail('两个框都确认了，远端却还是第三方那份 —— 覆盖没有真正发生')
  }
  console.log('OK 两次确认之后内容真的写上去了')

  // 关掉标签 → 那一格应该整个消失（它没有开关，全关掉就是关闭）
  const edClose = await evaluate(`
    const close = document.querySelector('[class*=tabClose]')
    if (!close) return { error: '找不到文件标签上的关闭按钮' }
    close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((s) => setTimeout(s, 600))
    const sid = '${session.sessionId}'
    try { await window.ofs.invoke('sftp:delete', { sessionId: sid, path: '/ed-smoke.conf', recursive: false }) } catch {}
    return { 还在: Boolean(document.querySelector('.cm-editor')) }
  `)
  if (edClose.error) fail(edClose.error)
  if (edClose.还在) fail('关掉唯一的文件标签之后，编辑器那一格还占着版面')
  console.log('OK 关掉最后一个文件标签，编辑器那一格随之消失')
  rmSync(edLocal, { force: true })

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
  // 比较前把空白全去掉：那一步读按钮文字时压掉了空白，
  // 而「选择 FinalShell 数据目录…」里带空格 —— 按原文比对会找不到它
  for (const label of ['导出…', '选择文件导入…', '选择 FinalShell 数据目录…']) {
    const norm = (s) => s.replace(/\s+/g, '')
    if (!settingsPanel.buttons.some((b) => norm(b) === norm(label))) {
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

  /*
   * 9.7) 从 FinalShell 导入：在真产物里跑完 扫描 → 写库 → 连接树能看见。
   *
   * 目录由这边现造（`app:finalshellScan` 收一个 dir 就是为了这个：界面正常路径不传它，
   * 走系统对话框，而 CDP 关不掉那个对话框）。样本保留 FinalShell 真实记录的字段名与形状，
   * 主机与密文都是编的 —— 冒烟脚本里不该躺着任何人的真实凭据。
   *
   * 最要紧的一条断言在最后：**库里那条连接不许有密码引用**。
   * FinalShell 的密码解不出来（理由见 services/finalshellImport.ts），
   * 所以正确行为是"连接进来了、密码留空"；哪天有人接上一个猜的推导，这条会红。
   */
  const fsDir = join(tmpdir(), `ofs-fs-smoke-${Date.now()}`)
  mkdirSync(join(fsDir, 'conn'), { recursive: true })
  const fsConn = {
    id: 'smokeconn0000001',
    name: 'fs-smoke-conn',
    parent_id: 'smokegroup000001',
    host: '203.0.113.77',
    port: 50035,
    user_name: 'root',
    conection_type: 100,
    authentication_type: 2,
    // 形状与真实密文一致（8 字节头 + 3 个 DES 块），值是编的
    password: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    secret_key_id: 'smokekey00000001',
    proxy_id: '',
    terminal_encoding: 'GBK',
    description: '冒烟导入',
    port_forwarding_list: [],
    remote_port_forwarding: {},
    create_time: 1782610958947,
    modified_time: 1782611139179,
    access_time: 1785192866687
  }
  const fsGroup = {
    id: 'smokegroup000001',
    name: 'fs-smoke-group',
    parent_id: '',
    conection_type: 0,
    create_time: 1782610000000,
    modified_time: 1782610000001
  }
  writeFileSync(join(fsDir, 'conn', 'a_connection.json'), JSON.stringify(fsConn), 'utf8')
  writeFileSync(join(fsDir, 'conn', 'b_connection.json'), JSON.stringify(fsGroup), 'utf8')

  const fsImport = await evaluate(`
    const scan = await window.ofs.invoke('app:finalshellScan', { dir: ${JSON.stringify(fsDir)} })
    if (!scan) return { error: 'finalshellScan 返回了 null（没有弹对话框时不该发生）' }
    const r = await window.ofs.invoke('app:finalshellImport', { token: scan.token, conflict: 'duplicate' })
    const { profiles, groups } = await window.ofs.invoke('conn:list')
    const p = profiles.find((x) => x.name === 'fs-smoke-conn')
    const g = groups.find((x) => x.name === 'fs-smoke-group')
    return {
      扫描: { profiles: scan.counts.profiles, groups: scan.counts.groups, locked: scan.counts.lockedPasswords },
      提示: scan.notes,
      结果: { profiles: r.profiles, groups: r.groups, secrets: r.secrets },
      连接: p
        ? {
            host: p.host,
            port: p.port,
            username: p.username,
            charset: p.terminal.charset,
            note: p.note,
            分组对得上: Boolean(g) && p.groupId === g.id,
            有密码引用: Boolean(p.auth.passwordRef),
            id: p.id
          }
        : null,
      分组id: g ? g.id : null
    }
  `)
  if (fsImport.error) fail(fsImport.error)
  if (fsImport.扫描.profiles !== 1 || fsImport.扫描.groups !== 1) {
    fail(`扫描结果不对：${JSON.stringify(fsImport.扫描)}`)
  }
  if (fsImport.扫描.locked !== 1) fail('没认出"有密码但解不开"那一条')
  if (!fsImport.提示.some((n) => n.includes('不会跟过来'))) {
    fail(`扫描没给出"密码不会跟过来"的说明：${JSON.stringify(fsImport.提示)}`)
  }
  if (!fsImport.连接) fail('导入之后连接树里找不到那条连接')
  if (fsImport.连接.host !== '203.0.113.77' || fsImport.连接.port !== 50035) {
    fail(`主机/端口没映射对：${JSON.stringify(fsImport.连接)}`)
  }
  if (fsImport.连接.username !== 'root') fail('user_name 没映射到 username')
  if (fsImport.连接.charset !== 'gbk') fail(`terminal_encoding=GBK 应映射成 gbk，实际 ${fsImport.连接.charset}`)
  if (fsImport.连接.note !== '冒烟导入') fail('description 没映射到备注')
  if (!fsImport.连接.分组对得上) fail('parent_id 没重建成本项目的分组层级')
  if (fsImport.连接.有密码引用) {
    fail('导入的连接竟然带了密码引用 —— FinalShell 的密码解不出来，正确行为是留空')
  }
  console.log(
    `OK FinalShell 导入：扫到 1 连接 + 1 分组 → 落库（GBK/备注/分组都对），密码留空（${fsImport.结果.secrets} 条写入密钥库）`
  )

  // 清掉冒烟造的那条连接与分组，再删临时目录
  await evaluate(`
    const { profiles, groups } = await window.ofs.invoke('conn:list')
    for (const p of profiles.filter((x) => x.name === 'fs-smoke-conn')) {
      await window.ofs.invoke('conn:delete', p.id)
    }
    for (const g of groups.filter((x) => x.name === 'fs-smoke-group')) {
      await window.ofs.invoke('group:delete', g.id)
    }
    return true
  `)
  rmSync(fsDir, { recursive: true, force: true })

  /*
   * 9.8) 已保存的代理与私钥：在真产物里走一遍"建 → 被连接引用 → 删被引用的被拦下"。
   *
   * 只有真产物能回答的两件事：那 6 条 channel 真的注册了（前缀漏进白名单的话
   * preload 会当场拦掉，而单测里 mock 的是 store 不是桥），以及**删除被引用时
   * 回来的是一份连接名清单而不是异常** —— 后者是整片设计里唯一一处"失败不抛错"的约定。
   */
  const refs = await evaluate(`
    const proxy = await window.ofs.invoke('proxy:save', {
      name: 'smoke-proxy', type: 'socks5', host: '127.0.0.1', port: 7891, password: 'smoke-pw'
    })
    const key = await window.ofs.invoke('key:save', {
      name: 'smoke-key', path: 'C:\\\\smoke\\\\id_ed25519', passphrase: 'smoke-pp'
    })
    // 明文一个字都不许回到界面层
    const leaked = JSON.stringify([proxy, key])
    const list = await window.ofs.invoke('proxy:list')

    // 建一条引用它们的连接
    const p = await window.ofs.invoke('conn:save', {
      name: 'smoke-refs', groupId: null, host: '127.0.0.1', port: ${sshPort}, username: 'test',
      auth: { method: 'privateKey', privateKeyId: key.id },
      terminal: { charset: 'utf-8', termType: 'xterm-256color' },
      options: { keepaliveInterval: 15000, readyTimeout: 10000, legacyAlgorithms: false,
                 autoReconnect: false, monitorEnabled: false, compress: false },
      proxyId: proxy.id
    })

    const blockedProxy = await window.ofs.invoke('proxy:delete', proxy.id)
    const blockedKey = await window.ofs.invoke('key:delete', key.id)

    // 把连接删掉，再删就该成功了
    await window.ofs.invoke('conn:delete', p.id)
    const afterProxy = await window.ofs.invoke('proxy:delete', proxy.id)
    const afterKey = await window.ofs.invoke('key:delete', key.id)

    return {
      建好了: Boolean(proxy.id && key.id),
      有明文: leaked.includes('smoke-pw') || leaked.includes('smoke-pp'),
      有引用: { proxyId: p.proxyId === proxy.id, keyId: p.auth.privateKeyId === key.id },
      列表里有: list.some((x) => x.id === proxy.id),
      blockedProxy, blockedKey, afterProxy, afterKey,
      剩下: (await window.ofs.invoke('proxy:list')).length
    }
  `)
  if (refs.error) fail(refs.error)
  if (!refs.建好了) fail('proxy:save / key:save 没建出记录')
  if (refs.有明文) fail('代理密码或私钥口令的明文回到了界面层 —— 只该回引用')
  if (!refs.列表里有) fail('proxy:list 里找不到刚建的那条')
  if (!refs.有引用.proxyId || !refs.有引用.keyId) {
    fail(`连接没带上引用：${JSON.stringify(refs.有引用)}`)
  }
  if (refs.blockedProxy.deleted !== false || !refs.blockedProxy.usedBy?.includes('smoke-refs')) {
    fail(`删被引用的代理应被拦下并列出连接名，实际：${JSON.stringify(refs.blockedProxy)}`)
  }
  if (refs.blockedKey.deleted !== false || !refs.blockedKey.usedBy?.includes('smoke-refs')) {
    fail(`删被引用的私钥应被拦下并列出连接名，实际：${JSON.stringify(refs.blockedKey)}`)
  }
  if (refs.afterProxy.deleted !== true || refs.afterKey.deleted !== true) {
    fail('没人引用之后应该删得掉')
  }
  console.log('OK 代理与私钥：建→被引用→删被拦下（列出连接名）→改完再删成功，明文不回传')

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
