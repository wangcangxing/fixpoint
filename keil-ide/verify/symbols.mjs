#!/usr/bin/env node
/**
 * Print the C51 symbol index for one project — the fast feedback loop for
 * ../../keil-symbols.mjs before the editor ever asks for it.
 *
 * Usage: node verify/symbols.mjs "E:\path\to\project.uvproj"
 */
import { makeNodeRunner } from '../../keil-core.mjs'
import { buildSymbolIndex, resolveC51IncludeDir } from '../../keil-symbols.mjs'

const project = process.argv[2]
if (!project) {
  console.error('usage: node verify/symbols.mjs <project.uvproj>')
  process.exit(2)
}

const run = makeNodeRunner()
const include = await resolveC51IncludeDir(run)
console.log(`C51 include dir: ${include.dir || '(not found)'}  [${include.source}]`)

const index = await buildSymbolIndex(project, { c51IncludeDir: include.dir })
console.log(`project: ${index.project}`)
console.log(`device : ${index.device}   output: ${index.outputName}`)
console.log(`stats  : ${JSON.stringify(index.stats)}`)
console.log(`headers: ${index.sources.headers.length} 个 -> ${index.sources.headers.slice(0, 6).join(', ')}…`)
console.log(`sources: ${index.sources.sources.join(', ')}`)
console.log(`m51    : ${JSON.stringify(index.linkerMap)}`)
console.log(`structs: ${JSON.stringify(Object.keys(index.structs))}`)
if (index.problems.length) console.log(`problems: ${index.problems.join(' | ')}`)

const line = (kind, limit = 14) => {
  const items = index.symbols.filter((symbol) => symbol.kind === kind)
  const text = items
    .slice(0, limit)
    .map((symbol) => {
      const address = symbol.address ? `@${symbol.address}` : ''
      const space = symbol.space ? `[${symbol.space}]` : ''
      const params = symbol.params?.length ? `(${symbol.params.length}参数)` : ''
      const members = symbol.members?.length ? `{${symbol.members.length}成员}` : ''
      return `${symbol.name}${address}${space}${params}${members}`
    })
    .join(', ')
  console.log(`${kind.padEnd(9)}(${String(items.length).padStart(3)}): ${text}`)
}
console.log('--- symbols by kind ---')
for (const kind of ['sfr', 'sfr16', 'sbit', 'macro', 'typedef', 'struct', 'function', 'variable', 'linker']) line(kind)

const p1 = index.symbols.find((symbol) => symbol.name === 'P1')
const led = index.symbols.find((symbol) => symbol.name === 'LED')
console.log(`\nP1  -> ${JSON.stringify(p1)}`)
console.log(`LED -> ${JSON.stringify(led)}`)
