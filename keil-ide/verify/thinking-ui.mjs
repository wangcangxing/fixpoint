#!/usr/bin/env node
/**
 * Empty-reply / thinking acceptance.
 *
 * The reported bug: a thinking model (thinking on, effort LOW) passes "测试连接"
 * but the chat bubble comes out EMPTY. Cause: the provider streams the chain of
 * thought in `reasoning_content` and puts the answer in `content`; when thinking
 * eats the whole output budget, `content` is empty and `finish_reason` is
 * "length". The old client ignored `reasoning_content` entirely, so the only
 * content that arrived was thrown away and the bubble was blank.
 *
 *   A. thinking-only upstream (mock MOCK_THINKING_ONLY=1):
 *      the bubble must show the 思考过程 block + an explanation, not a blank.
 *   B. a normal upstream: the answer renders, and no 思考过程 block appears.
 *
 * Usage: node verify/thinking-ui.mjs [serverPort] [chromePort] [mockPort]
 *   (self-contained: starts its own IDE server with a temp settings file)
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const serverPort = process.argv[2] ?? '4894'
const chromePort = process.argv[3] ?? '9338'
const mockPort = process.argv[4] ?? '4906'
const mock2Port = String(Number(mockPort) + 1)
const base = `http://127.0.0.1:${serverPort}`
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

const workDir = await mkdtemp(join(tmpdir(), 'keil-thinking-'))
const settingsFile = join(workDir, 'settings.json')
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: appDir,
  env: { ...process.env, KEIL_IDE_PORT: serverPort, KEIL_IDE_SETTINGS: settingsFile },
  stdio: 'ignore',
  windowsHide: true,
})
const mock = spawn(process.execPath, [join(here, 'mock-openai.mjs'), mockPort], {
  stdio: 'ignore',
  env: { ...process.env, MOCK_THINKING_ONLY: '1' },
  windowsHide: true,
})
const mock2 = spawn(process.execPath, [join(here, 'mock-openai.mjs'), mock2Port], { stdio: 'ignore', windowsHide: true })
process.on('exit', () => {
  server.kill()
  mock.kill()
  mock2.kill()
})

if (!(await waitFor(`${base}/api/health`))) {
  console.error(`server did not start on ${base}`)
  process.exit(2)
}
if (!(await waitFor(`http://127.0.0.1:${mockPort}/v1/models`)) || !(await waitFor(`http://127.0.0.1:${mock2Port}/v1/models`))) {
  console.error('mock servers did not start')
  process.exit(2)
}

const postSettings = (body) =>
  fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json())

await postSettings({ ai: { baseURL: `http://127.0.0.1:${mockPort}/v1`, model: 'mock-c51-model' } })

/* ---------- browser ---------- */

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

const profile = join(tmpdir(), `dsh-chrome-thinking-${chromePort}`)
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
    await sleep(200)
  }
  return false
}

check(
  'page booted',
  await until(`document.readyState === 'complete' && typeof document.getElementById('btn-settings').onclick === 'function'`),
  true,
)

/** Type one prompt and wait for the streamed answer to settle. */
const ask = async (text) => {
  await evaluate(`(() => {
    document.getElementById('prompt').value = ${JSON.stringify(text)}
    document.getElementById('btn-send').click()
    return true
  })()`)
  return until(`!document.getElementById('btn-send').disabled && document.querySelectorAll('#transcript .msg.ai').length > 0`)
}

check('thinking-only reply arrives', await ask('帮我把呼吸灯改成分段亮度'), true)
await sleep(400)
const thinkOnly = await evaluate(`(() => {
  const boxes = [...document.querySelectorAll('#transcript .msg.ai')]
  const box = boxes[boxes.length - 1]
  const details = box.querySelector('details.think')
  return {
    hasThink: !!details,
    thinkText: details ? details.querySelector('pre').textContent : '',
    thinkOpen: details ? details.open : null,
    body: box.querySelector('.md').innerText,
    note: [...box.querySelectorAll('.md-note')].map((node) => node.textContent).join('\\n'),
    applyDisabled: document.getElementById('btn-apply').disabled,
  }
})()`)
console.log(`      thinking: ${JSON.stringify({ hasThink: thinkOnly.hasThink, thinkChars: thinkOnly.thinkText.length, note: thinkOnly.note.slice(0, 60) })}`)
check('thinking block is shown', thinkOnly.hasThink, true)
check('thinking block carries the chain of thought', thinkOnly.thinkText.includes('模拟思考过程'), true)
check('no blank "(空回复)" placeholder', thinkOnly.body.includes('(空回复)'), false)
check('an explanation is shown', /只返回了思考过程/.test(thinkOnly.note) && /词元上限|reasoning_content/.test(thinkOnly.note), true)
check('nothing to apply', thinkOnly.applyDisabled, true)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(here, 'screenshot-thinking-empty.png'), Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-thinking-empty.png')
}

// --- normal upstream: answer renders, and there is no thinking block ---
await postSettings({ ai: { baseURL: `http://127.0.0.1:${mock2Port}/v1`, model: 'mock-c51-model' } })
check('normal reply arrives', await ask('再来一次普通回答'), true)
await sleep(400)
const normal = await evaluate(`(() => {
  const boxes = [...document.querySelectorAll('#transcript .msg.ai')]
  const box = boxes[boxes.length - 1]
  return {
    hasThink: !!box.querySelector('details.think'),
    body: box.querySelector('.md').innerText,
    notes: box.querySelectorAll('.md-note').length,
  }
})()`)
check('normal answer has text', /mock/.test(normal.body), true)
check('no thinking block without reasoning', normal.hasThink, false)
check('no empty-reply note on a normal answer', normal.notes, 0)

await rm(profile, { recursive: true, force: true }).catch(() => undefined)
await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
server.kill()
mock.kill()
mock2.kill()
process.exit(failed ? 1 : 0)
