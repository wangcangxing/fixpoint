#!/usr/bin/env node
/**
 * Checks the settings dialog's model picker: pressing 获取模型列表 must fill the
 * datalist from the endpoint's `GET /models` (DeepSeek's 列出模型 endpoint).
 *
 * Usage: node verify/models-ui.mjs [cdpPort]
 */
const port = process.argv[2] ?? '9222'
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
await new Promise((resolve) => setTimeout(resolve, 6000))

const opened = await evaluate(`(async () => {
  document.getElementById('btn-settings').click()
  await new Promise((r) => setTimeout(r, 1200))
  return JSON.stringify({ visible: !document.getElementById('settings').classList.contains('hidden') })
})()`)
console.log('打开设置:', opened.value ?? opened.error)

const fetched = await evaluate(`(async () => {
  document.getElementById('btn-fetch-models').click()
  await new Promise((r) => setTimeout(r, 1500))
  const input = document.getElementById('ai-model')
  return JSON.stringify({
    hint: document.getElementById('model-hint').textContent,
    datalistAttr: input.getAttribute('list'),
    options: [...document.querySelectorAll('#model-options option')].map((o) => o.value),
    labels: [...document.querySelectorAll('#model-options option')].map((o) => o.label),
  })
})()`)
console.log('获取模型列表:', fetched.value ?? fetched.error)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot?.data) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile('verify/screenshot-models.png', Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-models.png')
}
await evaluate(`(document.getElementById('btn-settings-close').click(), 'closed')`)
socket.close()
