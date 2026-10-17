#!/usr/bin/env node
/**
 * AI diff acceptance (headless Chrome + a mock OpenAI endpoint):
 *   1. a chat reply that carries a code block for the OPEN file opens the diff
 *      automatically — no button press
 *   2. the diff is Monaco's side-by-side editor (left = current, right = AI)
 *   3. added lines are green (.line-insert) and removed lines are red (.line-delete)
 *   4. the header shows +N −M
 *   5. "应用修改" writes the AI side through /api/file and closes the diff
 *
 * Usage: node verify/ai-diff.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4887
const mockPort = 4886
const base = `http://127.0.0.1:${port}`
const chromePort = 9335
const settingsPath = join(tmpdir(), `keil-ai-diff-settings-${Date.now()}.json`)
const workDir = join(tmpdir(), `keil-ai-diff-proj-${Date.now()}`)

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}
const json = (path, init) => fetch(`${base}${path}`, init).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }))
const post = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const waitFor = async (url, attempts = 60) => {
  for (let index = 0; index < attempts; index += 1) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}

await mkdir(workDir, { recursive: true })
const server = spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
  cwd: join(root, 'keil-ide'),
  env: {
    ...process.env,
    KEIL_IDE_PORT: String(port),
    KEIL_IDE_SETTINGS: settingsPath,
    KEIL_IDE_AI_MODE: 'openai',
    KEIL_IDE_AI_BASEURL: `http://127.0.0.1:${mockPort}/v1`,
    KEIL_IDE_AI_KEY: 'test',
    KEIL_IDE_INLINE: '0',
  },
  stdio: 'ignore',
  windowsHide: true,
})
const mock = spawn(process.execPath, [join(root, 'keil-ide', 'verify', 'mock-openai.mjs'), String(mockPort)], {
  stdio: 'ignore',
  windowsHide: true,
})
const cleanup = () => {
  server.kill()
  mock.kill()
}
process.on('exit', cleanup)
if (!(await waitFor(`${base}/api/health`)) || !(await waitFor(`http://127.0.0.1:${mockPort}/v1/models`))) {
  console.error('could not start the test host (ports 4887/4886 busy?)')
  process.exit(2)
}

const created = await post('/api/project/new', { dir: workDir, name: 'diffdemo', device: { device: 'AT89C52' } })
check('project created', created.status, 200)
const projectPath = created.body.project
const fileName = 'mock-suggestion.c'
const filePath = join(workDir, fileName)
// The old content deliberately differs in a line the mock keeps, so the diff has
// BOTH an insertion and a deletion.
const original = '/* old code */\n#include <reg51.h>\n\nvoid main(void)\n{\n}\n'
await writeFile(filePath, original, 'utf8')
await post('/api/settings', { project: projectPath })

const { existsSync } = await import('node:fs')
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}
const profile = join(tmpdir(), `dsh-chrome-ai-diff-${chromePort}`)
await rm(profile, { recursive: true, force: true }).catch(() => undefined)
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    base,
  ],
  { stdio: 'ignore', windowsHide: true },
)
process.on('exit', () => browser.kill())

let target
for (let attempt = 0; attempt < 60; attempt += 1) {
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
const sendCdp = (method, params = {}) =>
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
  const result = await sendCdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result))
  return result?.result?.value
}
const until = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

check('page booted', await until(`typeof openFile === 'function' && !!document.getElementById('editor')`), true)
// boot() is async: openFile() needs state.info (absPath) and boot's auto-open of
// main.c must finish first, otherwise it overwrites the file we just opened.
check('project loaded', await until(`!!state.info && !!state.info.projectDir && !!state.current`), true)
await evaluate(`openFile(${JSON.stringify(fileName)})`)
check('file opened', await until(`document.getElementById('file-chip')?.textContent?.includes('mock-suggestion.c')`), true)

// Drive the real chat path: the mock answers with a c block + `FILE: mock-suggestion.c`.
await evaluate(`(() => {
  document.getElementById('prompt').value = '帮我改一版闪烁代码'
  return true
})()`)
await evaluate(`send()`)
check('diff opened automatically', await until(`!document.getElementById('diff-view').classList.contains('hidden')`), true)
check('diff uses Monaco side-by-side', await until(`!!document.querySelector('#diff-editor .monaco-diff-editor')`), true)
const diffClasses = await evaluate(`document.querySelector('#diff-editor .monaco-diff-editor').className`)
console.log(`      diff classes: ${diffClasses}`)
check('renders in side-by-side mode', /side-by-side/.test(diffClasses), true)
// Decorations are painted after the diff computes; wait for them instead of
// sampling immediately (the first run sampled too early and saw 0).
check('added lines are marked', await until(`document.querySelectorAll('#diff-editor .line-insert').length > 0`), true)
check('removed lines are marked', await until(`document.querySelectorAll('#diff-editor .line-delete').length > 0`), true)

