#!/usr/bin/env node
/**
 * Unit test for the chat Markdown renderer, extracted from public/app.js and run
 * against a minimal DOM stub.
 *
 * Why the watchdog: a SYNCHRONOUS infinite loop cannot be interrupted inside the
 * process, so the real run happens in a child process with a hard timeout. That is
 * exactly the failure mode we saw in the app (the first CDP evaluate never returned
 * and the renderer stayed frozen).
 *
 * Usage: node verify/md-unit.mjs [fixtureFile]
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = process.argv[2] ?? 'C:\\Users\\23106\\Desktop\\新建 文本文档 (13).txt'

if (process.argv[2] !== '--child' && process.argv[3] !== '--child') {
  const started = Date.now()
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), fixture, '--child'], {
    timeout: 20000,
    encoding: 'utf8',
  })
  const ms = Date.now() - started
  if (run.stdout) process.stdout.write(run.stdout)
  if (run.stderr) process.stdout.write(run.stderr)
  if (run.error?.code === 'ETIMEDOUT' || run.signal) {
    console.log(`FAIL  渲染器在 ${ms}ms 内没有结束 → 存在同步死循环（页面会卡死）`)
    process.exit(1)
  }
  console.log(`\n子进程用时 ${ms}ms，退出码 ${run.status}`)
  process.exit(run.status ?? 1)
}

/* ---------------- child: minimal DOM + the real renderer ---------------- */

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.childNodes = []
    this.style = {}
    this.dataset = {}
    this._text = ''
  }
  appendChild(child) {
    this.childNodes.push(child)
    return child
  }
  append(...children) {
    for (const child of children) this.childNodes.push(child)
  }
  set textContent(value) {
    this._text = String(value)
    this.childNodes = []
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._text
    return this.childNodes.map((child) => child.textContent).join('')
  }
  querySelectorAll(selector) {
    const wanted = selector.split(',').map((part) => part.trim().toUpperCase())
    const found = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (wanted.includes(child.tagName)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

globalThis.document = {
  createElement: (tag) => new Node(tag),
  createTextNode: (text) => {
    const node = new Node('#text')
    node._text = String(text)
    return node
  },
  createDocumentFragment: () => new Node('#fragment'),
}
globalThis.state = { monaco: null }

const source = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8')
const start = source.indexOf('/* ---------- tiny Markdown renderer')
const end = source.indexOf('function appendMessage')
if (start < 0 || end < 0) {
  console.error('无法从 app.js 里定位渲染器代码块')
  process.exit(1)
}
const rendererSource = source.slice(start, end)
// eslint-disable-next-line no-new-func
const factory = new Function(`${rendererSource}; return { renderMarkdown, renderInline }`)
const { renderMarkdown } = factory()

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

const text = readFileSync(fixture, 'utf8')
console.log(`样本: ${fixture}（${text.split('\n').length} 行，${text.length} 字符）`)

// 1) the whole document must terminate
const fragment = renderMarkdown(text)
check('整篇渲染完成（没有死循环）', fragment.childNodes.length > 0, true)

// 2) it must not leave raw markdown markers behind
const plain = fragment.textContent
check('没有裸的 ## 标题', /^\s*#{1,6}\s/m.test(plain), false)
check('没有裸的 **', plain.includes('**'), false)
check('没有裸的 ```', plain.includes('```'), false)

// 3) structure came out right
check('产生了标题节点', fragment.querySelectorAll('h3,h4,h5,h6').length > 0, true)
check('产生了列表项', fragment.querySelectorAll('li').length > 3, true)
// `pre` specifically: inline `code` alone must not satisfy the fenced-block check.
check('产生了代码块（<pre>）', fragment.querySelectorAll('pre').length > 0, true)
check('产生了加粗', fragment.querySelectorAll('strong').length > 0, true)

// 3b) CRLF input must render the same as LF input (the app receives both).
const lf = renderMarkdown(text.replace(/\r\n?/g, '\n'))
check('CRLF 与 LF 渲染出的结构一致', fragment.querySelectorAll('li').length === lf.querySelectorAll('li').length && fragment.querySelectorAll('pre').length === lf.querySelectorAll('pre').length, true)

// 4) pathological inputs must also terminate
const nasty = [
  '```c\nint a;\n',
  '```\nunclosed fence\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n',
  '# \n',
  '- \n- \n',
  '1. a\n2) b\n',
  '> quote\n>> nested\n',
  '*'.repeat(200),
  '`'.repeat(50),
  '- `a` **b** *c* [d](e) https://x.y\n',
  '\r\n\r\n混合\r\n行尾\r\n',
]
let nastyOk = true
for (const sample of nasty) {
  try {
    renderMarkdown(sample)
  } catch (error) {
    nastyOk = false
    console.log(`      异常样本 ${JSON.stringify(sample.slice(0, 20))}: ${error.message}`)
  }
}
check('异常/边界输入都能终止且不抛异常', nastyOk, true)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
