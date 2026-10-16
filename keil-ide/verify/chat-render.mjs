#!/usr/bin/env node
/**
 * Chat rendering acceptance, using the user's own saved answer as the fixture:
 *   1. an AI message renders as markdown (headings/lists/fenced code/bold) and the
 *      raw `##` / `**` / ``` markers are gone from the text
 *   2. the user's own message shows ONLY their words plus a one-line attachment note
 *      (the attached file used to be pasted into the transcript)
 *   3. a live streamed answer also renders
 *
 * Usage: node verify/chat-render.mjs <fixture.txt> [cdpPort]
 */
import { readFile, writeFile } from 'node:fs/promises'

const [fixturePath, port = '9222'] = process.argv.slice(2)
if (!fixturePath) {
  console.error('usage: node verify/chat-render.mjs <fixture.txt> [cdpPort]')
  process.exit(1)
}
const fixture = await readFile(fixturePath, 'utf8')

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

await send('Page.reload', { ignoreCache: true })
await sleep(7000)

console.log('--- 1) AI 回答渲染成 markdown（用你保存的那份回答当样本）---')
const rendered = await evaluate(`(() => {
  const box = appendMessage('ai', 'AI（渲染测试）', ${JSON.stringify(fixture)})
  const body = box.bodyEl
  const text = body.textContent
  return JSON.stringify({
    headings: [...body.querySelectorAll('h3,h4,h5,h6')].map((h) => h.textContent.slice(0, 18)),
    listItems: body.querySelectorAll('li').length,
    codeBlocks: body.querySelectorAll('pre > code').length,
    bold: body.querySelectorAll('strong').length,
    inlineCode: body.querySelectorAll('code').length,
    // The raw markers must be gone from the visible text.
    rawHeading: /^\\s*#{1,6}\\s/m.test(text),
    rawBold: text.includes('**'),
    rawFence: text.includes('\`\`\`'),
    firstCodeLine: body.querySelector('pre > code')?.textContent.split('\\n')[0] ?? '',
  })
})()`)
const dom = JSON.parse(rendered.value ?? '{}')
check('标题被渲染成 <h3..h6>', (dom.headings ?? []).length > 0, true)
check('列表被渲染成 <li>', (dom.listItems ?? 0) > 3, true)
check('代码块被渲染成 <pre><code>', (dom.codeBlocks ?? 0) > 0, true)
check('加粗被渲染成 <strong>', (dom.bold ?? 0) > 0, true)
check('行内代码 <code> 存在', (dom.inlineCode ?? 0) > 0, true)
check('页面上不再出现裸的 ## 标题', dom.rawHeading, false)
check('页面上不再出现裸的 **', dom.rawBold, false)
check('页面上不再出现裸的 ```', dom.rawFence, false)
check('代码块内容正确', (dom.firstCodeLine ?? '').includes('unsigned int t'), true)

console.log('--- 2) 我的发言只显示原话（不再把附带文件粘进对话）---')
const user = await evaluate(`(async () => {
  document.getElementById('ctx-file').checked = true
  document.getElementById('ctx-errors').checked = true
  document.getElementById('prompt').value = '这个呼吸灯为什么看不出渐变？'
  document.getElementById('btn-send').click()
  await new Promise((r) => setTimeout(r, 4000))
  const boxes = [...document.querySelectorAll('#transcript .msg')]
  const mine = boxes.filter((b) => b.classList.contains('user')).pop()
  const aiBox = boxes.filter((b) => b.classList.contains('ai')).pop()
  return JSON.stringify({
    userText: mine?.textContent ?? '',
    hasRawFile: (mine?.textContent ?? '').includes('当前文件:'),
    hasAttachmentNote: (mine?.textContent ?? '').includes('已附带'),
    // A bare pre is enough: Monaco's colorizer rewrites a block's children into
    // coloured span elements, so requiring "pre > code" would fail on a reply that
    // rendered correctly. (No backticks in this comment: it lives inside a template
    // literal, and a backtick here would terminate the string.)
    aiHasMarkdown: Boolean(aiBox?.querySelector('pre, h3, h4, h5, h6, li, strong')),
    aiText: (aiBox?.textContent ?? '').slice(0, 60),
  })
})()`)
const chat = JSON.parse(user.value ?? '{}')
check('我的发言里有原话', chat.userText.includes('这个呼吸灯为什么看不出渐变'), true)
check('★ 我的发言里不再粘贴附带文件的全文', chat.hasRawFile, false)
check('改为一行小注说明附带了什么', chat.hasAttachmentNote, true)
check('流式回答也渲染了 markdown', chat.aiHasMarkdown, true)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot?.data) {
  const out = 'verify/screenshot-chat-markdown.png'
  await writeFile(out, Buffer.from(shot.data, 'base64'))
  console.log(`screenshot: ${out}`)
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
socket.close()
process.exit(failed ? 1 : 0)
