#!/usr/bin/env node
/**
 * Silent skill injection — end-to-end acceptance. Starts its own host + mock
 * OpenAI endpoint, so one command proves the whole chain:
 *
 *   1. a question that only fits 8051-timer injects that skill WITHOUT the client
 *      naming it, and the block sits at the HEAD of the user message;
 *   2. the system message carries no skill block any more;
 *   3. the user's own words arrive verbatim, once;
 *   4. an explicitly picked skill (the dropdown path) still wins, silently;
 *   5. an unrelated question injects nothing (no false positive);
 *   6. `skills.autoInject:false` really turns auto-selection off;
 *   7. the UI source carries no skill marker into the composer or transcript.
 *
 * Usage: node verify/skill-inject.mjs
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4892
const mockPort = 4893
const base = `http://127.0.0.1:${port}`
const work = await mkdtemp(join(tmpdir(), 'keil-skill-inject-'))
const settingsPath = join(work, 'settings.json')
// An empty HOME keeps `~/.keil-ai/skills` deterministic: only the bundled skills
// can win, whatever the machine's own skill table happens to contain.
const home = join(work, 'home')
await mkdir(home, { recursive: true })

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  KEIL_IDE_PORT: String(port),
  KEIL_IDE_SETTINGS: settingsPath,
  KEIL_IDE_AI_MODE: 'openai',
  KEIL_IDE_AI_BASEURL: `http://127.0.0.1:${mockPort}/v1`,
  KEIL_IDE_AI_KEY: 'test',
  KEIL_IDE_INLINE: '0',
  KEIL_IDE_SKILL_DIRS: '',
}
const server = spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
  cwd: join(root, 'keil-ide'),
  env,
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

const waitFor = async (url, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}
if (!(await waitFor(`${base}/api/health`)) || !(await waitFor(`http://127.0.0.1:${mockPort}/v1/models`))) {
  console.error('could not start the test host (ports 4892/4893 busy?)')
  process.exit(2)
}

/** One chat turn; the answer itself is the mock's, we assert on what reached the wire. */
async function chat(body) {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  const sent = await fetch(`http://127.0.0.1:${mockPort}/last-request`).then((item) => item.json())
  const messages = sent?.messages ?? []
  const systemOf = (list) => String(list.find((message) => message.role === 'system')?.content ?? '')
  const userOf = (list) => String(list.find((message) => message.role === 'user')?.content ?? '')
  return {
    status: response.status,
    body: payload,
    system: systemOf(messages),
    user: userOf(messages),
    messages: messages.length,
  }
}

const TIMER_Q = '定时器中断进不去，EA 和 ET0 都设了但没有反应'
const UNRELATED_Q = '这个呼吸灯看不出渐变，帮我改成分段亮度'

console.log('--- 1) 自动注入（问题里没有技能名） ---')
const auto = await chat({ prompt: TIMER_Q })
check('chat status', auto.status, 200)
check('响应报告用了哪个技能', auto.body.skill, '8051-timer')
check('响应标记为自动挑选', auto.body.skillAuto, true)
check('仍然只有 system + user 两条消息', auto.messages, 2)
check('system 消息里不再有技能块', auto.system.includes('<skill_content'), false)
check('技能块在用户消息最前面', auto.user.startsWith('<skill_content name="8051-timer">'), true)
check('技能块在用户原话之前', auto.user.indexOf('</skill_content>') < auto.user.indexOf(TIMER_Q), true)
check('用户原话逐字到达且只出现一次', [auto.user.includes(TIMER_Q), auto.user.split(TIMER_Q).length - 1], [true, 1])
check('技能正文真的带过去了', auto.user.includes('timer0_isr'), true)

console.log('--- 2) 下拉点名的技能优先，同样静默 ---')
const explicit = await chat({ prompt: UNRELATED_Q, skill: '8051-error-triage' })
check('响应报告点名的技能', explicit.body.skill, '8051-error-triage')
check('不是自动挑选', explicit.body.skillAuto, false)
check('点名技能块也在最前面', explicit.user.startsWith('<skill_content name="8051-error-triage">'), true)

console.log('--- 3) 无关问题不注入 ---')
const none = await chat({ prompt: UNRELATED_Q })
check('响应没有技能', none.body.skill ?? '', '')
check('用户消息里没有 skill_content', none.user.includes('<skill_content'), false)
check('用户消息就是原话', none.user, UNRELATED_Q)

console.log('--- 4) 关掉自动注入 ---')
await fetch(`${base}/api/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ skills: { autoInject: false } }),
})
const off = await chat({ prompt: TIMER_Q })
check('关掉后不再自动注入', off.body.skill ?? '', '')
check('关掉后消息里没有技能块', off.user.includes('<skill_content'), false)
await fetch(`${base}/api/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ skills: { autoInject: true } }),
})
const back = await chat({ prompt: TIMER_Q })
check('重新打开后恢复自动注入', back.body.skill, '8051-timer')

console.log('--- 5) 前端不再把技能写进输入框/对话 ---')
const app = await readFile(join(root, 'keil-ide', 'public', 'app.js'), 'utf8')
const html = await readFile(join(root, 'keil-ide', 'public', 'index.html'), 'utf8')
check('app.js 不再拼接"（技能: …）"标记', app.includes('（技能: '), false)
check('技能下拉默认项是自动匹配', html.includes('（自动匹配）'), true)
check('设置里有自动注入开关', html.includes('id="skills-auto-inject"'), true)

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
cleanup()
process.exit(failed ? 1 : 0)
