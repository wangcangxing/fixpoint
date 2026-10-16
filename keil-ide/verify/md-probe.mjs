#!/usr/bin/env node
/**
 * Line-by-line diagnosis of the Markdown dispatcher: for each line of a fixture it
 * prints the encoding/line-ending facts and WHICH branch the renderer's regexes pick.
 *
 * Usage: node verify/md-probe.mjs [fixtureFile]
 */
import { readFileSync } from 'node:fs'

const fixture = process.argv[2] ?? 'C:\\Users\\23106\\Desktop\\新建 文本文档 (13).txt'
const buffer = readFileSync(fixture)
console.log(`文件: ${fixture}`)
console.log(`字节数 ${buffer.length}`)
console.log(`前 8 字节: ${[...buffer.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
console.log(`含 CRLF: ${buffer.includes(Buffer.from('\r\n'))}   含单独 LF: ${/^\n/m.test(buffer.toString('utf8'))}`)
const utf16 = buffer.length > 1 && buffer[0] === 0xff && buffer[1] === 0xfe
console.log(`UTF-16LE BOM: ${utf16}`)

const text = buffer.toString('utf8')
const lines = text.split('\n')
const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^\s*```(.*)$/
const QUOTE = /^\s*>\s?/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/

let counts = { fence: 0, heading: 0, quote: 0, list: 0, blank: 0, paragraph: 0 }
console.log('\n行 → 分支（只列出非段落行，末尾会汇总）')
lines.forEach((line, index) => {
  let kind = 'paragraph'
  if (FENCE.test(line)) kind = 'fence'
  else if (HEADING.test(line)) kind = 'heading'
  else if (QUOTE.test(line)) kind = 'quote'
  else if (BULLET.test(line) || ORDERED.test(line)) kind = 'list'
  else if (!line.trim()) kind = 'blank'
  counts[kind] += 1
  if (kind !== 'paragraph' && kind !== 'blank' && counts[kind] <= 3) {
    console.log(`  ${String(index + 1).padStart(3)} ${kind.padEnd(8)} ${JSON.stringify(line.slice(0, 46))}`)
  }
})
console.log('\n汇总:', JSON.stringify(counts))
const tail = JSON.stringify(lines[lines.length - 1].slice(0, 60))
console.log('最后一行:', tail)
