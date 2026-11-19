#!/usr/bin/env node
/**
 * Flash dialog acceptance (headless Chrome + CDP). Self-contained: starts its
 * own IDE host, opens the page, clicks 烧录, and verifies the dialog is real —
 * engine version, COM list, cold-start banner, cancel button disabled, and the
 * settings tab. NO click on 开始烧录: that would write hardware without consent.
 *
 * Usage: node verify/flash-ui.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4886
const chromePort = 9338
const base = `http://127.0.0.1:${port}`
const work = await mkdtemp(join(tmpdir(), 'keil-flash-ui-'))
const home = join(work, 'home')
await mkdir(home, { recursive: true })

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

const children = []
process.on('exit', () => { for (const child of children) child.kill() })
children.push(
  spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
    cwd: join(root, 'keil-ide'),
    env: {
      ...process.env,
      USERPROFILE: home, HOME: home,
      KEIL_IDE_PORT: String(port),
      KEIL_IDE_SETTINGS: join(work, 'settings.json'),
      KEIL_IDE_AI_MODE: 'openai',
      KEIL_IDE_AI_BASEURL: 'http://127.0.0.1:9/v1',
      KEIL_IDE_AI_KEY: 'x',
      KEIL_IDE_INLINE: '0',
    },
    stdio: 'ignore', windowsHide: true,
  }),
)
const waitFor = async (url, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}
if (!(await waitFor(`${base}/api/health`))) {
  console.error(`no host on ${base}`)
  process.exit(2)
}

const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (!chrome) { console.error('no Chrome/Edge'); process.exit(2) }
const profile = join(tmpdir(), `dsh-chrome-flash-ui-${chromePort}`)
await mkdir(profile, { recursive: true })
children.push(spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`,
  '--window-size=1360,900', base,
], { stdio: 'ignore', windowsHide: true }))

let target
for (let attempt = 0; attempt < 80; attempt += 1) {
  const targets = await fetch(`http://127.0.0.1:${chromePort}/json`).then((r) => r.json()).catch(() => [])
  target = targets.find((entry) => entry.type === 'page')
  if (target) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!target) { console.error('no page target'); process.exit(2) }

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error)
    pending.delete(message.id)
  }
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result))
  return result?.result?.value
}
const until = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

check('page loaded', await until(`document.readyState === 'complete' && typeof openFlash === 'function'`), true)
check('工具栏有烧录按钮', await evaluate(`!!document.getElementById('btn-flash')`), true)

await evaluate(`document.getElementById('btn-flash').click(); true`)
check('弹层打开', await until(`!document.getElementById('flash-modal').classList.contains('hidden')`), true)
// openFlash() fills the status asynchronously; wait for the engine chip rather
// than asserting on the "检查中…" placeholder.
check('引擎版本显示', await until(`document.getElementById('flash-engine').textContent.includes('stcgal 1.10')`), true)
const ports = await evaluate(`document.getElementById('flash-port').options.length`)
check('COM 下拉非空（本机枚举到端口）', ports > 0, true)
check('波特率默认 115200', await evaluate(`document.getElementById('flash-baud').value`), '115200')
check('协议默认 auto', await evaluate(`document.getElementById('flash-protocol').value`), 'auto')
check('自动复位默认不勾', await evaluate(`document.getElementById('flash-autoreset').checked`), false)
check('冷启动提示常显', await evaluate(`/断电再上电/.test(document.getElementById('flash-tip').textContent)`), true)
check('开始前中止按钮禁用', await evaluate(`document.getElementById('btn-flash-cancel').disabled`), true)
check('开始前开始按钮可用', await evaluate(`!document.getElementById('btn-flash-start').disabled`), true)

// Closing with Escape must not touch the server (no write) and must hide the dialog.
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
check('Escape 关闭弹层', await evaluate(`document.getElementById('flash-modal').classList.contains('hidden')`), true)

// Settings tab carries the python path field.
await evaluate(`(() => { document.getElementById('btn-settings').click(); document.querySelector('.settings-tabs .tab[data-tab="flash"]').click(); return true })()`)
check('设置页烧录 tab 存在', await until(`document.querySelector('.settings-panes .pane-tab[data-pane="flash"]')?.classList.contains('active')`), true)
check('Python 路径字段存在', await evaluate(`!!document.getElementById('flash-python')`), true)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(root, 'keil-ide', 'verify', 'screenshot-flash-settings.png'), Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-flash-settings.png')
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
process.exit(failed ? 1 : 0)
