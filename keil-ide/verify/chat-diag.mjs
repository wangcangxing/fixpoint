#!/usr/bin/env node
/**
 * Initial-state diagnostic: open a FRESH page (empty localStorage) and report what
 * the AI pane actually looks like before any interaction. Written after a report
 * that the pane rendered as an empty column — the numbers below decide whether that
 * is a CSS height collapse, a hidden .chat-body, or a JS error during init.
 *
 * Usage: node verify/chat-diag.mjs [width] [height]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4898
const chromePort = 9337
const VIEW_W = Number(process.argv[2] ?? 1280)
const VIEW_H = Number(process.argv[3] ?? 900)
const base = `http://127.0.0.1:${port}`
const work = await mkdtemp(join(tmpdir(), 'keil-chat-diag-'))
const home = join(work, 'home')
await mkdir(home, { recursive: true })

const children = []
const killAll = () => {
  for (const child of children) child.kill()
}
process.on('exit', killAll)

children.push(
  spawn(process.execPath, [process.env.DIAG_SERVER ?? join(root, 'keil-ide', 'server.mjs')], {
    cwd: process.env.DIAG_SERVER ? dirname(process.env.DIAG_SERVER) : join(root, 'keil-ide'),
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      KEIL_IDE_PORT: String(port),
      KEIL_IDE_SETTINGS: join(work, 'settings.json'),
      KEIL_IDE_AI_MODE: 'openai',
      KEIL_IDE_AI_BASEURL: 'http://127.0.0.1:9/v1',
      KEIL_IDE_AI_KEY: 'x',
      KEIL_IDE_INLINE: '0',
    },
    stdio: 'ignore',
    windowsHide: true,
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
  console.error(`no server on ${base}`)
  process.exit(2)
}

const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}

// Optional: open a real project, and pre-seed the pane state the way a user's
// localStorage would carry it across sessions.
const projectPath = process.env.DIAG_PROJECT ?? ''
if (projectPath) {
  const saved = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: projectPath }),
  }).then((response) => response.json()).catch(() => ({}))
  console.log(`project set: ${saved.project ?? '(failed)'}`)
}
const panes = process.env.DIAG_PANES ?? ''
const profile = join(tmpdir(), `dsh-chrome-chat-diag-${chromePort}`)
await mkdir(profile, { recursive: true })
children.push(
  spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${VIEW_W},${VIEW_H}`,
    base,
  ], { stdio: 'ignore', windowsHide: true }),
)

let target
for (let attempt = 0; attempt < 80; attempt += 1) {
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
const errors = []
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
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'exception')
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  }
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
await send('Runtime.enable', {})
await send('Page.enable')
if (panes) {
  // Seed the stored pane state, then reload so initPanes() applies it.
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('fixpoint.panes.v1', ${JSON.stringify(panes)}); true`,
    returnByValue: true,
  })
  console.log(`panes seeded: ${panes}`)
}
await send('Page.reload', { ignoreCache: true })
await new Promise((done) => setTimeout(done, 3000))

const result = await send('Runtime.evaluate', {
  expression: `(() => {
    const pick = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return null
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return {
        tag: el.tagName.toLowerCase(),
        cls: el.className,
        display: style.display,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        flex: style.flex,
        minHeight: style.minHeight,
        maxHeight: style.maxHeight,
        overflow: style.overflow,
      }
    }
    const chat = document.getElementById('pane-chat')
    return {
      viewport: { w: innerWidth, h: innerHeight },
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      chatClasses: chat ? [...chat.classList] : null,
      chat: pick('#pane-chat'),
      chatBody: pick('.chat-body'),
      transcript: pick('#transcript'),
      controls: pick('.chat-controls'),
      controlsScroll: pick('.chat-controls-scroll'),
      prompt: pick('#prompt'),
      sendButton: pick('#btn-send'),
      applyButton: pick('#btn-apply'),
      composerRowsInsidePane: (() => {
        const pane = document.getElementById('pane-chat').getBoundingClientRect()
        const check = (id) => {
          const el = document.getElementById(id)
          if (!el) return false
          const r = el.getBoundingClientRect()
          return r.height > 8 && r.top >= pane.top - 1 && r.bottom <= pane.bottom + 1
        }
        return { textarea: check('prompt'), send: check('btn-send'), apply: check('btn-apply') }
      })(),
      transcriptChildren: document.getElementById('transcript')?.childElementCount ?? -1,
      transcriptFirstText: (document.getElementById('transcript')?.innerText ?? '').slice(0, 80),
      transcriptScroll: (() => {
        const pane = document.getElementById('transcript')
        if (!pane) return null
        return { scrollTop: Math.round(pane.scrollTop), scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight }
      })(),
      firstMessage: (() => {
        const box = document.querySelector('#transcript .msg')
        if (!box) return null
        const rect = box.getBoundingClientRect()
        const body = box.bodyEl ?? box.querySelector('.md')
        const style = getComputedStyle(box)
        return {
          cls: box.className,
          top: Math.round(rect.top),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          color: style.color,
          background: style.backgroundColor,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          textPreview: (body?.textContent ?? '').trim().slice(0, 60),
          bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : -1,
        }
      })(),
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log(JSON.stringify(result?.result?.value ?? result, null, 2))
if (errors.length) console.log(`\nconsole errors:\n- ${errors.join('\n- ')}`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(root, 'keil-ide', 'verify', 'screenshot-chat-diag.png'), Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-chat-diag.png')
}
socket.close()
killAll()
process.exit(0)
