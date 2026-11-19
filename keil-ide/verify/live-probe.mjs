#!/usr/bin/env node
/**
 * Probe the REAL running Fixpoint window over CDP (no headless copy, no guessing).
 *
 * It injects one long answer through the app's own appendMessage() — the same path
 * the stream uses — scrolls the transcript to the end, then reports whether the
 * last line is reachable and whether any bubble got squeezed out of the pane's
 * scrollHeight. Finally it screenshots the actual window.
 *
 * Usage:
 *   1) start the app with --remote-debugging-port=9223
 *   2) node verify/live-probe.mjs [cdpPort] [--keep]
 *   (without --keep the page is reloaded afterwards so the injected bubble is gone)
 */
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = process.argv[2] ?? '9223'
const keep = process.argv.includes('--keep')

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target on CDP port ' + port)
  process.exit(2)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
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

await until(`document.readyState === 'complete' && typeof appendMessage === 'function'`)

// A realistic long answer: prose, FILE: marker, a 60-line fenced block, and prose
// AFTER the block (that trailing part is what "the answer's bottom" means).
const code = ['#include <reg51.h>', '', 'void timer0_isr(void) interrupt 1', '{', '    unsigned char c, i;', '    TH0 = 0xFB;', '    TL0 = 0x30;']
for (let index = 0; index < 50; index += 1) code.push(`    P0 = seg[${index % 16}]; /* 第 ${index + 1} 行扫描 */`)
code.push('}', '', 'void main(void)', '{', '    TMOD = 0x01;', '    TH0 = 0xFB;', '    TL0 = 0x30;', '    EA = 1;', '    ET0 = 1;', '    TR0 = 1;', '    while (1) { }', '}')
const answer = [
  '这个版本改成中断驱动：定时器 0 的中断里同时做「数码管扫描」和「键盘逐行扫描+消抖」，主循环里不再有 delay_ms() 死等，按键即响。',
  '',
  'FILE: E:\\tese\\new\\main.c',
  '',
  '```c',
  ...code,
  '```',
  '',
  '改完之后：定时器每 2 ms 进一次中断，数码管 4 位轮流亮，键盘扫描用 P1 逐行拉低；主循环只负责把 dispbuf 算好，不再阻塞。',
  '这是回答的最后一行，用来验证滚到底能不能看到它。',
].join('\n')

const report = await evaluate(`(() => {
  const transcript = document.getElementById('transcript')
  const box = appendMessage('ai', 'AI（流式 · live probe）', ${JSON.stringify(answer)})
  transcript.scrollTop = transcript.scrollHeight
  const rect = (element) => {
    const r = element.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
  }
  const messages = [...document.querySelectorAll('#transcript .msg')]
  const pre = box.querySelector('.md pre')
  const pane = rect(transcript)
  const preBox = rect(pre)
  // Range over the very last text of the bubble: is it on screen at max scroll?
  const walker = document.createTreeWalker(box.bodyEl, NodeFilter.SHOW_TEXT)
  let last = null
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) last = walker.currentNode
  let tailRect = null
  if (last) {
    const range = document.createRange()
    range.selectNodeContents(last)
    const r = range.getBoundingClientRect()
    tailRect = { top: Math.round(r.top), bottom: Math.round(r.bottom), text: last.nodeValue.trim().slice(-24) }
  }
  return {
    transcript: { ...pane, scrollH: transcript.scrollHeight, clientH: transcript.clientHeight, clientH2: transcript.clientHeight, thumbRatio: +(transcript.clientHeight / transcript.scrollHeight).toFixed(3) },
    messages: messages.map((node) => ({ h: Math.round(node.getBoundingClientRect().height), scrollH: node.scrollHeight, clientH: node.clientHeight, squeezed: node.scrollHeight > node.clientHeight + 2 })),
    pre: { ...preBox, scrollH: pre.scrollHeight, clientH: pre.clientHeight, scrollW: pre.scrollWidth, clientW: pre.clientWidth },
    tailLine: tailRect,
    tailVisible: tailRect ? tailRect.bottom <= pane.bottom + 1 : false,
    scrolledToEnd: Math.round(transcript.scrollTop) + Math.round(transcript.clientHeight) >= Math.round(transcript.scrollHeight) - 2,
  }
})()`)

console.log(JSON.stringify(report, null, 2))
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  const path = join(root, 'keil-ide', 'verify', 'screenshot-live-probe.png')
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-live-probe.png')
}

const problems = []
if (!report.scrolledToEnd) problems.push('滚动条无法滚到末尾')
if (!report.tailVisible) problems.push('回答最后一行不在屏幕内')
if (report.messages.some((message) => message.squeezed)) problems.push('有消息被压缩（内容溢出但不在 scrollHeight 里）')
if (report.pre.scrollH > report.pre.clientH + 2) problems.push('代码块仍有自己的滚动条')
console.log(problems.length ? `PROBLEMS: ${problems.join('；')}` : 'OK: 滚到底可见回答末尾，且没有内层滚动/压缩')

if (!keep) await evaluate('location.reload(); true')
socket.close()
process.exit(problems.length ? 1 : 0)
