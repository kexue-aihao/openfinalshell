// Equivalent local terminal harness, not the full product shell.
const { app, BrowserWindow, ipcMain } = require('electron')
const { Client } = require('ssh2')
const fs = require('node:fs')
const path = require('node:path')
const seconds = Number(process.env.OFS_TERMINAL_STRESS_SECONDS || 60)
const port = Number(process.env.OFS_TERMINAL_STRESS_PORT || 22349)
const output = path.resolve(process.env.OFS_ELECTRON_REPORT || 'build/terminal-electron-reference.json')
const repository = path.resolve(__dirname, '..').replaceAll('\\', '/')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1000, height: 650, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
  const sessions = [], failures = [], memory = []
  ipcMain.on('ack', (_, index, count) => { const s = sessions[index]; if (!s) return; s.pending = Math.max(0, s.pending - count); if (s.pending < 256 * 1024) s.channel?.resume() })
  ipcMain.on('input', (_, index, data) => sessions[index]?.channel?.write(data))
  const html = [
    '<!doctype html><link rel="stylesheet" href="' + repository + '/node_modules/@xterm/xterm/css/xterm.css">',
    '<style>body{background:#10151d;color:white;margin:0}.term{height:520px;width:98vw}#settings{display:none}</style>',
    '<div id="status">Electron reference</div><div id="terms"></div><div id="settings">Settings <input type="range"></div><script>',
    'const {ipcRenderer}=require("electron");const {Terminal}=require(' + JSON.stringify(repository + '/node_modules/@xterm/xterm') + ');',
    'const {FitAddon}=require(' + JSON.stringify(repository + '/node_modules/@xterm/addon-fit') + ');',
    'const {SearchAddon}=require(' + JSON.stringify(repository + '/node_modules/@xterm/addon-search') + ');',
    'const terms=[],fits=[],searches=[],latencies=[];let actions=0,searchCount=0;',
    'for(let i=0;i<3;i++){const node=document.createElement("div");node.className="term";document.getElementById("terms").append(node);',
    'const t=new Terminal({cols:105,rows:29,scrollback:5000});const f=new FitAddon();const s=new SearchAddon();t.loadAddon(f);t.loadAddon(s);t.open(node);f.fit();terms.push(t);fits.push(f);searches.push(s);t.onData(data=>ipcRenderer.send("input",i,data));node.style.display=i===0?"block":"none";}',
    'ipcRenderer.on("data",(_,index,bytes)=>{const data=new Uint8Array(bytes);terms[index].write(data,()=>ipcRenderer.send("ack",index,data.byteLength));});',
    'let expected=performance.now()+16;const heartbeat=setInterval(()=>{const now=performance.now();latencies.push(Math.max(0,now-expected));expected=now+16;},16);',
    'const interactions=setInterval(()=>{actions++;const index=actions%4;terms.forEach((t,i)=>t.element.parentElement.style.display=i===index?"block":"none");document.getElementById("settings").style.display=index===3?"block":"none";',
    'if(actions%5===0)ipcRenderer.send("input",1,"echo ordinary-session\\r");if(actions%7===0){searches[0].findNext("fixture");searchCount++;}if(actions%11===0)fits.forEach(f=>f.fit());},1000);',
    'window.report=()=>{clearInterval(heartbeat);clearInterval(interactions);latencies.sort((a,b)=>a-b);return {actions,searchCount,samples:latencies.length,p99:latencies[Math.ceil(latencies.length*.99)-1],max:latencies.at(-1)};};</script>'
  ].join('\n')
  const fixtureFile = path.join(path.dirname(output), 'terminal-electron-reference.html')
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(fixtureFile, html)
  await window.loadFile(fixtureFile)
  for (let index = 0; index < 3; index++) {
    const s = { client: new Client(), channel: null, pending: 0, highWater: 0, bytes: 0 }; sessions.push(s)
    await new Promise((resolve, reject) => {
      s.client.on('ready', () => s.client.shell({ cols: 105, rows: 29 }, (error, channel) => {
        if (error) return reject(error)
        s.channel = channel
        channel.on('data', bytes => { s.bytes += bytes.length; s.pending += bytes.length; s.highWater = Math.max(s.highWater, s.pending); window.webContents.send('data', index, bytes); if (s.pending > 1024 * 1024) channel.pause() })
        channel.on('error', error => failures.push(error.message)); resolve()
      })).on('error', reject).connect({ host: '127.0.0.1', port, username: 'test', password: 'test123', hostVerifier: () => true })
    })
  }
  sessions[0].channel.write('replay 10000000 10 32768\r'); sessions[2].channel.write('replay 10000000 100 13\r')
  const sampler = setInterval(() => memory.push(app.getAppMetrics().reduce((total, p) => total + p.memory.privateBytes, 0)), 1000)
  setTimeout(async () => {
    clearInterval(sampler); const report = await window.webContents.executeJavaScript('window.report()'); const closeStarted = performance.now()
    for (const s of sessions) { s.channel.close(); s.client.end() }
    fs.writeFileSync(output, JSON.stringify({ seconds, ...report, closeMs: performance.now() - closeStarted, sessions: sessions.map(({ bytes, highWater, pending }) => ({ bytes, highWater, pending })), memory, failures }, null, 2))
    window.destroy(); app.quit()
  }, seconds * 1000)
}).catch(error => { console.error(error); app.exit(1) })
