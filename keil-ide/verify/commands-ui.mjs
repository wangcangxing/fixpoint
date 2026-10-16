#!/usr/bin/env node
/**
 * UI check for the new file/project commands: the buttons exist, the 新建工程 dialog
 * opens with sane defaults, the file chip renders, and the file pane has its two
 * compact buttons. Screenshots the dialog.
 *
 * Usage: node verify/commands-ui.mjs [cdpPort]
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
await new Promise((resolve) => setTimeout(resolve, 7000))

const buttons = await evaluate(`JSON.stringify({
  ids: ['btn-new-file','btn-open-file','btn-new-project','btn-open-project'].map((id) => {
    const node = document.getElementById(id)
    return node ? id + ':' + node.textContent.trim() : id + ':MISSING'
  }),
  filePaneTitle: document.querySelector('.pane.files .pane-title')?.textContent?.trim() ?? '',
  fileChip: document.getElementById('file-chip')?.textContent ?? '',
  syncChip: document.getElementById('sync-chip')?.textContent ?? '',
})`)
console.log('按钮/芯片:', buttons.value ?? buttons.error)

const opened = await evaluate(`(async () => {
  document.getElementById('btn-new-project').click()
  await new Promise((r) => setTimeout(r, 700))
  return JSON.stringify({
    visible: !document.getElementById('new-project').classList.contains('hidden'),
    dir: document.getElementById('np-dir').value,
    name: document.getElementById('np-name').value,
    device: document.getElementById('np-device').value,
    hasPickDir: !!document.getElementById('btn-np-pick-dir'),
    hasCreate: !!document.getElementById('btn-new-project-create'),
  })
})()`)
console.log('新建工程弹窗:', opened.value ?? opened.error)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot?.data) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile('verify/screenshot-new-project.png', Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-new-project.png')
}

// The prompt dialog is what replaces window.prompt(), which Electron does not support.
const promptCheck = await evaluate(`(async () => {
  const promise = askText({ title: '测试输入', label: '文件名', value: 'x.c' })
  await new Promise((r) => setTimeout(r, 300))
  const visible = !document.getElementById('prompt').classList.contains('hidden')
  const typed = document.getElementById('prompt-input').value
  document.getElementById('prompt-input').value = 'typed.c'
  document.getElementById('btn-prompt-ok').click()
  const result = await promise
  return JSON.stringify({ visible, typed, result, closed: document.getElementById('prompt').classList.contains('hidden') })
})()`)
console.log('输入弹窗（替代 Electron 不支持的 window.prompt）:', promptCheck.value ?? promptCheck.error)

await evaluate(`(document.getElementById('btn-new-project-close').click(), 'closed')`)
socket.close()
