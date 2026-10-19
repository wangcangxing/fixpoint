#!/usr/bin/env node
/**
 * Multi-model ("添加模型") acceptance:
 *
 *   A. server — a settings file that only has the old single `ai` config shows up
 *      as ONE entry (`default`); a submitted list round-trips; keys are redacted on
 *      read, kept when omitted, and wiped by "清除密钥"; a bogus active id falls back.
 *   B. routing — the ACTIVE entry decides the connection: the probe hits the mock
 *      when it is active and fails when the dead entry is, and a real chat carries
 *      the active entry's model name (checked against the mock's /last-request).
 *   C. UI (headless Chrome) — add / switch / delete a model, save, verify the list
 *      and fields follow, "获取模型列表" still fills the catalog, and "测试连接"
 *      works with the picked entry.
 *
 * Usage: node verify/models-ui.mjs [serverPort] [chromePort] [mockPort]
 *   (expects an IDE server started with KEIL_IDE_PORT=<serverPort>; default 4896)
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const serverPort = process.argv[2] ?? '4896'
const chromePort = process.argv[3] ?? '9335'
const mockPort = process.argv[4] ?? '4905'
const base = `http://127.0.0.1:${serverPort}`
const mockBase = `http://127.0.0.1:${mockPort}/v1`
const DEAD = 'http://127.0.0.1:9/v1'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

const waitFor = async (url, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mock = spawn(process.execPath, [join(here, 'mock-openai.mjs'), String(mockPort)], { stdio: 'ignore', windowsHide: true })
process.on('exit', () => mock.kill())

if (!(await waitFor(`${base}/api/health`))) {
  console.error(`no IDE server on ${base} — start one with KEIL_IDE_PORT=${serverPort}`)
  process.exit(2)
}
if (!(await waitFor(`http://127.0.0.1:${mockPort}/v1/models`))) {
  console.error('mock OpenAI server did not start')
  process.exit(2)
}

const getSettings = () => fetch(`${base}/api/settings`).then((response) => response.json())
const postSettings = (body) =>
  fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json())
const probeModels = () =>
  fetch(`${base}/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ai: {}, refresh: true }),
  }).then((response) => response.json())
const sendChat = () =>
  fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '用一句话打个招呼', project: '', skill: '' }),
  }).then(async (response) => {
    await response.text() // drain the SSE stream so the mock has finished
    return fetch(`http://127.0.0.1:${mockPort}/last-request`).then((r) => r.json())
  })

/* ---------- A. server rules ---------- */

let settings = await getSettings()
check('legacy single config becomes one entry', [settings.models?.length, settings.models?.[0]?.id], [1, 'default'])
check('read redacts the key', ['apiKey' in (settings.models?.[0] ?? {}), settings.models?.[0]?.apiKeySet], [false, false])

settings = await postSettings({
  models: [
    { id: 'default', label: '默认（死的）', mode: 'openai', baseURL: DEAD, model: 'dead-model' },
    { id: 'mock', label: 'Mock', mode: 'openai', baseURL: mockBase, model: 'mock-model', apiKey: 'sk-test-1234' },
  ],
  activeModelId: 'mock',
})
check('two entries saved', settings.models.map((entry) => entry.id), ['default', 'mock'])
check('active entry saved', settings.activeModelId, 'mock')
check('key redacted, hint kept', [settings.models[1].apiKeySet, settings.models[1].apiKeyHint, 'apiKey' in settings.models[1]], [true, '****1234', false])

const settingsFile = (await getSettings()).paths.settingsFile
const onDisk = JSON.parse(await readFile(settingsFile, 'utf8'))
check('key really persisted to disk', onDisk.models.find((entry) => entry.id === 'mock')?.apiKey, 'sk-test-1234')

settings = await postSettings({ models: settings.models, activeModelId: 'mock' })
check('omitted key is kept (not wiped)', settings.models[1].apiKeySet, true)

const probeActive = await probeModels()
check('probe uses the ACTIVE entry (mock)', [probeActive.ok, probeActive.models?.includes('mock-c51-model')], [true, true])

const chat = await sendChat()
check('chat carries the active entry model', chat.model, 'mock-model')
check('chat used the active entry base URL (mock got the request)', chat.messages?.length > 0, true)

