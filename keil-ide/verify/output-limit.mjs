#!/usr/bin/env node
/**
 * Output-limit acceptance — the "unlimited tokens, character budget" policy.
 *
 *   A. no token cap: the request body has NO `max_tokens` (provider's own limit),
 *      so thinking models cannot be cut off before writing an answer;
 *   B. runaway guard: with `maxOutputChars = 500` the stream is stopped early,
 *      the upstream is cancelled, and `done` says finishReason "chars" with the
 *      real character counts;
 *   C. `maxOutputChars = 0` means unlimited: the whole (long) answer arrives;
 *   D. a legacy explicit token cap still goes out as `max_tokens`;
 *   E. the live UI shows the character-cap notice and keeps the partial text.
 *
 * Usage: node verify/output-limit.mjs [serverPort] [chromePort] [mockPort]
 *   (self-contained: starts its own IDE server with a temp settings file)
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const serverPort = process.argv[2] ?? '4893'
const chromePort = process.argv[3] ?? '9339'
const mockPort = process.argv[4] ?? '4907'
const base = `http://127.0.0.1:${serverPort}`
const mockBase = `http://127.0.0.1:${mockPort}/v1`
const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (url, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok) return true
    await sleep(200)
  }
  return false
}

const workDir = await mkdtemp(join(tmpdir(), 'keil-output-limit-'))
const settingsFile = join(workDir, 'settings.json')
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: appDir,
  env: { ...process.env, KEIL_IDE_PORT: serverPort, KEIL_IDE_SETTINGS: settingsFile },
  stdio: 'ignore',
  windowsHide: true,
})
const mock = spawn(process.execPath, [join(here, 'mock-openai.mjs'), mockPort], {
  stdio: 'ignore',
  env: { ...process.env, MOCK_LONG: '1' },
  windowsHide: true,
})
process.on('exit', () => {
  server.kill()
  mock.kill()
})

if (!(await waitFor(`${base}/api/health`))) {
  console.error(`server did not start on ${base}`)
  process.exit(2)
}
if (!(await waitFor(`${mockBase}/models`))) {
  console.error('mock did not start')
  process.exit(2)
}

const postSettings = (body) =>
  fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json())

/** One streamed chat; returns the accumulated text and the `done` frame. */
const chat = async (prompt) => {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ prompt, project: '' }),
  })
  const raw = await response.text()
  let text = ''
  let done = null
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const payload = JSON.parse(line.slice(5).trim())
      if (payload.delta) text += payload.delta
      if (payload.done) {
        done = payload
        // The done frame carries the authoritative (trimmed) text.
        if (payload.text) text = payload.text
      }
    } catch {
      // ignore partial frames
    }
  }
  return { text, done }
}
const lastRequest = () => fetch(`http://127.0.0.1:${mockPort}/last-request`).then((response) => response.json())

/* ---------- A + B: no token cap, character guard stops a runaway ---------- */

await postSettings({ ai: { baseURL: mockBase, model: 'mock-c51-model', maxTokens: 0, maxOutputChars: 500, stream: true } })
let result = await chat('写一段很长的东西')
let request = await lastRequest()
check('no max_tokens is sent when the cap is 0', 'max_tokens' in request, false)
check('runaway answer is cut early', result.done?.finishReason, 'chars')
check('the cap is reported', result.done?.truncated === true && result.done?.limit === 500, true)
check('it stops exactly at the cap', result.text.length, 500)
check('done reports both character counts', result.done?.contentChars === result.text.length, true)

/* ---------- C: 0 = unlimited ---------- */

await postSettings({ ai: { maxOutputChars: 0 } })
result = await chat('再来一段长的')
request = await lastRequest()
check('0 means unlimited: nothing is cut', result.done?.finishReason, 'stop')
check('the whole long answer arrives', result.text.length >= 4000, true)
check('no character note fields when unlimited', result.done?.truncated ?? false, false)

/* ---------- D: an explicit token cap still works ---------- */

await postSettings({ ai: { maxTokens: 300 } })
await chat('带上词元上限')
request = await lastRequest()
check('explicit token cap goes out as max_tokens', request.max_tokens, 300)

/* ---------- E: the UI explains the forced stop ---------- */

await postSettings({ ai: { maxTokens: 0, maxOutputChars: 500 } })
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
const profile = join(tmpdir(), `dsh-chrome-output-limit-${chromePort}`)
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
  await sleep(250)
}
if (!target) {
  console.error('no page target')
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
    await sleep(200)
  }
  return false
}

check(
  'page booted',
  await until(`document.readyState === 'complete' && typeof document.getElementById('btn-settings').onclick === 'function'`),
  true,
)
await evaluate(`(() => {
  document.getElementById('prompt').value = '从我口界面来一段超长回答'
  document.getElementById('btn-send').click()
  return true
})()`)
check('streamed answer settles', await until(`!document.getElementById('btn-send').disabled`), true)
await sleep(400)
const ui = await evaluate(`(() => {
  const boxes = [...document.querySelectorAll('#transcript .msg.ai')]
  const box = boxes[boxes.length - 1]
  return {
    text: box.querySelector('.md').innerText.length,
    note: [...box.querySelectorAll('.md-note')].map((node) => node.textContent).join('\\n'),
  }
})()`)
check('the UI keeps the partial answer', ui.text > 300, true)
check('the UI explains the forced stop', /输出字符上限/.test(ui.note), true)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(here, 'screenshot-output-limit.png'), Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-output-limit.png')
}

await rm(profile, { recursive: true, force: true }).catch(() => undefined)
await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
server.kill()
mock.kill()
process.exit(failed ? 1 : 0)
