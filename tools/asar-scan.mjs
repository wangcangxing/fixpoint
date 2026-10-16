// Read-only text scanner for an Electron app.asar archive.
//
// Why: the DSH checkout is packed into resources/app.asar, so the authoritative
// type declarations and plugin examples are not on disk as files. asar stores
// every file's bytes concatenated, so a plain substring scan over the archive
// recovers the surrounding source text without parsing the archive header.
//
// Usage:
//   node asar-scan.mjs <asar> <needle> [before] [after] [maxHits]
//
// Example:
//   node asar-scan.mjs app.asar "interface TextBlock" 300 600 3
import { readFileSync } from 'node:fs'

const [, , asarPath, needle, beforeArg, afterArg, maxArg] = process.argv
if (!asarPath || !needle) {
  console.error('usage: node asar-scan.mjs <asar> <needle> [before] [after] [maxHits]')
  process.exit(2)
}
const before = Number(beforeArg ?? 200)
const after = Number(afterArg ?? 400)
const maxHits = Number(maxArg ?? 5)

const bytes = readFileSync(asarPath)
const needleBuf = Buffer.from(needle, 'utf8')
let from = 0
let hits = 0
while (hits < maxHits) {
  const at = bytes.indexOf(needleBuf, from)
  if (at < 0) break
  const start = Math.max(0, at - before)
  const end = Math.min(bytes.length, at + needle.length + after)
  console.log(`--- hit ${hits + 1} @ byte ${at} ---`)
  console.log(bytes.subarray(start, end).toString('utf8'))
  console.log('')
  from = at + needle.length
  hits += 1
}
console.log(`total hits printed: ${hits}${hits === maxHits ? ' (capped by maxHits)' : ''}`)
