#!/usr/bin/env node
/**
 * Diagnostic for the renderer's "claimed by nobody" bug: extracts the renderer from
 * public/app.js, replaces the defensive guard with a logger, and reports exactly
 * which input lines used to stall the loop (they consumed no line, so `index` never
 * advanced and the loop appended an empty <p> until the heap died).
 *
 * Usage: node verify/md-which-line.mjs [fixtureFile]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = process.argv[2] ?? 'C:\\Users\\23106\\Desktop\\新建 文本文档 (13).txt'

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
    return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join('') : this._text
  }
  querySelectorAll() {
    return []
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
let renderer = source.slice(start, end)
// Replace the defensive guard with a report, so the offending lines surface.
renderer = renderer.replace(
  /if \(!paragraph\.childNodes\.length\) \{\n\s*\/\/ Belt and braces[\s\S]*?\n\s*\}/,
  "if (!paragraph.childNodes.length) { globalThis.__stalls.push(lines[index]); index += 1; continue }",
)
globalThis.__stalls = []
const factory = new Function(`${renderer}; return { renderMarkdown }`)
const { renderMarkdown } = factory()

const text = readFileSync(fixture, 'utf8')
renderMarkdown(text)
const stalls = [...new Set(globalThis.__stalls)]
console.log(`样本 ${fixture.split('\\').pop()} 共 ${text.split('\n').length} 行`)
console.log(`会让旧的渲染器卡死的行: ${stalls.length} 行`)
for (const line of stalls.slice(0, 12)) console.log(`  ${JSON.stringify(line.slice(0, 80))}`)
if (!stalls.length) console.log('  （这份样本没触发——但边界样本见 verify/md-unit.mjs）')

// Also probe the deliberately nasty inputs.
for (const sample of ['```c extra info\nx\n```\n', '```\nunclosed\n', '   ```c\nx\n```\n']) {
  globalThis.__stalls = []
  renderMarkdown(sample)
  if (globalThis.__stalls.length) console.log(`  边界样本 ${JSON.stringify(sample.slice(0, 14))} → ${JSON.stringify(globalThis.__stalls[0].slice(0, 40))}`)
}
