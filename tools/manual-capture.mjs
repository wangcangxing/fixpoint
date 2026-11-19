#!/usr/bin/env node
/**
 * Capture the screenshots used by the user manual (one-off, not shipped).
 *
 * Usage: node tools/manual-capture.mjs <cdpPort> <outDir>
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const port = process.argv[2] ?? '9222'
const outDir = process.argv[3] ?? join(process.cwd(), 'docs', 'manual', 'img')
await mkdir(outDir, { recursive: true })

const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await sleep(250)
  }
  return false
}
const shot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  if (!result?.data) throw new Error(`screenshot failed: ${name}`)
  await writeFile(join(outDir, name), Buffer.from(result.data, 'base64'))
  console.log(`saved ${name}`)
}
/** Clip one element (CSS px); CDP scales by the device pixel ratio. */
const shotElement = async (name, selector, pad = 0) => {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })()`)
  if (!rect) throw new Error(`element not found: ${selector}`)
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.w + pad * 2, height: rect.h + pad * 2, scale: 1 },
  })
  if (!result?.data) throw new Error(`clip screenshot failed: ${name}`)
  await writeFile(join(outDir, name), Buffer.from(result.data, 'base64'))
  console.log(`saved ${name}`)
}

await send('Page.reload', { ignoreCache: true })
await until(`document.readyState === 'complete' && typeof document.getElementById('btn-settings').onclick === 'function'`)
await until(`!!state.info && state.info.device`)
await sleep(1200)

await shot('overview.png')
await shotElement('tree.png', '#pane-files', 6)
await shotElement('editor.png', '#editor', 6)
await shotElement('chat.png', '#pane-chat', 6)

// Compile the demo project for real, so the transcript holds real compiler output.
await evaluate(`document.getElementById('btn-build').click(); true`)
await until(`/编译/.test(document.getElementById('transcript').innerText) && !document.getElementById('btn-build').disabled`, 60000)
await sleep(800)
await shot('build.png')
await shotElement('problems.png', '#pane-problems', 6)

// One AI turn against the mock endpoint (canned C51 answer + code block).
await evaluate(`(() => {
  document.getElementById('prompt').value = '把 LED 闪烁改成分段亮度，并解释一下思路'
  document.getElementById('btn-send').click()
  return true
})()`)
await until(`!document.getElementById('btn-send').disabled && document.querySelectorAll('#transcript .msg.ai').length > 0`, 30000)
await sleep(700)
await shot('ai.png')

// Settings dialog: the model list is the most distinctive screen.
await evaluate(`(() => {
  document.getElementById('btn-settings').click()
  document.querySelector('.settings-tabs .tab[data-tab="ai"]').click()
  return true
})()`)
await sleep(1200)
await shot('settings.png')
await evaluate(`document.getElementById('btn-settings-close').click(); true`)
await sleep(400)

// Chat-side model picker.
await evaluate(`document.getElementById('btn-model-picker').click(); true`)
await sleep(500)
await shot('model-menu.png')

socket.close()
console.log('done')
process.exit(0)
