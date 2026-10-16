#!/usr/bin/env node
/**
 * Truncation acceptance for streamed replies. Two independent causes are covered:
 *
 *   1. TAIL LOSS — the provider's last delta arrives WITHOUT a trailing blank line
 *      and the stream just ends. A naive "\n\n" splitter drops it, which is one of
 *      the ways a reply came out cut short. (mock: MOCK_TAIL_NO_BLANK=1)
 *   2. PROVIDER CAP — finish_reason "length": the answer really was cut at the token
 *      limit, so the UI must SAY so instead of silently showing half an answer.
 *      (mock: MOCK_FINISH_LENGTH=1)
 *
 * The script starts its own mock per case, so the two switches cannot interfere.
 *
 * Usage: node verify/chat-truncate.mjs <demoProject> [cdpPort]
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [demoProject, port = '9222'] = process.argv.slice(2)
if (!demoProject) {
  console.error('usage: node verify/chat-truncate.mjs <demoProject> [cdpPort]')
  process.exit(1)
}
const here = dirname(fileURLToPath(import.meta.url))
const mockPath = join(here, 'mock-openai.mjs')

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}
const post = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:4870${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json().catch(() => ({}))
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

/** Start a mock with extra env and wait for its port. */
async function startMock(mockPort, env) {
  const child = spawn(process.execPath, [mockPath, String(mockPort)], {
    stdio: 'ignore',
    env: { ...process.env, ...env },
  })
  for (let i = 0; i < 40; i += 1) {
    await sleep(150)
    try {
      const response = await fetch(`http://127.0.0.1:${mockPort}/v1/models`)
      if (response.ok) return child
    } catch {
      // not up yet
    }
  }
  throw new Error(`mock 没有在 ${mockPort} 起来`)
}

/** Send one chat message through the real UI and return the last AI bubble. */
async function askInUi(text) {
  return JSON.parse(
    (
      await evaluate(`(async () => {
    document.getElementById('prompt').value = ${JSON.stringify(text)}
    document.getElementById('btn-send').click()
    // Wait until the "thinking" button is idle again, i.e. the stream finished.
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 400))
      if (!document.getElementById('btn-send').disabled) break
    }
    await new Promise((r) => setTimeout(r, 600))
    const boxes = [...document.querySelectorAll('#transcript .msg.ai')]
    const box = boxes[boxes.length - 1]
    return JSON.stringify({
      text: box?.bodyEl?.textContent ?? '',
      note: box?.querySelector('.md-note')?.textContent ?? '',
    })
  })()`)
    ).value ?? '{}',
  )
}

await send('Page.enable')
await post('/api/settings', { project: demoProject })
await send('Page.reload', { ignoreCache: true })
await sleep(7000)

const ANSWER_TAIL = 'mock-suggestion.c' // the very last characters of the mock's answer

console.log('--- 1) 尾部丢帧：最后一帧没有结尾空行，回复必须仍然完整 ---')
const tailMock = await startMock(4897, { MOCK_TAIL_NO_BLANK: '1' })
await post('/api/settings', { ai: { baseURL: 'http://127.0.0.1:4897/v1', model: 'mock-c51-model' } })
await send('Page.reload', { ignoreCache: true })
await sleep(5000)
const tailResult = await askInUi('测试尾部丢帧')
check('★ 回复里包含了最后那一段文字（尾部没被丢）', tailResult.text.includes(ANSWER_TAIL), true)
tailMock.kill()

console.log('--- 2) 上游按长度截断：界面必须说明原因 ---')
const capMock = await startMock(4898, { MOCK_FINISH_LENGTH: '1' })
await post('/api/settings', { ai: { baseURL: 'http://127.0.0.1:4898/v1', model: 'mock-c51-model' } })
await send('Page.reload', { ignoreCache: true })
await sleep(5000)
const capResult = await askInUi('测试长度截断')
check('出现了"长度上限被截断"的提示', /长度上限被截断/.test(capResult.note), true)
check('提示里给了可操作的建议', /设置/.test(capResult.note) && /词元/.test(capResult.note), true)
capMock.kill()

await post('/api/settings', { ai: { baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }, project: 'E:\\单片机\\作业2\\C program.uvproj' })
await post('/api/settings', { project: demoProject })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
socket.close()
process.exit(failed ? 1 : 0)
