#!/usr/bin/env node
/**
 * Reproduce the 新建文件 flow through the REAL UI, so "新建文件有问题" becomes a
 * concrete failure instead of a guess.
 *
 * The script clicks the button, types into the prompt dialog, and auto-answers the
 * "add to project?" confirm via CDP (a native dialog would otherwise block).
 *
 * Usage: node verify/newfile-ui.mjs <demoProject> [cdpPort]
 */
import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const [demoProject, port = '9222'] = process.argv.slice(2)
if (!demoProject) {
  console.error('usage: node verify/newfile-ui.mjs <demoProject> [cdpPort]')
  process.exit(1)
}
const demoDir = dirname(demoProject)
const newName = `ui-new-${Date.now() % 100000}.c`
const newPath = join(demoDir, newName)

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
  if (message.method === 'Page.javascriptDialogOpening') {
    // Auto-accept: "add it to the project?" / any other confirm.
    send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    console.log(`  [CDP] 自动应答对话框: ${message.params?.message?.slice(0, 60)}…`)
  }
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await send('Page.enable')
await fetch('http://127.0.0.1:4870/api/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ project: demoProject }),
})
await send('Page.reload', { ignoreCache: true })
await sleep(7000)

// Clean any leftover from an earlier run.
await rm(newPath, { force: true }).catch(() => {})

console.log(`1) 点"新建"，目标文件名 ${newName}`)
const typed = await evaluate(`(async () => {
  document.getElementById('btn-new-file').click()
  await new Promise((r) => setTimeout(r, 800))
  const modal = document.getElementById('prompt')
  const visible = !modal.classList.contains('hidden')
  const input = document.getElementById('prompt-input')
  const defaultValue = input.value
  input.value = ${JSON.stringify(newName)}
  document.getElementById('btn-prompt-ok').click()
  return JSON.stringify({ promptVisible: visible, defaultValue })
})()`)
console.log('   输入弹窗:', typed.value ?? typed.error)

await sleep(3500)
const after = await evaluate(`JSON.stringify({
  editorPath: state.current?.path ?? '',
  editorText: (state.editor?.getValue() ?? '').slice(0, 80),
  fileChip: document.getElementById('file-chip')?.textContent ?? '',
  treeText: document.getElementById('tree')?.textContent?.replace(/\\s+/g, ' ').slice(0, 400) ?? '',
  transcript: [...document.querySelectorAll('#transcript .msg')].slice(-3).map((m) => m.textContent.replace(/\\s+/g, ' ').slice(0, 160)),
})`)
console.log('   界面状态:', after.value ?? after.error)
console.log('   实际打开的文件:', (JSON.parse(after.value ?? '{}').editorPath || '(无)'))

const disk = await stat(newPath).catch(() => null)
console.log(`2) 磁盘上存在 ${newName}: ${Boolean(disk)}${disk ? ` (${disk.size} 字节)` : ''}`)
if (disk) console.log('   内容:', JSON.stringify((await readFile(newPath, 'utf8')).slice(0, 60)))
const declared = await (await fetch(`http://127.0.0.1:4870/api/project?project=${encodeURIComponent(demoProject)}`)).json()
const inProject = (declared.sources?.declared ?? []).includes(newName)
const asOrphan = (declared.sources?.orphans ?? []).includes(newName)
console.log(`3) 工程声明里有它: ${inProject}；未加入工程的列表里有它: ${asOrphan}`)

// Clean up: remove the test file and drop it from the project if it got added.
if (inProject) {
  const xml = await readFile(demoProject, 'utf8')
  const trimmed = xml.replace(
    new RegExp(`\\s*<File>\\s*<FileName>${newName}</FileName>[\\s\\S]*?</File>`, 'g'),
    '',
  )
  if (trimmed !== xml) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(demoProject, trimmed, 'utf8')
    console.log('   已从 demo 工程里移除测试文件条目')
  }
}
await rm(newPath, { force: true }).catch(() => {})
console.log('   已删除测试文件')
socket.close()
