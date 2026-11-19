#!/usr/bin/env node
/**
 * Silent skill injection — BROWSER acceptance (headless Chrome + CDP).
 *
 * Proves the property this feature is about, in the real UI rather than in source
 * text: the user types a question, presses 发送, and
 *   1. the skill block really reaches the model (checked on the mock endpoint);
 *   2. the composer is empty afterwards and NEVER held skill text;
 *   3. the transcript shows only the user's own words — no skill marker;
 *   4. 设置 → 技能 carries the "自动注入" switch, on by default.
 *
 * Self-contained: starts its own IDE host + mock OpenAI endpoint + Chrome.
 * Usage: node verify/skill-inject-ui.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4894
const mockPort = 4895
const chromePort = 9335
const base = `http://127.0.0.1:${port}`
const work = await mkdtemp(join(tmpdir(), 'keil-skill-inject-ui-'))
const home = join(work, 'home')
await mkdir(home, { recursive: true })

const QUESTION = '定时器中断进不去，EA 和 ET0 都设了但没有反应'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}

const siblings = []
const killAll = () => {
  for (const child of siblings) child.kill()
}
process.on('exit', killAll)

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  KEIL_IDE_PORT: String(port),
  KEIL_IDE_SETTINGS: join(work, 'settings.json'),
  KEIL_IDE_AI_MODE: 'openai',
  KEIL_IDE_AI_BASEURL: `http://127.0.0.1:${mockPort}/v1`,
  KEIL_IDE_AI_KEY: 'test',
  KEIL_IDE_INLINE: '0',
  KEIL_IDE_SKILL_DIRS: '',
}
siblings.push(
  spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
    cwd: join(root, 'keil-ide'),
    env,
    stdio: 'ignore',
    windowsHide: true,
  }),
  spawn(process.execPath, [join(root, 'keil-ide', 'verify', 'mock-openai.mjs'), String(mockPort)], {
    stdio: 'ignore',
    windowsHide: true,
  }),
)

const waitFor = async (url, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}
if (!(await waitFor(`${base}/api/health`)) || !(await waitFor(`http://127.0.0.1:${mockPort}/v1/models`))) {
  console.error('could not start the test host (ports 4894/4895 busy?)')
  process.exit(2)
}

const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}

const profile = join(tmpdir(), `dsh-chrome-skill-inject-${chromePort}`)
await mkdir(profile, { recursive: true })
siblings.push(
  spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    base,
  ], { stdio: 'ignore', windowsHide: true }),
)

let target
for (let attempt = 0; attempt < 80; attempt += 1) {
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
const until = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

check('page loaded', await until(`document.readyState === 'complete' && !!document.getElementById('btn-send')`), true)
// `readyState === 'complete'` is not enough: app.js assigns the click handlers
// after its first settings round-trip, and a click before that silently does
// nothing (this test lost a run to exactly that race).
check('发送按钮已绑定事件', await until(`typeof document.getElementById('btn-send').onclick === 'function'`, 20000), true)
check('技能下拉默认是自动匹配', await evaluate(`document.getElementById('skill').options[0].textContent`), '（自动匹配）')

// Type like a user: native setter + input event, then press 发送. Nothing about a
// skill is written into the box — that is the point of the test.
await evaluate(`(() => {
  const box = document.getElementById('prompt')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(box, ${JSON.stringify(QUESTION)})
  box.dispatchEvent(new Event('input', { bubbles: true }))
  document.getElementById('btn-send').click()
  return true
})()`)

const answered = await until(`document.querySelectorAll('#transcript .msg').length >= 2 && document.getElementById('btn-send').textContent.trim() === '发送'`, 60000)
check('收到回答，发送按钮复位', answered, true)

const ui = await evaluate(`(() => {
  const messages = [...document.querySelectorAll('#transcript .msg')]
  const user = messages.find((box) => box.classList.contains('user'))
  const ai = messages.filter((box) => box.classList.contains('ai')).at(-1)
  return {
    composer: document.getElementById('prompt').value,
    userMeta: user?.querySelector('.meta')?.textContent ?? '',
    userText: user?.bodyEl?.textContent?.trim() ?? '',
    aiMeta: ai?.querySelector('.meta')?.textContent ?? '',
    aiText: ai?.bodyEl?.textContent ?? '',
    transcriptHasSkill: /skill_content|<skill_resources>/.test(document.getElementById('transcript').innerText),
    bodyHasSkill: /skill_content/.test(document.body.innerHTML),
  }
})()`)
console.log(`      transcript: ${JSON.stringify({ ...ui, userText: ui.userText.slice(0, 40), aiText: ui.aiText.slice(0, 30) })}`)
check('输入框发送后为空', ui.composer, '')
check('用户气泡里没有技能标记', /技能/.test(ui.userMeta), false)
check('用户气泡就是原话', ui.userText, QUESTION)
check('页面里完全不出现 skill_content', [ui.transcriptHasSkill, ui.bodyHasSkill], [false, false])
check('AI 气泡是这次真实回答', ui.aiText.includes('[mock]'), true)

const wire = await fetch(`http://127.0.0.1:${mockPort}/last-request`).then((response) => response.json())
const userMessage = String(wire?.messages?.find((message) => message.role === 'user')?.content ?? '')
const systemMessage = String(wire?.messages?.find((message) => message.role === 'system')?.content ?? '')
check('模型收到的用户消息以技能块开头', userMessage.startsWith('<skill_content name="8051-timer">'), true)
check('模型收到的用户消息里有原话', userMessage.includes(QUESTION), true)
check('系统提示词里没有技能块', systemMessage.includes('<skill_content'), false)

// The settings switch, on its own tab.
await evaluate(`(() => {
  document.getElementById('btn-settings').click()
  document.querySelector('.settings-tabs .tab[data-tab="skills"]').click()
  return true
})()`)
check('技能设置页打开', await until(`!document.getElementById('settings').classList.contains('hidden')`), true)
check('自动注入开关默认打开', await evaluate(`document.getElementById('skills-auto-inject').checked`), true)
check('开关旁边有说明', await evaluate(`!!document.getElementById('skills-auto-inject').closest('label')?.textContent.includes('自动注入')`), true)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(root, 'keil-ide', 'verify', 'screenshot-skill-auto-inject.png'), Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-skill-auto-inject.png')
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
killAll()
process.exit(failed ? 1 : 0)
