#!/usr/bin/env node
/**
 * Chat layout probe — measures WHY a long answer looks cut off in the AI pane.
 *
 * It reproduces the reported shape (thinking block + FILE: line + a tall fenced
 * code block + the character-limit notice) at a narrow 400x866 window, then
 * reports the numbers instead of guessing:
 *   - does the page overflow the viewport (is the composer pushed off-screen)?
 *   - is #transcript the scroll container, and how tall is it?
 *   - does a .msg bubble overflow horizontally?
 *   - how much of the code block is visible (client vs scroll height/width)?
 *
 * Usage: node verify/chat-layout.mjs
 * Prints JSON + writes verify/screenshot-chat-layout.png
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = Number(process.env.PROBE_PORT ?? 4896)
const chromePort = Number(process.env.PROBE_CHROME ?? 9336)
const base = `http://127.0.0.1:${port}`
const work = await mkdtemp(join(tmpdir(), 'keil-chat-layout-'))
const home = join(work, 'home')
await mkdir(home, { recursive: true })

const children = []
const killAll = () => {
  for (const child of children) child.kill()
}
process.on('exit', killAll)

children.push(
  spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
    cwd: join(root, 'keil-ide'),
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      KEIL_IDE_PORT: String(port),
      KEIL_IDE_SETTINGS: join(work, 'settings.json'),
      KEIL_IDE_AI_MODE: 'openai',
      KEIL_IDE_AI_BASEURL: 'http://127.0.0.1:9/v1',
      KEIL_IDE_AI_KEY: 'x',
      KEIL_IDE_INLINE: '0',
    },
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
if (!(await waitFor(`${base}/api/health`))) {
  console.error(`no server on ${base}`)
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
const profile = join(tmpdir(), `dsh-chrome-chat-layout-${chromePort}`)
await mkdir(profile, { recursive: true })
children.push(
  spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    '--window-size=400,866',
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
const until = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

await until(`document.readyState === 'complete' && typeof appendMessage === 'function'`)

// User shape: a narrow window (the screenshot was 400x866), the AI pane dragged
// wide and the reply area dragged tall — both values persist in localStorage, so
// they survive window resizes and can end up bigger than the window.
const VIEW_W = Number(process.env.PROBE_W ?? 400)
const VIEW_H = Number(process.env.PROBE_H ?? 866)
const CHAT_W = Number(process.env.PROBE_CHAT ?? 380)
const REPLY_H = Number(process.env.PROBE_REPLY ?? 700)
await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false })
await evaluate(`(() => {
  document.documentElement.style.setProperty('--chat-w', '${CHAT_W}px')
  document.documentElement.style.setProperty('--reply-h', '${REPLY_H}px')
  document.getElementById('pane-chat').classList.add('sized')
  return true
})()`)
await new Promise((done) => setTimeout(done, 200))

// Build the reported shape: a long chain of thought, the FILE: marker, a tall
// code block, and the character-limit notice — all inside one AI bubble.
const CODE_LINES = ['#include <reg51.h>', 'sbit K1 = P3^0;', '']
CODE_LINES.push('long calc(long a, long b, unsigned char o)', '{')
CODE_LINES.push('    long r;')
CODE_LINES.push('    switch (o)')
CODE_LINES.push('    {')
CODE_LINES.push('        case 10: r = a + b; break;')
CODE_LINES.push('        case 11: r = a - b; break;')
CODE_LINES.push('        case 12: r = a * b; break;')
CODE_LINES.push('        default: r = b;     break;')
CODE_LINES.push('    }')
CODE_LINES.push('    if (r < 0)   r = 0;')
CODE_LINES.push('    if (r > 99)  r = 99;')
CODE_LINES.push('    return r;')
CODE_LINES.push('}')
CODE_LINES.push('')
for (let index = 0; index < 20; index += 1) CODE_LINES.push(`/* 长文件继续第 ${index + 1} 段：这一段用来撑高代码块 */`)
CODE_LINES.push('void main(void) { while (1) { } }')

const ANSWER = `FILE: E:\\tese\\new\\main.c\n\n\`\`\`c\n${CODE_LINES.join('\n')}\n\`\`\`\n`
const THOUGHTS = '先确认需求：矩阵键盘 B0-B9 代表 0-9，B10 代表 "+"，B11 代表 "-"，B12 代表 "*"，B13 代表 "="，仅将结果显示在最右边两个数码管上。'.repeat(30)

