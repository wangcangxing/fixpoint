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
 * The sample is BUILT IN on purpose. It used to default to a text file on the
 * author's desktop, so on any other machine (or after that file changed) four
 * structural checks failed for reasons that had nothing to do with the renderer.
 * An external file may still be passed as a second opinion: for it only the
 * "must not hang / must not throw / must not leak raw markers" checks run.
 *
 * Usage: node verify/md-unit.mjs [extraSampleFile]
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extraArg = process.argv[2] ?? ''

if (!process.argv.includes('--child')) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), extraArg || '-', '--child'], {
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

/** Slice one top-level `function name(...) { … }` out of app.js. */
function pickFunction(name) {
  const at = source.indexOf(`\nfunction ${name}(`)
  if (at < 0) throw new Error(`app.js 里找不到 ${name}()`)
  const end = source.indexOf('\n}', at)
  if (end < 0) throw new Error(`${name}() 找不到函数结尾`)
  return source.slice(at + 1, end + 2)
}

const start = source.indexOf('/* ---------- tiny Markdown renderer')
const end = source.indexOf('function appendMessage')
if (start < 0 || end < 0) {
  console.error('无法从 app.js 里定位渲染器代码块')
  process.exit(1)
}
const rendererSource = source.slice(start, end)
// The fenced-code branch of renderMarkdown() calls splitFileMarker(), which lives
// AFTER appendMessage in app.js. Omitting it made every fenced-block sample throw
// "splitFileMarker is not defined" — the test, not the renderer, was broken.
const splitFileMarkerSource = pickFunction('splitFileMarker')
// eslint-disable-next-line no-new-func
const factory = new Function(`${splitFileMarkerSource}\n${rendererSource}; return { renderMarkdown, renderInline, splitFileMarker }`)
const { renderMarkdown, splitFileMarker } = factory()

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

// Built-in sample: every construct the renderer claims to support, including the
// `FILE:` marker both outside and INSIDE a fence (models do both).
const SAMPLE = [
  '## 定时器初值',
  '',
  '说明文字，含 **加粗**、`inline code` 与 [链接](https://example.com)。',
  '',
  '- 第一项',
  '- 第二项',
  '- 第三项',
  '- 第四项',
  '',
  'FILE: E:\\tese\\new\\main.c',
  '',
  '```c',
  'FILE: E:\\tese\\new\\main.c',
  '#include <reg51.h>',
  'void main(void) { while (1) { } }',
  '```',
  '',
  '> 引用一行',
].join('\n')
console.log(`内置样本: ${SAMPLE.split('\n').length} 行，${SAMPLE.length} 字符`)

// 1) the whole document must terminate
const fragment = renderMarkdown(SAMPLE)
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

// 3b) a FILE: marker inside the fence is a target, never code
const codeText = fragment.querySelectorAll('PRE').map((node) => node.textContent).join('\n')
check('代码块里不含 FILE: 行', /FILE:/.test(codeText), false)
check('代码块保留了真正的代码', codeText.includes('#include <reg51.h>'), true)
check('splitFileMarker 剥掉首行 FILE: 并返回路径', splitFileMarker('FILE: E:\\a\\b.c\nint x;'), { code: 'int x;', file: 'E:\\a\\b.c' })
check('splitFileMarker 对普通代码原样返回', splitFileMarker('int x;').file, '')

// 3c) CRLF input must render the same as LF input (the app receives both).
const lf = renderMarkdown(SAMPLE.replace(/\r\n?/g, '\n'))
check(
  'CRLF 与 LF 渲染出的结构一致',
  fragment.querySelectorAll('li').length === lf.querySelectorAll('li').length &&
    fragment.querySelectorAll('pre').length === lf.querySelectorAll('pre').length,
  true,
)

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

// 5) an optional external sample: only the "does not hang / does not throw" contract.
const extra = extraArg && extraArg !== '-' ? extraArg : ''
if (extra) {
  const text = readFileSync(extra, 'utf8')
  console.log(`外部样本: ${extra}（${text.split('\n').length} 行，${text.length} 字符）`)
  let ok = true
  try {
    const out = renderMarkdown(text)
    ok = out.childNodes.length > 0
    renderMarkdown(text.replace(/\r\n?/g, '\n'))
  } catch (error) {
    ok = false
    console.log(`      外部样本渲染失败: ${error.message}`)
  }
  check('外部样本能完整渲染、不抛异常', ok, true)
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
