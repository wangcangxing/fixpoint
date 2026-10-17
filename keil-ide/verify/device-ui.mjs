#!/usr/bin/env node
/**
 * Device picker UI acceptance (headless Chrome + CDP):
 *   1. the new-project dialog opens
 *   2. the device field really loads the local Keil library
 *   3. typing filters the list
 *   4. picking AT89C52 shows its cdb memory / header / description
 *   5. capture a screenshot of the picker
 *
 * Usage: node verify/device-ui.mjs [serverPort] [chromePort]
 *   (expects a server started with KEIL_IDE_PORT=<serverPort>; default 4898)
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const serverPort = process.argv[2] ?? '4898'
const chromePort = process.argv[3] ?? '9333'
const server = `http://127.0.0.1:${serverPort}`

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}

const health = await fetch(`${server}/api/health`).catch(() => undefined)
if (!health?.ok) {
  console.error(`no IDE server on ${server} — start one with KEIL_IDE_PORT=${serverPort}`)
  process.exit(2)
}

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const { existsSync } = await import('node:fs')
const chrome = chromeCandidates.find((path) => existsSync(path))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}

const profile = join(tmpdir(), `dsh-chrome-device-${chromePort}`)
await rm(profile, { recursive: true, force: true }).catch(() => undefined)
await mkdir(profile, { recursive: true })

const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${process.env.UI_WIDTH ?? 1280},${process.env.UI_HEIGHT ?? 900}`,
    server,
  ],
  { stdio: 'ignore', windowsHide: true },
)
process.on('exit', () => browser.kill())

/** Poll the CDP HTTP endpoint until a page target exists. */
let target
for (let attempt = 0; attempt < 60; attempt += 1) {
  const targets = await fetch(`http://127.0.0.1:${chromePort}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((entry) => entry.type === 'page')
  if (target) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!target) {
  console.error('no page target from Chrome')
  process.exit(2)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve) => {
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

check('page loaded', await until(`document.readyState === 'complete' && !!document.getElementById('btn-new-project')`), true)
await evaluate(`document.getElementById('btn-new-project').click(); true`)
check('dialog opens', await until(`!document.getElementById('new-project').classList.contains('hidden')`), true)
// openNewProject() auto-selects AT89C51, which both hides the menu and proves the
// library load reached the picker.
check(
  'device library loaded (AT89C51 summary)',
  await until(`/ROM 0x1000 \\/ RAM 0x80/.test(document.getElementById('np-device-info').textContent)`),
  true,
)

// Show the whole list, then prove it is really visible: a rect can look fine while
// an ancestor's `overflow: hidden` still clips it, so hit-test the bottom edge.
await evaluate(`(() => {
  const input = document.getElementById('np-device')
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
  return true
})()`)
await new Promise((resolve) => setTimeout(resolve, 300))
const menuMetrics = await evaluate(`(() => {
  const menu = document.getElementById('np-device-menu')
  const rect = menu.getBoundingClientRect()
  const box = document.querySelector('#new-project .modal-box').getBoundingClientRect()
  const hit = document.elementFromPoint(
    Math.round(rect.left + rect.width / 2),
    Math.min(Math.round(rect.bottom - 4), window.innerHeight - 1),
  )
  return {
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    height: Math.round(rect.height),
    boxBottom: Math.round(box.bottom),
    viewport: window.innerHeight,
    items: menu.querySelectorAll('.item[data-name]').length,
    insideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
    hitInsideMenu: !!hit && !!hit.closest('#np-device-menu'),
  }
})()`)
console.log(`      menu: ${JSON.stringify(menuMetrics)}`)
check('menu has items', menuMetrics.items > 0, true)
check('menu is fully inside the viewport', menuMetrics.insideViewport, true)
check('menu is not clipped by the dialog', menuMetrics.hitInsideMenu, true)
const moreText = await evaluate(`document.querySelector('#np-device-menu .item.more')?.textContent ?? ''`)
check('truncated list says how many exist', /共 1703 个器件/.test(moreText), true)
const menuShot = await send('Page.captureScreenshot', { format: 'png' })
if (menuShot?.data) {
  await writeFile('verify/screenshot-device-menu.png', Buffer.from(menuShot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-device-menu.png')
}

await evaluate(`(() => {
  const input = document.getElementById('np-device')
  input.value = 'AT89C52'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await new Promise((resolve) => setTimeout(resolve, 250))
const names = await evaluate(
  `[...document.querySelectorAll('#np-device-menu .item[data-name]')].map((item) => item.dataset.name).slice(0, 6)`,
)
check('typing filters the list', names.includes('AT89C52'), true)

await evaluate(`(() => {
  const item = [...document.querySelectorAll('#np-device-menu .item')].find((entry) => entry.dataset.name === 'AT89C52')
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return true
})()`)
await new Promise((resolve) => setTimeout(resolve, 600))
const info = await evaluate(`document.getElementById('np-device-info').textContent`)
const picked = await evaluate(`document.getElementById('np-device').value`)
check('selection sets the input', picked, 'AT89C52')
check('selection shows cdb memory', /ROM 0x2000 \/ RAM 0x100/.test(info), true)
check('selection shows vendor + header', /Atmel/.test(info) && /REGX52\.H/.test(info), true)
check('selection shows the description', /8051-based|8051 based/i.test(info), true)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile('verify/screenshot-device-picker.png', Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-device-picker.png')
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
process.exit(failed ? 1 : 0)