const report = await evaluate(`(() => {
  const transcript = document.getElementById('transcript')
  const box = appendMessage('ai', 'AI（流式 · deepseek-flash）', '')
  setThinkText(box, ${JSON.stringify(THOUGHTS)})
  box.thinkEl.open = false // the streaming path folds it away on the first answer token
  box.setBody(${JSON.stringify(ANSWER)})
  box.bodyEl.appendChild(charLimitNote({ limit: 20000, chars: 20000 }))
  transcript.scrollTop = transcript.scrollHeight
  const rect = (element) => {
    const r = element.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const pre = box.querySelector('.md pre')
  const preStyle = getComputedStyle(pre)
  const user = document.createElement('div')
  user.className = 'msg user'
  user.textContent = '代表"-"，B12代表"*"，B13代表"="，仅将结果显示在最右边两个数码管上。'
  transcript.insertBefore(user, box)
  return {
    viewport: { w: innerWidth, h: innerHeight },
    body: { scrollH: document.body.scrollHeight, clientH: document.body.clientHeight },
    pageOverflow: document.body.scrollHeight - innerHeight,
    chatRect: rect(document.querySelector('.chat')),
    transcript: { ...rect(transcript), scrollH: transcript.scrollHeight, clientH: transcript.clientHeight },
    // A squeezed flex child keeps its content OUTSIDE its own box, so the pane's
    // scrollHeight stops at the box edge and the last part is unreachable — exactly
    // "the outer scrollbar cannot show the whole answer".
    msgBoxes: [...document.querySelectorAll('#transcript .msg')].map((node) => ({
      cls: node.className,
      h: Math.round(node.getBoundingClientRect().height),
      scrollH: node.scrollHeight,
      clientH: node.clientHeight,
      squeezed: node.scrollHeight > node.clientHeight + 2,
    })),
    transcriptContentSum: [...document.querySelectorAll('#transcript .msg')]
      .reduce((sum, node) => sum + Math.round(node.getBoundingClientRect().height), 0),
    composer: { rect: rect(document.getElementById('prompt')), visible: (() => {
      // Hit-test, not just geometry: a clipped child still reports its layout rect.
      const el = document.getElementById('prompt')
      const r = el.getBoundingClientRect()
      if (r.top < 0 || r.bottom > innerHeight || r.width < 40 || r.height < 20) return false
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      return hit === el || el.contains(hit)
    })() },
    sendButton: rect(document.getElementById('btn-send')),
    msgRect: rect(box),
    msgOverflowX: box.scrollWidth - box.clientWidth,
    pre: { ...rect(pre), scrollH: pre.scrollHeight, clientH: pre.clientHeight, scrollW: pre.scrollWidth, clientW: pre.clientWidth, maxHeight: preStyle.maxHeight, overflowX: preStyle.overflowX, overflowY: preStyle.overflowY },
    // The reported symptom: "回答的下面根本没显示". Two things must hold — the code
    // block has no scrollbar of its own, and after scrolling the transcript to the
    // end the LAST line of the answer is actually on screen.
    preFirstLine: (pre.textContent || '').split('\\n')[0],
    preLastLine: (pre.textContent || '').trim().split('\\n').pop(),
    tailReachable: (() => {
      const pane = document.getElementById('transcript')
      pane.scrollTop = pane.scrollHeight
      const preBox = pre.getBoundingClientRect()
      const paneBox = pane.getBoundingClientRect()
      // A tall block cannot be fully on screen at once; what matters is that its
      // BOTTOM (the last line) is inside the pane after scrolling to the end.
      const lastLineOnScreen = preBox.bottom <= paneBox.bottom + 2
      return {
        scrolledToEnd: Math.round(pane.scrollTop) + Math.round(pane.clientHeight) >= Math.round(pane.scrollHeight) - 2,
        preBottom: Math.round(preBox.bottom),
        paneBottom: Math.round(paneBox.bottom),
        lastLineOnScreen,
      }
    })(),
  }
})()`)
console.log(JSON.stringify(report, null, 2))

// Checks, not just numbers: the two symptoms this script exists for.
let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}
check('页面不溢出窗口', report.pageOverflow, 0)
check('输入框真的可见（命中测试）', report.composer.visible, true)
check('代码块没有自己的滚动条', Math.abs(report.pre.scrollH - report.pre.clientH) <= 2, true)
check('代码块没有横向裁切', Math.abs(report.pre.scrollW - report.pre.clientW) <= 2, true)
check('代码块保留注入的首行', report.preFirstLine, CODE_LINES[0])
check('代码块保留注入的末行', report.preLastLine, CODE_LINES[CODE_LINES.length - 1])
check('滚到底就是回答的末尾（最后一行在屏幕内）', report.tailReachable.lastLineOnScreen, true)
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile(join(root, 'keil-ide', 'verify', 'screenshot-chat-layout.png'), Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-chat-layout.png')
}
socket.close()
killAll()
process.exit(0)
