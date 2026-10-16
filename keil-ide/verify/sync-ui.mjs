#!/usr/bin/env node
/**
 * End-to-end checks for the 4 new file features, against OUR OWN demo project
 * (never the user's project):
 *
 *   1. the model dropdown really is a <select> filled from /api/models
 *   2. an external change to the open file is read in automatically
 *   3. an external change does NOT clobber unsaved edits in this window (conflict)
 *   4. the sync chip reports both cases
 *
 * Usage: node verify/sync-ui.mjs <demoProject> <userProject> [cdpPort]
 */
import { readFile, writeFile } from 'node:fs/promises'

const [demoProject, userProject, port = '9222'] = process.argv.slice(2)
if (!demoProject || !userProject) {
  console.error('usage: node verify/sync-ui.mjs <demoProject> <userProject> [cdpPort]')
  process.exit(1)
}

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

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
const evaluate = async (expression, awaitPromise = true) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result?.exceptionDetails) return { error: result.exceptionDetails.exception?.description ?? 'failed' }
  return { value: result?.result?.value }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settings = async (patch) => {
  const response = await fetch('http://127.0.0.1:4870/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return response.json()
}

// Point the app at the demo project and reload so boot() picks it up.
await settings({ project: demoProject, sync: { enabled: true, intervalMs: 1000 } })
await send('Page.reload', { ignoreCache: true })
await sleep(7000)

const opened = await evaluate(`JSON.stringify({
  path: state.current?.path ?? '',
  text: state.editor?.getValue() ?? '',
  chip: document.getElementById('sync-chip')?.textContent ?? '',
})`)
const openedState = JSON.parse(opened.value ?? '{}')
check('已打开 demo 的 main.c', /main\.c$/i.test(openedState.path), true)
const original = await readFile(openedState.path, 'utf8')

// ---------- 1) model dropdown ----------
const dropdown = await evaluate(`(async () => {
  document.getElementById('btn-settings').click()
  await new Promise((r) => setTimeout(r, 900))
  document.getElementById('btn-fetch-models').click()
  await new Promise((r) => setTimeout(r, 1500))
  const select = document.getElementById('ai-model-select')
  const options = [...select.options].map((o) => o.value)
  select.value = options[0]
  select.dispatchEvent(new Event('change'))
  const wrote = document.getElementById('ai-model').value
  document.getElementById('btn-settings-close').click()
  return JSON.stringify({ tag: select.tagName, options, wrote })
})()`)
const model = JSON.parse(dropdown.value ?? '{}')
check('模型下拉是一个真正的 <select>', model.tag, 'SELECT')
check('下拉里有 mock 的模型', (model.options ?? []).includes('mock-c51-model'), true)
check('选中后写入模型名输入框', model.wrote, 'mock-c51-model')

// ---------- 2) external change is picked up ----------
await writeFile(openedState.path, `${original}\n// 外部改动 A\n`, 'utf8')
await sleep(3500)
const afterExternal = await evaluate(`JSON.stringify({
  text: state.editor?.getValue() ?? '',
  chip: document.getElementById('sync-chip')?.textContent ?? '',
  dirty: state.dirty === true,
})`)
const synced = JSON.parse(afterExternal.value ?? '{}')
check('外部改动被自动读入编辑器', synced.text.includes('外部改动 A'), true)
check('同步提示说明是自动读入的', /自动读入外部改动/.test(synced.chip), true)
check('自动读入后不算未保存修改', synced.dirty, false)

// ---------- 3) unsaved edits are NOT clobbered ----------
const mine = `// 我在窗口里改的内容 ${Date.now()}\n`
await evaluate(`(state.editor.setValue(${JSON.stringify(mine)}), 'typed')`)
await sleep(300)
await writeFile(openedState.path, `${original}\n// 外部改动 B\n`, 'utf8')
await sleep(3500)
const afterConflict = await evaluate(`JSON.stringify({
  text: state.editor?.getValue() ?? '',
  chip: document.getElementById('sync-chip')?.textContent ?? '',
  dirty: state.dirty === true,
  title: document.getElementById('sync-chip')?.title ?? '',
})`)
const conflict = JSON.parse(afterConflict.value ?? '{}')
check('冲突时保留我改的内容（没被覆盖）', conflict.text.includes('我在窗口里改的内容'), true)
check('冲突时确实没读入外部版本', conflict.text.includes('外部改动 B'), false)
check('状态标记为有未保存修改', conflict.dirty, true)
check('同步提示明确指出冲突', /冲突/.test(conflict.chip), true)
check('提示里说明了不会覆盖', /没有覆盖/.test(conflict.title), true)

// ---------- cleanup: restore the demo file and the user's project ----------
await writeFile(openedState.path, original, 'utf8')
await settings({ project: userProject, sync: { enabled: true, intervalMs: 2000 } })
await send('Page.reload', { ignoreCache: true })
await sleep(5000)
console.log(`\n已还原 demo 文件并切回工程: ${userProject}`)
console.log(failed ? `${failed} 项失败` : '全部通过')
socket.close()
process.exit(failed ? 1 : 0)
