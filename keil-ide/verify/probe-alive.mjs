#!/usr/bin/env node
/**
 * Liveness probe: is the page's main thread still responsive?
 *
 * A synchronous infinite loop in page code freezes the renderer, and then every
 * Runtime.evaluate hangs forever. This uses CDP's per-call `timeout` so the answer
 * comes back even when the page is stuck.
 *
 * Usage: node verify/probe-alive.mjs [cdpPort]
 */
const port = process.argv[2] ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.log('FAIL  没有 page 目标（应用没起来）')
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

const probes = [
  ['1+1', '1 + 1'],
  ['document.title', 'document.title'],
  ['renderMarkdown 小样本', "renderMarkdown('# 标题\\n- a\\n- b').childNodes.length"],
  ['renderMarkdown 中等（含代码块）', "renderMarkdown('## 标题\\n\\n```c\\nint a;\\n```\\n\\n- x\\n- y').childNodes.length"],
]
for (const [name, expression] of probes) {
  const started = Date.now()
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, timeout: 2000 })
  const ms = Date.now() - started
  if (result?.exceptionDetails) {
    console.log(`FAIL  ${name}: 抛异常 ${result.exceptionDetails.exception?.description?.split('\n')[0] ?? ''} (${ms}ms)`)
  } else if (result?.result?.value === undefined && result?.code) {
    console.log(`TIMEOUT  ${name}: CDP ${result.code} ${result.message ?? ''} (${ms}ms) → 页面主线程被卡住`)
  } else {
    console.log(`PASS  ${name} = ${JSON.stringify(result?.result?.value)} (${ms}ms)`)
  }
}
socket.close()