/** The two entries the rest of the run keeps switching between. */
const catalogue = (overrides = {}) => [
  { id: 'default', label: '默认（死的）', mode: 'openai', baseURL: DEAD, model: 'dead-model' },
  { id: 'mock', label: 'Mock', mode: 'openai', baseURL: mockBase, model: 'mock-model', apiKey: 'sk-test-1234', ...overrides },
]

// --- catalogue metadata and the two parameters chat/completions can express ---
settings = await postSettings({
  models: catalogue({ contextWindow: 128000, maxOutputTokens: 123, reasoningEffort: 'low', thinking: true, supportsImages: true }),
  activeModelId: 'mock',
})
const entry = settings.models[1]
check(
  'catalogue fields round-trip',
  [entry.contextWindow, entry.maxOutputTokens, entry.reasoningEffort, entry.thinking, entry.supportsImages],
  [128000, 123, 'low', true, true],
)

let request = await sendChat()
check('per-model output cap becomes max_tokens', request.max_tokens, 123)
check('reasoning effort low goes out as low', request.reasoning_effort, 'low')

await postSettings({ models: catalogue({ reasoningEffort: 'max' }), activeModelId: 'mock' })
request = await sendChat()
check('max is sent as high (chat/completions has no max)', request.reasoning_effort, 'high')

await postSettings({ models: catalogue({ reasoningEffort: 'off' }), activeModelId: 'mock' })
request = await sendChat()
check('off sends no reasoning_effort at all', 'reasoning_effort' in request, false)

await postSettings({ models: catalogue({ maxOutputTokens: 0 }), activeModelId: 'mock' })
request = await sendChat()
// The global cap defaults to 0 = "unlimited", so the field is not sent at all.
check('no cap at all sends no max_tokens', 'max_tokens' in request, false)

settings = await postSettings({
  models: catalogue({ contextWindow: -5, maxOutputTokens: 'abc', reasoningEffort: 'turbo' }),
  activeModelId: 'mock',
})
check(
  'invalid catalogue values are normalized',
  [settings.models[1].contextWindow, settings.models[1].maxOutputTokens, settings.models[1].reasoningEffort],
  [0, 0, 'off'],
)

await postSettings({ activeModelId: 'default' })
const probeDead = await probeModels()
check('switching the active entry really switches the endpoint', probeDead.ok, false)
await postSettings({ activeModelId: 'mock' })

settings = await postSettings({ ai: { clearApiKey: true } })
check('clear wipes every model key', settings.models.map((entry) => entry.apiKeySet), [false, false])

settings = await postSettings({
  models: [
    { id: 'a', label: 'A', mode: 'openai', baseURL: mockBase, model: 'mock-c51-model' },
    { id: 'b', label: 'B', mode: 'openai', baseURL: mockBase, model: 'mock-c51-mini' },
  ],
  activeModelId: 'nope',
})
check('invalid active id falls back to the first', settings.activeModelId, 'a')

