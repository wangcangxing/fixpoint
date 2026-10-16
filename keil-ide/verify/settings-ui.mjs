#!/usr/bin/env node
/**
 * End-to-end test for the unified settings dialog.
 *
 * Checks, in the live app: the five tabs exist and switch, editor preferences
 * reach Monaco immediately, the skills switch really changes what the registry
 * scans, the diagnostics tab is populated — and then puts everything back.
 *
 * Usage: node verify/settings-ui.mjs [cdpPort]
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
const evaluate = async (expression, awaitPromise = false) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result?.exceptionDetails) return { error: result.exceptionDetails.exception?.description ?? 'failed' }
  return { value: result?.result?.value }
}

await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 6000))

const step = async (label, expression) => {
  const result = await evaluate(expression, true)
  console.log(`${label}: ${result.value ?? `ERROR ${result.error}`}`)
  return result.value
}

await step(
  '结构',
  `JSON.stringify({
     monaco: typeof monaco,
     tabs: [...document.querySelectorAll('.settings-tabs .tab')].map((b) => b.dataset.tab),
     panes: [...document.querySelectorAll('.settings-panes .pane-tab')].map((p) => p.dataset.pane),
   })`,
)

await step(
  '打开 + 切页签',
  `(async () => {
     document.getElementById('btn-settings').click()
     await new Promise((r) => setTimeout(r, 1000))
     const visible = !document.getElementById('settings').classList.contains('hidden')
     document.querySelector('.settings-tabs .tab[data-tab="editor"]').click()
     await new Promise((r) => setTimeout(r, 200))
     return JSON.stringify({
       visible,
       activePane: document.querySelector('.settings-panes .pane-tab.active')?.dataset.pane,
       tabActive: document.querySelector('.settings-tabs .tab.active')?.dataset.tab,
     })
   })()`,
)

await step(
  '编辑器设置即时生效',
  `(async () => {
     document.getElementById('editor-fontsize').value = '17'
     document.getElementById('editor-wordwrap').checked = true
     document.getElementById('editor-minimap').checked = true
     document.getElementById('btn-settings-save').click()
     await new Promise((r) => setTimeout(r, 1200))
     const editor = state.editor
     return JSON.stringify({
       fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
       wordWrap: editor.getOption(monaco.editor.EditorOption.wordWrap),
       minimap: editor.getOption(monaco.editor.EditorOption.minimap).enabled,
       status: document.getElementById('settings-status').textContent,
     })
   })()`,
)

await step(
  '技能开关：关掉共享 DSH 目录',
  `(async () => {
     document.querySelector('.settings-tabs .tab[data-tab="skills"]').click()
     document.getElementById('skills-shared-dsh').checked = false
     document.getElementById('btn-settings-save').click()
     await new Promise((r) => setTimeout(r, 1500))
     const data = await (await fetch('/api/skills?project=' + encodeURIComponent(state.settings.project ?? ''))).json()
     return JSON.stringify({
       roots: data.roots.map((r) => r.source),
       hasPonytail: data.skills.some((s) => s.name.startsWith('ponytail')),
       listed: data.skills.map((s) => s.name).join(','),
     })
   })()`,
)

await step(
  '诊断栏内容',
  `(async () => {
     document.querySelector('.settings-tabs .tab[data-tab="about"]').click()
     await new Promise((r) => setTimeout(r, 500))
     return JSON.stringify({
       doctor: document.getElementById('about-doctor').textContent.split('\\n')[0],
       settingsFile: document.getElementById('about-settings-file').value,
     })
   })()`,
)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot?.data) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile('verify/screenshot-settings.png', Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-settings.png')
}

await step(
  '还原（共享开关打开 + 编辑器回默认）',
  `(async () => {
     document.getElementById('skills-shared-dsh').checked = true
     document.getElementById('editor-fontsize').value = '13'
     document.getElementById('editor-wordwrap').checked = false
     document.getElementById('editor-minimap').checked = false
     document.getElementById('btn-settings-save').click()
     await new Promise((r) => setTimeout(r, 1500))
     const data = await (await fetch('/api/skills?project=' + encodeURIComponent(state.settings.project ?? ''))).json()
     document.getElementById('btn-settings-close').click()
     return JSON.stringify({
       roots: data.roots.map((r) => r.source),
       hasPonytail: data.skills.some((s) => s.name.startsWith('ponytail')),
       fontSize: state.editor.getOption(monaco.editor.EditorOption.fontSize),
       hidden: document.getElementById('settings').classList.contains('hidden'),
     })
   })()`,
)

socket.close()
