#!/usr/bin/env node
/**
 * Capture a PNG of the running keil-ide page over CDP.
 *
 * Unlike a screen grab or PrintWindow, `Page.captureScreenshot` renders the page
 * itself, so it works even when the window is covered by other windows — which
 * is exactly the case when an agent needs to look at the UI.
 *
 * Usage: node verify/cdp-shot.mjs [port] [outfile]
 */
import { writeFile } from 'node:fs/promises'

const port = process.argv[2] ?? '9222'
const out = process.argv[3] ?? 'verify/screenshot-page.png'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target; targets =', JSON.stringify(targets))
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const send = (method, params) =>
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
const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (!result?.data) {
  console.error('capture failed:', JSON.stringify(result))
  process.exit(1)
}
await writeFile(out, Buffer.from(result.data, 'base64'))
console.log(`saved ${out} (${Math.round(Buffer.from(result.data, 'base64').length / 1024)} KB)`)
socket.close()