// --- the chat-side picker endpoint (what the footer button calls) ---
const selectModel = (body) =>
  fetch(`${base}/api/models/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, ...(await response.json()) }))

let picked = await selectModel({ id: 'nope' })
check('select: unknown model is a 404', picked.status, 404)
picked = await selectModel({ id: 'a', reasoningEffort: 'turbo' })
check('select: unknown effort is a 400', picked.status, 400)

settings = await postSettings({
  models: catalogue({ contextWindow: 128000, maxOutputTokens: 123, reasoningEffort: 'low', thinking: true, supportsImages: true }),
  activeModelId: 'mock',
})
picked = await selectModel({ id: 'default' })
check('select: switches the active model', [picked.status, picked.activeModelId], [200, 'default'])
picked = await selectModel({ id: 'mock', reasoningEffort: 'max' })
check('select: updates that entry reasoning level', [picked.activeModelId, picked.models[1].reasoningEffort], ['mock', 'max'])
picked = await selectModel({ id: 'mock', reasoningEffort: 'low' })
check('select: level is changeable again', picked.models[1].reasoningEffort, 'low')

settings = await postSettings({
  models: catalogue({ contextWindow: 128000, maxOutputTokens: 123, reasoningEffort: 'low', thinking: true, supportsImages: true }),
  activeModelId: 'mock',
})

/* ---------- C. UI ---------- */

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const { existsSync } = await import('node:fs')
const chrome = chromeCandidates.find((path) => existsSync(path))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}

const profile = join(tmpdir(), `dsh-chrome-models-${chromePort}`)
await rm(profile, { recursive: true, force: true }).catch(() => undefined)
await mkdir(profile, { recursive: true })
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
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
const send = (method, params = {}) =>
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
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result))
  return result?.result?.value
}
const until = async (expression, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

// Wait for boot to have BOUND the button, not just for the element to exist: the
// first click used to land before boot() finished wiring the dialog (a race that
// only shows up on cold/slow starts).
check(
  'page loaded',
  await until(`document.readyState === 'complete' && typeof document.getElementById('btn-settings').onclick === 'function'`),
  true,
)
await evaluate(`(() => {
  document.getElementById('btn-settings').click()
  document.querySelector('.settings-tabs .tab[data-tab="ai"]').click()
  return true
})()`)
check('settings dialog open', await until(`!document.getElementById('settings').classList.contains('hidden')`), true)

const before = await evaluate(`(() => ({
  options: [...document.querySelectorAll('#ai-model-list option')].map((option) => option.textContent),
  active: document.getElementById('ai-model-list').value,
  label: document.getElementById('ai-label').value,
  baseURL: document.getElementById('ai-baseurl').value,
  model: document.getElementById('ai-model').value,
  keyPlaceholder: document.getElementById('ai-key').placeholder,
  context: document.getElementById('ai-context').value,
  maxOutput: document.getElementById('ai-max-output').value,
  effort: document.getElementById('ai-effort').value,
  thinking: document.getElementById('ai-thinking').checked,
  images: document.getElementById('ai-images').checked,
}))()`)
check('existing models listed', before.options, ['默认（死的）', 'Mock'])
check('active model preselected', before.active, 'mock')
check('fields show the active entry', [before.label, before.baseURL, before.model], ['Mock', mockBase, 'mock-model'])
check('key placeholder says it is stored', /已保存 \*\*\*\*1234/.test(before.keyPlaceholder), true)
check(
  'catalogue fields shown for the entry',
  [before.context, before.maxOutput, before.effort, before.thinking, before.images],
  ['128000', '123', 'low', true, true],
)

await evaluate(`(() => {
  document.getElementById('btn-model-add').click()
  document.getElementById('ai-label').value = '本地测试'
  document.getElementById('ai-baseurl').value = ${JSON.stringify(mockBase)}
  document.getElementById('ai-model').value = 'ui-model'
  document.getElementById('ai-key').value = 'sk-ui-5678'
  document.getElementById('ai-context').value = '64000'
  document.getElementById('ai-max-output').value = '2048'
  document.getElementById('ai-effort').value = 'high'
  document.getElementById('ai-thinking').checked = true
  document.getElementById('btn-settings-save').click()
  return true
})()`)
check('save reported', await until(`/已保存到 settings.json/.test(document.getElementById('settings-status').textContent)`), true)

let after = await getSettings()
check('new model persisted', after.models.map((entry) => entry.label), ['默认（死的）', 'Mock', '本地测试'])
const newId = after.models[2].id
check('new model is active', after.activeModelId, newId)
check('new model key stored + redacted', [after.models[2].apiKeySet, after.models[2].apiKeyHint, 'apiKey' in after.models[2]], [true, '****5678', false])
check(
  'new model catalogue saved',
  [after.models[2].contextWindow, after.models[2].maxOutputTokens, after.models[2].reasoningEffort, after.models[2].thinking, after.models[2].supportsImages],
  [64000, 2048, 'high', true, false],
)
check('list reflects the save', await evaluate(`document.querySelectorAll('#ai-model-list option').length`), 3)

// Switching entries must move the fields with it.
const switched = await evaluate(`(() => {
  const select = document.getElementById('ai-model-list')
  select.value = 'default'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return {
    baseURL: document.getElementById('ai-baseurl').value,
    label: document.getElementById('ai-label').value,
    context: document.getElementById('ai-context').value,
    effort: document.getElementById('ai-effort').value,
  }
})()`)
check('switching loads that entry', [switched.label, switched.baseURL], ['默认（死的）', DEAD])
check('switching loads its catalogue too', [switched.context, switched.effort], ['', 'off'])

const back = await evaluate(`(() => {
  const select = document.getElementById('ai-model-list')
  select.value = ${JSON.stringify(newId)}
  select.dispatchEvent(new Event('change', { bubbles: true }))
  document.getElementById('btn-ai-test').click()
  return { context: document.getElementById('ai-context').value, effort: document.getElementById('ai-effort').value }
})()`)
check('switching back restores the catalogue', [back.context, back.effort], ['64000', 'high'])
check('test connection uses the picked entry', await until(`/连接成功/.test(document.getElementById('settings-status').textContent)`), true)

await evaluate(`document.getElementById('btn-fetch-models').click(); true`)
check('获取模型列表 still fills the catalog', await until(`/2 个可用模型/.test(document.getElementById('model-hint').textContent)`), true)
check(
  'catalog options include the endpoint model',
  (await evaluate(`[...document.querySelectorAll('#ai-model-select option')].map((option) => option.value)`)).includes('mock-c51-model'),
  true,
)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile('verify/screenshot-models.png', Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-models.png')
}

await evaluate(`(() => {
  document.getElementById('btn-model-delete').click()
  document.getElementById('btn-settings-save').click()
  return true
})()`)
check('delete + save reported', await until(`/已保存到 settings.json/.test(document.getElementById('settings-status').textContent)`), true)
after = await getSettings()
check('deleted model is gone', after.models.map((entry) => entry.label), ['默认（死的）', 'Mock'])
// Deleting the third entry selects its neighbour (the previous one), which is what
// the dialog then shows — "default" would have been a different, surprising jump.
check('active falls back to the neighbouring entry', after.activeModelId, 'mock')

/* ---------- D. chat footer picker (model + reasoning level) ---------- */

await evaluate(`document.getElementById('btn-settings-close').click(); true`)
check('footer chip shows model + level', await evaluate(`document.getElementById('btn-model-picker').textContent`), 'Mock · Low')

const menu = await evaluate(`(() => {
  document.getElementById('btn-model-picker').click()
  const menu = document.getElementById('model-menu')
  const nodes = [...menu.children]
  const first = nodes.findIndex((node) => node.classList.contains('group'))
  const second = nodes.findIndex((node, index) => index > first && node.classList.contains('group'))
  const text = (node) => node.firstElementChild.textContent.replace('✓', '').trim()
  const rect = menu.getBoundingClientRect()
  const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + Math.min(rect.height / 2, 20)))
  return {
    groups: nodes.filter((node) => node.classList.contains('group')).map((node) => node.textContent),
    models: nodes.slice(first + 1, second).map(text),
    efforts: nodes.slice(second + 1).map(text),
    onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth,
    hitInside: !!hit && !!hit.closest('#model-menu'),
  }
})()`)
check('picker has both sections', menu.groups, ['模型', '推理等级'])
check('picker lists every model', menu.models, ['默认（死的）', 'Mock'])
check('picker lists every level', menu.efforts, ['默认', 'Low', 'High', 'Max'])
check('picker is on screen', menu.onScreen, true)
check('picker is not clipped', menu.hitInside, true)

await evaluate(`(() => {
  const item = [...document.querySelectorAll('#model-menu .item')].find((node) => node.textContent.includes('默认（死的）'))
  item.click()
  return true
})()`)
check('picking a model updates the chip', await until(`document.getElementById('btn-model-picker').textContent.includes('默认（死的）')`), true)
let live = await getSettings()
check('picking a model persists', live.activeModelId, 'default')

await evaluate(`(() => {
  document.getElementById('btn-model-picker').click()
  const item = [...document.querySelectorAll('#model-menu .item')].find((node) => node.textContent.includes('High'))
  item.click()
  return true
})()`)
check('picking a level updates the chip', await until(`/High/.test(document.getElementById('btn-model-picker').textContent)`), true)
live = await getSettings()
check('picking a level persists on that entry', live.models[0].reasoningEffort, 'high')
check('picking a level keeps the active model', live.activeModelId, 'default')

const escape = await evaluate(`(() => {
  document.getElementById('btn-model-picker').click()
  const opened = !document.getElementById('model-menu').classList.contains('hidden')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return { opened, closed: document.getElementById('model-menu').classList.contains('hidden') }
})()`)
check('Escape closes the picker', escape, { opened: true, closed: true })

await evaluate(`document.getElementById('btn-model-picker').click(); true`)
const pickerShot = await send('Page.captureScreenshot', { format: 'png' })
if (pickerShot?.data) {
  await writeFile('verify/screenshot-model-picker.png', Buffer.from(pickerShot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-model-picker.png')
}
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)

await rm(profile, { recursive: true, force: true }).catch(() => undefined)
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
mock.kill()
process.exit(failed ? 1 : 0)
