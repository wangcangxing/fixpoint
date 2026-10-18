#!/usr/bin/env node
/**
 * First-run acceptance (the bug every other user hit):
 *
 *   A. a brand-new settings.json seeds NO project and NO recent paths — the old
 *      build baked in the author's `E:\单片机\作业2\...`, so every other machine
 *      opened a file that is not there;
 *   B. a settings file that still points at a missing project is repaired in
 *      memory (project dropped, stale `recent` hidden) without rewriting the file
 *      on a read, and the next save persists the cleaned list;
 *   C. the live page shows the welcome/onboarding text instead of an error, and
 *      the project dropdown says there is no project yet.
 *
 * Usage: node verify/first-run.mjs [serverPort] [chromePort]
 *   (self-contained: it starts its own server with a temp settings file)
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const serverPort = process.argv[2] ?? '4895'
const chromePort = process.argv[3] ?? '9336'
const base = `http://127.0.0.1:${serverPort}`
const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

const waitFor = async (url, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

const workDir = await mkdtemp(join(tmpdir(), 'keil-first-run-'))
const settingsFile = join(workDir, 'settings.json')
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: appDir,
  env: { ...process.env, KEIL_IDE_PORT: serverPort, KEIL_IDE_SETTINGS: settingsFile },
  stdio: 'ignore',
  windowsHide: true,
})
process.on('exit', () => server.kill())

if (!(await waitFor(`${base}/api/health`))) {
  console.error(`server did not start on ${base}`)
  process.exit(2)
}

const getSettings = () => fetch(`${base}/api/settings`).then((response) => response.json())
const postSettings = (body) =>
  fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json())

/* ---------- A. fresh install ---------- */

let settings = await getSettings()
check('fresh install seeds no project', [settings.project, settings.recent], ['', []])
const seeded = JSON.parse(await readFile(settingsFile, 'utf8'))
check('the seeded file carries no personal path', [seeded.project, seeded.recent], ['', []])

/* ---------- B. a settings file from an older build ---------- */

// Must be a path that does NOT exist on this machine: the bug is exactly that the
// author's own E:\单片机\... existed there and nowhere else.
const LEGACY = 'C:\\__fixpoint_missing__\\作业2\\C program.uvproj'
const LEGACY_OTHER = 'C:\\__fixpoint_missing__\\作业1\\C program\\led.uvproj'
const legacy = {
  ...seeded,
  project: LEGACY,
  recent: [LEGACY, LEGACY_OTHER],
}
await writeFile(settingsFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
settings = await getSettings()
check('a missing project is dropped on read', settings.project, '')
check('stale recent entries are hidden', settings.recent, [])
const untouched = JSON.parse(await readFile(settingsFile, 'utf8'))
check('a read does not rewrite the file', untouched.project, LEGACY)

await postSettings({ ai: { temperature: 0.2 } })
const healed = JSON.parse(await readFile(settingsFile, 'utf8'))
check('the next save persists the cleaned project', [healed.project, healed.recent], ['', []])

/* ---------- C. the live page ---------- */

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

const profile = join(tmpdir(), `dsh-chrome-first-run-${chromePort}`)
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
    '--window-size=1280,900',
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
const until = async (expression, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

check(
  'page booted',
  await until(`document.readyState === 'complete' && typeof document.getElementById('btn-settings').onclick === 'function'`),
  true,
)
// The welcome text appears at the END of boot, so wait for it rather than assuming
// that bound buttons mean boot has finished.
check(
  'welcome text appears',
  await until(`document.getElementById('transcript').innerText.includes('欢迎使用 Fixpoint')`),
  true,
)
const page = await evaluate(`(() => {
  const transcript = document.getElementById('transcript')
  const select = document.getElementById('project')
  return {
    welcome: transcript.innerText.includes('欢迎使用 Fixpoint'),
    error: [...transcript.querySelectorAll('.msg.err, .err')].map((node) => node.textContent).join('\\n'),
    firstOption: select.options[0]?.textContent ?? '',
    options: select.options.length,
  }
})()`)
check('welcome text is shown', page.welcome, true)
check('no "cannot read project" error', page.error.trim(), '')
check('project dropdown says there is no project', page.firstOption, '（还没有打开工程）')
check('the dropdown has exactly the placeholder', page.options, 1)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(here, 'screenshot-first-run.png'), Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-first-run.png')
}

await rm(profile, { recursive: true, force: true }).catch(() => undefined)
await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
server.kill()
process.exit(failed ? 1 : 0)
