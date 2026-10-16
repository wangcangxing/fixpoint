#!/usr/bin/env node
/** Dump the transcript bubbles: class, first characters, and which markdown nodes exist. */
const port = process.argv[2] ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
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
const result = await send('Runtime.evaluate', {
  expression: `JSON.stringify([...document.querySelectorAll('#transcript .msg')].slice(-4).map((box) => ({
    cls: box.className,
    meta: box.querySelector('.meta')?.textContent ?? '',
    text: (box.bodyEl?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 150),
    hasPre: Boolean(box.querySelector('pre > code')),
    hasHeading: Boolean(box.querySelector('h3,h4,h5,h6')),
    hasList: Boolean(box.querySelector('li')),
    bodyClass: box.bodyEl?.className ?? '',
  })), null, 1)`,
  returnByValue: true,
  timeout: 4000,
})
console.log(result?.result?.value ?? JSON.stringify(result))
socket.close()
