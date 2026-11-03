// Real Electron renderer/CSP/preload smoke. All settings and profiles are isolated.
// Usage: node scripts/uiSmoke.mjs baseline|after [packaged executable]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const stage = process.argv[2] ?? 'after'
if (!/^[a-z-]+$/.test(stage)) throw new Error('Invalid output label')
const output = resolve('.local/ui-refresh', stage)
mkdirSync(output, { recursive: true })
const port = 19300 + process.pid % 1000
const dataDir = join(tmpdir(), `ofs-ui-${process.pid}`)
const executable = process.argv[3] ?? require('electron')
const args = [...(process.argv[3] ? [] : [resolve(process.env.OFS_UI_APP_DIR ?? '.')]), `--remote-debugging-port=${port}`, `--user-data-dir=${dataDir}`]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let processLog = ''
app.stderr.on('data', (chunk) => { processLog += chunk.toString() })
app.stdout.on('data', (chunk) => { processLog += chunk.toString() })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const pending = new Map()
let socket, sequence = 0
const errors = [], measurements = []
const performanceSamples = []
const sockets = []
const assertions = []
let fixture
let passed = false
let failure
function assert(condition, message) {
  if (!condition) throw new Error(message)
  assertions.push(message)
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  await new Promise((r, reject) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id)
      clearTimeout(p.timeout)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
    } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails)
    else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry)
  })
  return ws
}
async function send(method, params = {}) {
  return new Promise((resolveCall, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve: resolveCall, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`return !!(${expression})`)) return
    await pause(150)
  }
  throw new Error(`UI not ready: ${expression}`)
}
async function patchSettings(patch) {
  await evaluate(`const current=await window.ofs.invoke('settings:get'); await window.ofs.invoke('settings:set', ${JSON.stringify(patch)}, current)`)
  await pause(200)
}
async function shot(name) {
  await pause(250)
  const png = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(output, `${name}.png`), Buffer.from(png.data, 'base64'))
  measurements.push({ name, ...await evaluate(`return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,heap:performance.memory?.usedJSHeapSize,theme:document.documentElement.dataset.theme}`) })
}
async function clickButton(label) {
  const ok = await evaluate(`const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)} || b.textContent.trim()===${JSON.stringify(label)}); if(!button)return false; button.focus(); button.click();return true`)
  assert(ok, `Button available: ${label}`)
  await pause(250)
}
async function closeModal() {
  await evaluate(`const wrap=[...document.querySelectorAll('.ant-modal-wrap')].find(w=>getComputedStyle(w).display!=='none');wrap?.querySelector('.ant-modal-close')?.click()`)
  await pause(400)
}
async function idleSample() {
  await send('Performance.enable')
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  for(let i=0;i<3;i++) {
    const before=await metrics()
    await pause(1000)
    const after=await metrics()
    performanceSamples.push({taskMs:(after.TaskDuration-before.TaskDuration)*1000,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,heap:after.JSHeapUsedSize})
  }
}
try {
  let target
  for (let i = 0; i < 80 && !target; i++) {
    await pause(250)
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page') } catch { /* starting */ }
  }
  if (!target) throw new Error('Electron did not expose a page target')
  socket = await connect(target)
  const mainSocket = socket
  await send('Runtime.enable')
  await send('Log.enable')
  await waitFor('window.ofs && document.querySelector("nav button")')
  await patchSettings({ language: 'en-US', aiAssistantEnabled: true })
  await closeModal()
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  for (const themeMode of ['dark', 'light']) {
    await patchSettings({ themeMode })
    await shot(`welcome-${themeMode}`)
  }
  await idleSample()
  await clickButton('Settings')
  await waitFor('document.querySelector(".ant-modal-body")')
  await shot('settings-light')
  if (!stage.startsWith('baseline')) {
    await evaluate(`const item=[...document.querySelectorAll('.ant-menu-item')].find(e=>e.textContent.trim()==='Appearance');if(!item)throw new Error('Appearance section missing');item.click()`)
    await shot('settings-appearance-light')
    await patchSettings({ themeMode: 'dark' })
    await shot('settings-appearance-dark')
    await patchSettings({ themeMode: 'light' })
    await evaluate(`document.querySelectorAll('.ant-menu-item')[0].click()`)
  }
  await closeModal()
  assert(await evaluate(`return document.activeElement?.getAttribute('aria-label')==='Settings'`), 'Settings restores trigger focus')
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('New connection'))?.click()`)
  await waitFor('document.querySelector(".ant-drawer-body")')
  await shot('connection-light')
  await evaluate(`document.querySelector('.ant-drawer-close')?.click()`)
  await pause(400)
  await evaluate(`document.querySelector('button[aria-label="Transfers"]')?.click()`)
  await shot('transfers-light')
  if (!stage.startsWith('baseline')) {
    for (const themeMode of ['dark', 'light']) {
      for (const accent of ['#1677ff','#13c2c2','#52c41a','#faad14','#fa8c16','#f5222d','#eb2f96','#722ed1']) {
        await patchSettings({ themeMode, accent })
        await shot(`${themeMode}-${accent.slice(1)}`)
      }
    }
    await patchSettings({ accent: '#1677ff', themeMode: 'dark' })
    for (const [width, height] of [[940,600],[1440,900],[1920,1080]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      for (const uiZoom of [90,100,125,150]) {
        await patchSettings({ uiZoom })
        await shot(`layout-${width}-${uiZoom}`)
        assert(await evaluate(`const main=document.querySelector('main');return !!main && main.getBoundingClientRect().height>40 && document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`), `Workspace reachable: ${width}px / ${uiZoom}%`)
      }
    }
    await patchSettings({ uiZoom:100 })
    await send('Emulation.setDeviceMetricsOverride', { width: 940, height: 600, deviceScaleFactor: 1, mobile: false })
    await patchSettings({ uiZoom:150 })
    await clickButton('Settings')
    await shot('settings-minimum-150')
    assert(await evaluate(`const dialog=[...document.querySelectorAll('.ant-modal')].find(e=>e.getBoundingClientRect().height>0);const box=dialog.getBoundingClientRect();return box.bottom<=innerHeight+1 && box.right<=innerWidth+1`), 'Settings fits minimum window at 150%')
    await closeModal()
    await clickButton('New connection')
    await pause(350)
    await shot('connection-minimum-150')
    assert(await evaluate(`const box=document.querySelector('.ant-drawer-open .ant-drawer-content').getBoundingClientRect();return box.bottom<=innerHeight+1 && box.right<=innerWidth+1`),'Connection editor fits minimum window at 150%')
    await evaluate(`document.querySelector('.ant-drawer-close')?.click()`)
    await pause(350)
    await patchSettings({ uiZoom:100 })
    await send('Emulation.setDeviceMetricsOverride', { width:1440,height:900,deviceScaleFactor:1,mobile:false })
    for (const language of ['en-US','zh-CN','zh-TW','ja-JP','ko-KR','ru-RU','es-ES','fr-FR','de-DE','pt-BR']) {
      const locale = JSON.parse(readFileSync(resolve('src/shared/locales', `${language}.json`), 'utf8'))
      await patchSettings({ language })
      await waitFor(`document.querySelector('button[aria-label='+${JSON.stringify(JSON.stringify(locale.activity.settings))}+']')`)
      await clickButton(locale.activity.settings)
      await shot(`settings-${language}`)
      await closeModal()
      await clickButton(locale.welcome.newConnection)
      await shot(`connection-${language}`)
      await evaluate(`document.querySelector('.ant-drawer-close')?.click()`)
      await pause(350)
    }
    await patchSettings({ language:'en-US' })
    await clickButton('AI Assistant')
    await shot('ai-dark')
    await closeModal()
    for (const features of [[{name:'prefers-reduced-motion',value:'reduce'}],[{name:'prefers-reduced-transparency',value:'reduce'}],[{name:'prefers-contrast',value:'more'}],[{name:'forced-colors',value:'active'}]]) {
      await send('Emulation.setEmulatedMedia',{features})
      await shot(features[0].name)
      if(features[0].name!=='prefers-reduced-motion') assert(await evaluate(`return [...document.querySelectorAll('nav,aside')].every(e=>getComputedStyle(e).backdropFilter==='none')`), `${features[0].name}: glass disabled`)
    }
    await send('Emulation.setEmulatedMedia',{features:[]})

    // Fixture is loopback-only and all files live in a new temporary directory.
    const filesDir = mkdtempSync(join(tmpdir(), 'ofs-ui-files-'))
    writeFileSync(join(filesDir,'demo.conf'), '# UI regression fixture\nport = 3306\n')
    const sshPort = port + 1000
    fixture = spawn(process.execPath, ['test/fixtures/testSshServer.mjs', String(sshPort), filesDir], { windowsHide:true,stdio:['ignore','pipe','pipe'] })
    let fixtureReady = false
    fixture.stdout.on('data', (d) => { if(d.toString().includes('listening')) fixtureReady=true })
    fixture.stderr.on('data', (d) => { processLog += d.toString() })
    for(let i=0;i<80&&!fixtureReady;i++) await pause(100)
    assert(fixtureReady, 'Local SSH/SFTP fixture ready')
    await patchSettings({ layout:{activeSidebar:'connections',sidePanelCollapsed:false} })
    await evaluate(`
      window.__uiSessions=[];
      window.ofs.on('session:state',s=>{if(s.state==='ready')window.__uiSessions.push(s.sessionId)});
      window.__uiTerminalExits=0;
      window.ofs.on('term:exit',()=>window.__uiTerminalExits++);
      await window.ofs.invoke('conn:save',{name:'UI fixture',groupId:null,host:'127.0.0.1',port:${sshPort},username:'test',auth:{method:'password',password:'test123'},terminal:{charset:'utf-8',termType:'xterm-256color'},options:{keepaliveInterval:15000,readyTimeout:10000,legacyAlgorithms:false,autoReconnect:false,monitorEnabled:true,compress:false}});
    `)
    await waitFor(`[...document.querySelectorAll('span')].some(e=>e.textContent==='UI fixture')`)
    await evaluate(`const e=[...document.querySelectorAll('span')].find(e=>e.textContent==='UI fixture');e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Trust and save')`)
    await clickButton('Trust and save')
    await waitFor('document.querySelector(".xterm") && window.__uiSessions.length>0')
    await waitFor('document.querySelector("[class*=bigNumber]") && document.querySelector(".ant-table-row")')
    await shot('ssh-sftp-monitor-dark')
    const count = await evaluate(`window.__uiTerminalDOM=document.querySelector('.xterm');return document.querySelectorAll('.xterm').length`)
    await send('Page.bringToFront')
    await evaluate(`document.querySelector('button[aria-label="Close file manager"]').focus()`)
    assert(await evaluate(`return document.activeElement?.getAttribute('aria-label')==='Close file manager'`),'Toolbar button receives keyboard focus')
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13})
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await waitFor('document.querySelector(\'button[aria-label="Open file manager"]\')')
    assertions.push('Native toolbar button responds to keyboard Enter')
    for(let i=0;i<20;i++) {
      await patchSettings({themeMode:i%2?'dark':'light'})
      assert(await evaluate(`const b=document.querySelector('button[aria-label="Close file manager"],button[aria-label="Open file manager"]');if(!b)return false;b.click();return true`),'SFTP toggle is available')
      await pause(100)
      assert(await evaluate(`return document.querySelectorAll('.xterm').length===${count} && document.querySelector('.xterm')===window.__uiTerminalDOM && window.__uiTerminalExits===0`), `Terminal survives UI switch ${i+1}`)
    }
    await evaluate(`await window.ofs.invoke('editor:openFile',{sessionId:window.__uiSessions[0],path:'/demo.conf',origin:'UI fixture'})`)
    let editorTarget
    for(let i=0;i<60&&!editorTarget;i++) { await pause(150);editorTarget=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.includes('#/editor')) }
    assert(editorTarget,'Independent editor window available')
    socket=await connect(editorTarget)
    await send('Runtime.enable')
    await waitFor('document.querySelector(".cm-content")')
    await shot('editor-dark')
    socket=mainSocket
    await patchSettings({themeMode:'light'})
    await clickButton('Open file manager')
    await shot('ssh-sftp-monitor-light')
    socket=sockets.at(-1)
    await waitFor('document.documentElement.dataset.theme==="light"')
    await shot('editor-light')
    assert(await evaluate(`return document.querySelector('.cm-content').textContent.includes('3306')`),'Editor retains content after cross-window theme change')
    socket=mainSocket
  }
  if (errors.length) throw new Error(`${errors.length} renderer errors; see report.json`)
  passed = true
  console.log(`UI smoke passed: ${measurements.length} screenshots in ${output}`)
} catch (error) {
  failure = error.stack ?? String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify({ stage, passed, failure, dataDir, assertions, measurements, performanceSamples, errors }, null, 2))
  writeFileSync(join(output, 'electron.log'), processLog)
  for (const p of pending.values()) clearTimeout(p.timeout)
  for(const ws of sockets) ws.close()
  app.kill()
  fixture?.kill()
}