const metrics = await evaluate(`(() => {
  const stats = document.getElementById('diff-stats').textContent
  const panes = document.querySelectorAll('#diff-editor .monaco-diff-editor .editor').length
  return {
    title: document.getElementById('diff-title').textContent,
    stats,
    ins: document.querySelectorAll('#diff-editor .line-insert').length,
    del: document.querySelectorAll('#diff-editor .line-delete').length,
    panes,
    hasApply: !!document.getElementById('btn-diff-apply'),
  }
})()`)
console.log(`      diff: ${JSON.stringify(metrics)}`)
check('two panes rendered', metrics.panes >= 2, true)
check('header counts additions and removals', /^\+\d+ −\d+$/.test(metrics.stats), true)
check('title names the file', /mock-suggestion\.c/.test(metrics.title), true)

const shot = await sendCdp('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile('verify/screenshot-ai-diff.png', Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-ai-diff.png')
}

await evaluate(`document.getElementById('btn-diff-apply').click(); true`)
check('diff closes after apply', await until(`document.getElementById('diff-view').classList.contains('hidden')`), true)
const written = await fetch(`${base}/api/file?project=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(filePath)}`).then((response) => response.json())
check('file now holds the AI version', /sbit LED = P1\^0;/.test(written.text ?? ''), true)
check('old line is gone', /old code/.test(written.text ?? ''), false)

// A reply that targets a DIFFERENT file shows a diff too, without switching tabs.
const otherReply = 'FILE: main.c\n\n```c\n#include <reg51.h>\n\nvoid main(void)\n{\n    P1 = 0x00;\n}\n```'
await evaluate(`(() => { state.lastReply = ${JSON.stringify(otherReply)}; return previewOrApply() })()`)
check(
  'other-file diff opens',
  await until(
    `!document.getElementById('diff-view').classList.contains('hidden') && /main\\.c/.test(document.getElementById('diff-title').textContent)`,
  ),
  true,
)
check('open file was not switched', await evaluate(`state.current.name`), 'mock-suggestion.c')
await evaluate(`closeDiff(); true`)

// The marker inside the fence (what actually happened once): it must not become code.
const insideReply = '```c\nFILE: mock-suggestion.c\n#include <reg51.h>\n\nvoid main(void)\n{\n    P1 = 0x00;\n}\n```'
const parsedInside = await evaluate(`extractCodeBlock(${JSON.stringify(insideReply)})`)
check('FILE inside the fence is treated as the target', /mock-suggestion\.c$/.test(parsedInside.file), true)
check('FILE inside the fence is stripped from the code', /^#include/.test(parsedInside.code), true)
const renderedInside = await evaluate(`(() => renderMarkdown(${JSON.stringify(insideReply)}).textContent)()`)
check('chat rendering drops the FILE marker too', /FILE:/.test(renderedInside), false)
const parsedSlash = await evaluate(
  `extractCodeBlock(${JSON.stringify('```c\n// FILE: mock-suggestion.c\n#include <reg51.h>\n```')})`,
)
check(
  'commented FILE inside the fence also works',
  /^#include/.test(parsedSlash.code) && /mock-suggestion\.c$/.test(parsedSlash.file),
  true,
)

await evaluate(`(() => { state.lastReply = ${JSON.stringify(insideReply)}; return previewOrApply() })()`)
check(
  'diff opens for the inside-the-fence marker',
  await until(
    `!document.getElementById('diff-view').classList.contains('hidden') && /mock-suggestion\\.c/.test(document.getElementById('diff-title').textContent)`,
  ),
  true,
)
const diffText = await evaluate(`state.diffModified`)
check('diff text has no FILE marker', /FILE:/.test(diffText), false)
await evaluate(`document.getElementById('btn-diff-apply').click(); true`)
await until(`document.getElementById('diff-view').classList.contains('hidden')`)
const written3 = await fetch(`${base}/api/file?project=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(filePath)}`).then((response) => response.json())
check('written file starts with code, not the marker', /^#include/.test(written3.text ?? ''), true)
check('written file has no FILE marker', /FILE:/.test(written3.text ?? ''), false)

console.log(failed ? `\n${failed} check(s) failed (kept ${workDir})` : '\nall checks passed')
cleanup()
browser.kill()
process.exit(failed ? 1 : 0)
