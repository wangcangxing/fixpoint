#!/usr/bin/env node
/**
 * Inline-image acceptance (OpenAI-compatible `image_url` parts).
 *
 *   A. server: the last user message becomes a content array — a text descriptor
 *      before every image ("图片 1：…"), then `image_url` with a data: URL.
 *   B. server guards: unsupported type, magic-byte mismatch, more than 4 images and
 *      an oversize image are all 400s with a readable reason.
 *   C. UI: picking an image builds a chip (thumbnail + size), warns when the model
 *      is not marked as vision-capable, sends it, then clears the composer.
 *
 * Usage: node verify/image-chat.mjs [serverPort] [chromePort] [mockPort]
 *   (self-contained: starts its own IDE server with a temp settings file)
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const serverPort = process.argv[2] ?? '4892'
const chromePort = process.argv[3] ?? '9340'
const mockPort = process.argv[4] ?? '4908'
const base = `http://127.0.0.1:${serverPort}`
const mockBase = `http://127.0.0.1:${mockPort}/v1`
const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')

/** 1×1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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

const workDir = await mkdtemp(join(tmpdir(), 'keil-image-chat-'))
const settingsFile = join(workDir, 'settings.json')
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: appDir,
  env: { ...process.env, KEIL_IDE_PORT: serverPort, KEIL_IDE_SETTINGS: settingsFile },
  stdio: 'ignore',
  windowsHide: true,
})
const mock = spawn(process.execPath, [join(here, 'mock-openai.mjs'), mockPort], { stdio: 'ignore', windowsHide: true })
process.on('exit', () => {
  server.kill()
  mock.kill()
})

if (!(await waitFor(`${base}/api/health`)) || !(await waitFor(`${mockBase}/models`))) {
  console.error('server or mock did not start')
  process.exit(2)
}

const postSettings = (body) =>
  fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json())
await postSettings({ ai: { baseURL: mockBase, model: 'mock-c51-model', maxOutputChars: 20000 } })

const chat = async (images) => {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ prompt: '这张图里的电路有什么问题？', project: '', images }),
  })
  const raw = await response.text()
  return { status: response.status, raw, body: (() => { try { return JSON.parse(raw) } catch { return null } })() }
}
const lastRequest = () => fetch(`http://127.0.0.1:${mockPort}/last-request`).then((response) => response.json())

/* ---------- A. the image reaches the wire as a part ---------- */

const image = { name: 'pixel.png', mime: 'image/png', width: 1, height: 1, data: PNG_BASE64 }
let result = await chat([image])
check('chat with an image answers', result.status, 200)
let sent = await lastRequest()
const content = sent.messages?.[1]?.content
check('user content became an array', Array.isArray(content), true)
check(
  'a text descriptor precedes the image',
  content?.[1]?.type === 'text' && /图片 1/.test(content[1].text) && /1×1/.test(content[1].text),
  true,
)
check(
  'the image is an image_url data URL',
  content?.[2]?.type === 'image_url' && content[2].image_url?.url?.startsWith('data:image/png;base64,'),
  true,
)
check('the prompt text is still there', content?.[0]?.type === 'text' && /电路/.test(content[0].text), true)

/* ---------- B. guards ---------- */

result = await chat([{ ...image, mime: 'image/svg+xml' }])
check('SVG is refused', [result.status, /类型不支持/.test(result.body?.error ?? '')], [400, true])

result = await chat([{ ...image, data: Buffer.from('not-an-image').toString('base64') }])
check('magic-byte mismatch is refused', [result.status, /内容与类型不符/.test(result.body?.error ?? '')], [400, true])

result = await chat([image, image, image, image, image])
check('more than four images is refused', [result.status, /最多 4 张/.test(result.body?.error ?? '')], [400, true])

const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5 * 1024 * 1024 + 1, 1)]).toString('base64')
result = await chat([{ ...image, data: big }])
check('an oversize image is refused', [result.status, /超过 5 MB/.test(result.body?.error ?? '')], [400, true])

/* ---------- C. the UI ---------- */

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
const profile = join(tmpdir(), `dsh-chrome-image-chat-${chromePort}`)
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

const picked = await evaluate(`(async () => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (char) => char.charCodeAt(0))
  const file = new File([bytes], 'pixel.png', { type: 'image/png' })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const input = document.getElementById('chat-image-input')
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 800))
  const host = document.getElementById('chat-images')
  return {
    chips: host.querySelectorAll('.chip-img img').length,
    label: host.querySelector('.chip-img span')?.textContent ?? '',
    thumb: host.querySelector('.chip-img img')?.src.startsWith('data:image/') ?? false,
    warn: [...host.querySelectorAll('.chip-img.warn')].length,
  }
})()`)
check('picking an image builds a chip', [picked.chips, picked.thumb], [1, true])
check('the chip shows the processed size', /1×1/.test(picked.label), true)
check('a non-vision model gets a warning', picked.warn, 1)

const chipShot = await send('Page.captureScreenshot', { format: 'png' })
if (chipShot?.data) {
  await writeFile(join(here, 'screenshot-image-chip.png'), Buffer.from(chipShot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-image-chip.png')
}

await evaluate(`(() => {
  document.getElementById('prompt').value = '这张图里是什么？'
  document.getElementById('btn-send').click()
  return true
})()`)
check('the reply settles', await until(`!document.getElementById('btn-send').disabled`), true)
await sleep(500)
sent = await lastRequest()
const uiContent = sent.messages?.[1]?.content
check('the UI sends the image too', Array.isArray(uiContent) && uiContent.some((part) => part?.type === 'image_url'), true)
check('the composer is cleared after sending', await evaluate(`document.querySelectorAll('#chat-images .chip-img img').length`), 0)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(here, 'screenshot-image-chat.png'), Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-image-chat.png')
}

await rm(profile, { recursive: true, force: true }).catch(() => undefined)
await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
server.kill()
mock.kill()
process.exit(failed ? 1 : 0)
