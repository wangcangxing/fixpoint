#!/usr/bin/env node
/**
 * DOM hygiene audit for the page: duplicate element ids (a duplicate id made
 * getElementById return the wrong node and the "新建文件" dialog never appeared),
 * and every id the script looks up must actually exist.
 *
 * Usage: node verify/dom-audit.mjs <pagePath> [scriptPath]
 */
import { readFile } from 'node:fs/promises'

const [pagePath = 'public/index.html', scriptPath = 'public/app.js'] = process.argv.slice(2)
const html = await readFile(pagePath, 'utf8')
const js = await readFile(scriptPath, 'utf8')

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
const counts = new Map()
for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
const duplicates = [...counts.entries()].filter(([, n]) => n > 1)

// ids referenced as $('x') / getElementById('x')
const referenced = new Set([...js.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map((m) => m[1] ?? m[2]))
const missing = [...referenced].filter((id) => !counts.has(id))

let failed = 0
const report = (name, list) => {
  const ok = list.length === 0
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${list.map((entry) => JSON.stringify(entry)).join('\n      ')}`}`)
}
console.log(`页面里的 id 共 ${ids.length} 个，脚本引用了 ${referenced.size} 个`)
report('没有重复 id', duplicates)
report('脚本引用的 id 都存在', missing)

// The two things the earlier bug broke: the chat textarea must stay visible, and the
// ask dialog must own a distinct id.
report('聊天输入框 id 未被弹窗占用', counts.get('prompt') === 1 ? [] : [{ prompt: counts.get('prompt') }])
report('输入弹窗有自己的 id', counts.has('ask-modal') ? [] : [{ missing: 'ask-modal' }])

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
