#!/usr/bin/env node
/**
 * Pane layout acceptance (headless Chrome + CDP):
 *   1. dragging the file-tree splitter resizes that column
 *   2. dragging the AI splitter resizes the AI column (editor takes the rest)
 *   3. the AI panel minimises to a narrow rail, not disappearing
 *   4. the rail button restores it to the previous width
 *   5. widths and the minimised flag survive a page reload (localStorage)
 *
 * Usage: node verify/panes-ui.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4890
const chromePort = 9336
const base = `http://127.0.0.1:${port}`
const settingsPath = join(tmpdir(), `keil-panes-settings-${Date.now()}.json`)

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}
const near = (actual, expected, tolerance = 4) => Math.abs(actual - expected) <= tolerance
const waitFor = async (url, attempts = 60) => {
  for (let index = 0; index < attempts; index += 1) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}

const server = spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
  cwd: join(root, 'keil-ide'),
  env: { ...process.env, KEIL_IDE_PORT: String(port), KEIL_IDE_SETTINGS: settingsPath, KEIL_IDE_INLINE: '0' },
  stdio: 'ignore',
  windowsHide: true,
})
process.on('exit', () => server.kill())
if (!(await waitFor(`${base}/api/health`))) {
  console.error(`could not start the host on ${port}`)
  process.exit(2)
}

const { existsSync } = await import('node:fs')
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}
const profile = join(tmpdir(), `dsh-chrome-panes-${chromePort}`)
await rm(profile, { recursive: true, force: true }).catch(() => undefined)
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    base,
  ],
  { stdio: 'ignore', windowsHide: true },
)
process.on('exit', () => browser.kill())

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
const sendCdp = (method, params = {}) =>
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
  const result = await sendCdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
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
const widths = () =>
  evaluate(`(() => ({
    files: Math.round(document.getElementById('pane-files').getBoundingClientRect().width),
    chat: Math.round(document.getElementById('pane-chat').getBoundingClientRect().width),
    editor: Math.round(document.querySelector('.pane.editor').getBoundingClientRect().width),
    minimized: document.getElementById('pane-chat').classList.contains('minimized'),
  }))()`)

const drag = async (id, dx) => {
  await evaluate(`(() => {
    const handle = document.getElementById(${JSON.stringify(id)})
    const rect = handle.getBoundingClientRect()
    const x = Math.round(rect.left + rect.width / 2)
    const y = Math.round(rect.top + 40)
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + ${dx}, clientY: y, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + ${dx}, clientY: y, pointerId: 1 }))
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 150))
}

check('page booted', await until(`typeof initPanes === 'function' && !!document.getElementById('pane-chat')`), true)
// Start from the defaults so drag deltas are predictable.
await evaluate(`localStorage.removeItem('fixpoint.panes.v1'); location.reload(); true`)
await until(`document.readyState === 'complete' && !!document.getElementById('pane-chat')`)
await new Promise((resolve) => setTimeout(resolve, 800))

const start = await widths()
console.log(`      start: ${JSON.stringify(start)}`)
check('three columns laid out', start.files > 100 && start.chat > 200 && start.editor > 300, true)

await drag('split-files', 60)
const afterFiles = await widths()
console.log(`      after files +60: ${JSON.stringify(afterFiles)}`)
check('file column follows the splitter', near(afterFiles.files, start.files + 60), true)
check('editor gives up the space', near(afterFiles.editor, start.editor - 60), true)

await drag('split-chat', -60)
const afterChat = await widths()
console.log(`      after chat -60: ${JSON.stringify(afterChat)}`)
check('AI column follows the splitter', near(afterChat.chat, afterFiles.chat + 60), true)
check('editor gives up the space again', near(afterChat.editor, afterFiles.editor - 60), true)

const chatWidth = afterChat.chat
await evaluate(`document.getElementById('btn-chat-min').click(); true`)
await until(`document.getElementById('pane-chat').classList.contains('minimized')`)
await new Promise((resolve) => setTimeout(resolve, 300))
const minimized = await widths()
console.log(`      minimized: ${JSON.stringify(minimized)}`)
check('AI panel collapses to a rail', minimized.chat <= 48, true)
check('editor takes the freed width', minimized.editor > afterChat.editor + 100, true)
check('rail restore button is visible', await evaluate(`getComputedStyle(document.getElementById('btn-chat-restore')).display !== 'none'`), true)

const shot = await sendCdp('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile('verify/screenshot-panes.png', Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-panes.png')
}

// Reload while minimised: the rail (and the widths) must come back.
await evaluate(`location.reload(); true`)
await until(`document.readyState === 'complete' && !!document.getElementById('pane-chat')`)
await new Promise((resolve) => setTimeout(resolve, 900))
const reloaded = await widths()
console.log(`      after reload: ${JSON.stringify(reloaded)}`)
check('minimised state survives reload', reloaded.minimized, true)
check('file width survives reload', near(reloaded.files, afterFiles.files), true)

await evaluate(`document.getElementById('btn-chat-restore').click(); true`)
await until(`!document.getElementById('pane-chat').classList.contains('minimized')`)
await new Promise((resolve) => setTimeout(resolve, 300))
const restored = await widths()
console.log(`      restored: ${JSON.stringify(restored)}`)
check('restore brings back the previous width', near(restored.chat, chatWidth), true)
check('editor shrinks back', restored.editor < reloaded.editor, true)

// ---- up/down resizing ----------------------------------------------------
const heights = () =>
  evaluate(`(() => ({
    transcript: Math.round(document.getElementById('transcript').getBoundingClientRect().height),
    controls: Math.round(document.querySelector('.chat-controls').getBoundingClientRect().height),
    problems: Math.round(document.getElementById('pane-problems').getBoundingClientRect().height),
    editor: Math.round(document.querySelector('.pane.editor').getBoundingClientRect().height),
  }))()`)
const dragY = async (id, dy) => {
  await evaluate(`(() => {
    const handle = document.getElementById(${JSON.stringify(id)})
    const rect = handle.getBoundingClientRect()
    const x = Math.round(rect.left + 40)
    const y = Math.round(rect.top + rect.height / 2)
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y + ${dy}, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y + ${dy}, pointerId: 1 }))
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 200))
}

const beforeVertical = await heights()
console.log(`      before vertical: ${JSON.stringify(beforeVertical)}`)
await dragY('split-reply', 80)
const afterReply = await heights()
console.log(`      after reply +80: ${JSON.stringify(afterReply)}`)
check('reply area grows downwards', near(afterReply.transcript, beforeVertical.transcript + 80), true)
check('input block gives up the height', afterReply.controls < beforeVertical.controls, true)

await dragY('split-problems', -60)
const afterProblems = await heights()
console.log(`      after problems -60: ${JSON.stringify(afterProblems)}`)
check('problems pane grows upwards', near(afterProblems.problems, beforeVertical.problems + 60), true)
check('editor gives up the height', near(afterProblems.editor, beforeVertical.editor - 60), true)

// Reload: both vertical sizes must stick.
await evaluate(`location.reload(); true`)
await until(`document.readyState === 'complete' && !!document.getElementById('pane-chat')`)
await new Promise((resolve) => setTimeout(resolve, 900))
const verticalReloaded = await heights()
console.log(`      vertical after reload: ${JSON.stringify(verticalReloaded)}`)
check('reply height survives reload', near(verticalReloaded.transcript, afterReply.transcript), true)
check('problems height survives reload', near(verticalReloaded.problems, afterProblems.problems), true)

// Double-click resets a vertical splitter to its responsive default.
await evaluate(`document.getElementById('split-problems').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`)
await new Promise((resolve) => setTimeout(resolve, 300))
const resetProblems = await heights()
console.log(`      after reset: ${JSON.stringify(resetProblems)}`)
check('double-click resets the problems height', resetProblems.problems < afterProblems.problems - 20, true)

const shot2 = await sendCdp('Page.captureScreenshot', { format: 'png' })
if (shot2?.data) {
  await writeFile('verify/screenshot-panes-vertical.png', Buffer.from(shot2.data, 'base64'))
  console.log('      screenshot: verify/screenshot-panes-vertical.png')
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
server.kill()
process.exit(failed ? 1 : 0)
