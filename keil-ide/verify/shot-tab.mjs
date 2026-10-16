#!/usr/bin/env node
/**
 * Open the settings dialog on one tab and screenshot it (reusable UI evidence).
 *
 * Usage: node verify/shot-tab.mjs <tabName> <outFile> [cdpPort]
 */
const [tab = 'files', out = 'verify/screenshot-tab.png', port = '9222'] = process.argv.slice(2)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target')
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
const evaluate = async (expression, awaitPromise = true) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result?.exceptionDetails) return { error: result.exceptionDetails.exception?.description ?? 'failed' }
  return { value: result?.result?.value }
}

await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 7000))
const opened = await evaluate(`(async () => {
  document.getElementById('btn-settings').click()
  await new Promise((r) => setTimeout(r, 1200))
  document.querySelector('.settings-tabs .tab[data-tab="${tab}"]').click()
  await new Promise((r) => setTimeout(r, 600))
  const pane = document.querySelector('.pane-tab.active')
  return JSON.stringify({ tab: pane?.dataset.pane ?? '', heading: pane?.querySelector('.field > span')?.textContent ?? '' })
})()`)
console.log('opened:', opened.value ?? opened.error)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot?.data) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(out, Buffer.from(shot.data, 'base64'))
  console.log(`screenshot: ${out}`)
}
socket.close()
