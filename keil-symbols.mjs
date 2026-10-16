/**
 * C51 symbol index for editor completion, hover and go-to-definition.
 *
 * Three sources, each authoritative for a different question:
 *
 *   1. The headers the project actually `#include`s (resolved against Keil's
 *      `<KeilRoot>\C51\INC` and the project's own include paths) answer "what
 *      SFR / bit / macro / prototype does this dialect define?" — being
 *      include-driven is what keeps `T2CON` (REG52.H-only) out of an AT89C51
 *      project that includes <reg51.h>, because offering it would not compile.
 *      The user's own install is the source of truth, so nothing Arm-owned ships
 *      with our tool.
 *   2. The project's linker map (`Listings\<OutputName>.m51`) answers "which
 *      symbols really exist in the built image, at what address and in which
 *      memory space?" — produced by the real toolchain. NOTE: it is only
 *      rewritten by a successful link, so a failed build leaves it stale; this
 *      module reports `linkerMap.stale` so callers can fall back to source scan.
 *   3. The project's own sources answer "which functions / globals / structs /
 *      sbit did the user write?" — needed for member completion and signatures.
 *
 * The parsing is deliberately regex/line based, not a C parser: C51 is a dialect
 * (sbit/sfr/bit/interrupt/using/data/idata/pdata/xdata/code/_at_/reentrant) that
 * general-purpose C front-ends reject outright.
 *
 * @module keil-symbols
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { C51_REG_KEY, readProjectInfo, readRegSz } from './keil-core.mjs'

/** Memory-space letters used by the BL51 linker map. */
const MAP_SPACES = {
  C: 'CODE',
  D: 'DATA',
  I: 'IDATA',
  X: 'XDATA',
  B: 'BIT',
  N: 'NUMBER',
}

const SFR_RE = /^[ \t]*sfr[ \t]+(\w+)[ \t]*=[ \t]*(0[xX][0-9A-Fa-f]+|\d+)[ \t]*;/gm
const SFR16_RE = /^[ \t]*sfr16[ \t]+(\w+)[ \t]*=[ \t]*(0[xX][0-9A-Fa-f]+|\d+)[ \t]*;/gm
const SBIT_RE = /^[ \t]*sbit[ \t]+(\w+)[ \t]*=[ \t]*(\w+)[ \t]*\^[ \t]*(\d+)[ \t]*;/gm
const DEFINE_RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)(\(([^)]*)\))?[ \t]*(.*)$/gm
const TYPEDEF_RE = /^[ \t]*typedef[ \t]+([^;{}]+?)[ \t]+(\w+)[ \t]*;/gm
/**
 * Functions, in all three shapes real C51 code uses:
 *   `void f(void) {`   `void f(void)` + `{` on the next line   `void f(void);` (prototype)
 */
const FUNC_RE = /^[ \t]*(?:static[ \t]+|extern[ \t]+|interrupt[ \t]+\d+[ \t]+|using[ \t]+\d+[ \t]+)*([A-Za-z_]\w*(?:[ \t]+[A-Za-z_]\w*)*)[ \t]+(\w+)[ \t]*\(([^;{)]*)\)[ \t]*(?:\{|;|\r?\n[ \t]*\{)/gm
/** Top-level-looking declarations only (line starts in column 0): a deliberate
 *  heuristic that avoids most local variables without needing a real parser. */
const GLOBAL_RE = /^(?:static[ \t]+|extern[ \t]+|const[ \t]+)*(?:(unsigned|signed)[ \t]+)?(char|int|long|float|double|bit|void|struct[ \t]+\w+|[A-Z]\w*)[ \t]+(\w+)[ \t]*(\[[^\]]*\])?[ \t]*[=;]/gm
const STRUCT_RE = /struct[ \t]+(\w+)[ \t]*\{([^}]*)\}/g
const MEMBER_RE = /([A-Za-z_]\w*(?:[ \t]+[A-Za-z_]\w*)*(?:[ \t]*\*)?)[ \t]+(\w+)[ \t]*(?::[ \t]*\d+)?[ \t]*(?:\[[^\]]*\])?[ \t]*;/g
const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm
const C_KEYWORDS = ['if', 'for', 'while', 'switch', 'return', 'sizeof', 'break', 'continue', 'goto', 'case', 'default', 'do', 'else']

/** Resolve `<KeilRoot>\C51\INC`, preferring the registry entry the compiler uses. */
export async function resolveC51IncludeDir(run) {
  const candidates = []
  const registered = await readRegSz(run, C51_REG_KEY, 'Path', undefined).catch(() => undefined)
  if (registered) candidates.push(join(registered, 'INC'))
  if (process.env.KEIL_C51_INC) candidates.push(process.env.KEIL_C51_INC)
  for (const fallback of ['C:\\Keil_v5\\C51\\INC', 'C:\\Keil\\C51\\INC', 'E:\\qrs\\software\\C51\\INC']) {
    candidates.push(fallback)
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isDirectory()) {
      return { dir: candidate, source: index === 0 && registered ? 'registry' : 'fallback', tried: candidates }
    }
  }
  return { dir: '', source: '', tried: candidates }
}

/** Parse one C51 header or C source file into symbol records. */
export function parseC51Text(text, { file, from }) {
  const symbols = []
  const structs = {}
  const lineOf = (index) => text.slice(0, index).split('\n').length
  const add = (record) => symbols.push({ ...record, source: { file, line: lineOf(record.index) }, from })

  for (const match of text.matchAll(SFR_RE)) {
    add({ name: match[1], kind: 'sfr', address: match[2], index: match.index })
  }
  for (const match of text.matchAll(SFR16_RE)) {
    add({ name: match[1], kind: 'sfr16', address: match[2], index: match.index })
  }
  for (const match of text.matchAll(SBIT_RE)) {
    add({ name: match[1], kind: 'sbit', address: `${match[2]}^${match[3]}`, index: match.index })
  }
  for (const match of text.matchAll(DEFINE_RE)) {
    if (match[1].startsWith('__')) continue
    add({
      name: match[1],
      kind: 'macro',
      detail: (match[4] ?? '').trim().slice(0, 60),
      params: match[3] === undefined ? [] : match[3].split(',').map((part) => part.trim()).filter(Boolean),
      index: match.index,
    })
  }
  for (const match of text.matchAll(TYPEDEF_RE)) {
    add({ name: match[2], kind: 'typedef', type: match[1].trim(), index: match.index })
  }
  for (const match of text.matchAll(STRUCT_RE)) {
    const members = []
    for (const member of match[2].matchAll(MEMBER_RE)) {
      members.push({ type: member[1].trim(), name: member[2] })
    }
    if (!members.length) continue
    structs[match[1]] = members
    add({ name: match[1], kind: 'struct', detail: `${members.length} 个成员`, members, index: match.index })
  }
  for (const match of text.matchAll(FUNC_RE)) {
    if (C_KEYWORDS.includes(match[2])) continue
    add({ name: match[2], kind: 'function', type: match[1].trim(), params: splitParams(match[3]), index: match.index })
  }
  for (const match of text.matchAll(GLOBAL_RE)) {
    const name = match[3]
    if (!name || C_KEYWORDS.includes(name)) continue
    add({
      name,
      kind: 'variable',
      type: [match[1], match[2]].filter(Boolean).join(' ').trim(),
      detail: match[4] ?? '',
      index: match.index,
    })
  }
  return { symbols, structs }
}

/** Split a C parameter list into labels. */
function splitParams(raw) {
  const text = (raw ?? '').trim()
  if (!text || text === 'void') return []
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** C51 startup/library internals that must not pollute a completion list. */
const SYSTEM_SYMBOL_RE = /^(?:[IXP]?BPSTACK(?:TOP)?|I?DATALEN|PDATALEN|XDATALEN|I?DATASTART|PDATASTART|XDATASTART|PPAGE\w*|STARTUP1?)$/i

/** Parse the BL51 linker map's SYMBOL TABLE sections. */
export function parseLinkerMap(text) {
  const symbols = []
  // Addresses carry an `H` suffix in the map, and bit symbols add `.bit`:
  //   D:0090H   PUBLIC  P1      B:0090H.0  PUBLIC  LED
  const lineRe = /^\s+([CDIXBN]):([0-9A-Fa-f]{4,8})H?(?:\.(\d))?\s+(PUBLIC|SYMBOL)\s+(\S+)\s*$/
  for (const line of text.split(/\r?\n/)) {
    const match = lineRe.exec(line)
    if (!match) continue
    const [, space, address, bit, visibility, rawName] = match
    const spaceName = MAP_SPACES[space] ?? space
    const name = demangle(rawName)
    symbols.push({
      name,
      rawName,
      kind: 'linker',
      space: spaceName,
      address: bit ? `${address}.${bit}` : address,
      detail: `${spaceName}:${address}${bit ? `.${bit}` : ''} ${visibility}`,
      // `?`-prefixed names and the C51 runtime's own globals are noise for a user.
      system: rawName.startsWith('?') || SYSTEM_SYMBOL_RE.test(rawName) || SYSTEM_SYMBOL_RE.test(name),
      from: 'linker',
    })
  }
  return symbols
}

/**
 * Turn a BL51 symbol back into the C name:
 *   `_delay`       -> `delay`   (C51 prefix)
 *   `?PR?MAIN?2`   -> `main`    (module-scoped function`)
 *   `?C_C51STARTUP`-> `C_C51STARTUP` (keeps its case: only >=3 segments are mangled names)
 */
export function demangle(rawName) {
  if (!rawName) return rawName
  if (rawName.startsWith('?')) {
    const parts = rawName.split('?').filter(Boolean)
    if (parts.length >= 3) {
      const last = parts[parts.length - 1]
      const name = /^\d+$/.test(last) ? parts[parts.length - 2] : last
      return name ? name.toLowerCase() : rawName
    }
    return parts[0] ?? rawName
  }
  return rawName.startsWith('_') ? rawName.slice(1) : rawName
}

/** Build the merged symbol index for one project. */
export async function buildSymbolIndex(project, options = {}) {
  const info = await readProjectInfo(project)
  const includeDirs = []
  for (const raw of info.includePaths ?? []) {
    for (const part of raw.split(';').map((piece) => piece.trim()).filter(Boolean)) {
      includeDirs.push(isAbsolute(part) ? part : resolve(info.projectDir, part))
    }
  }
  if (options.c51IncludeDir) includeDirs.push(options.c51IncludeDir)
  const searchDirs = [...new Set([...includeDirs, info.projectDir])]

  const problems = []
  const readText = (file) => readFile(file, 'utf8').catch((error) => {
    problems.push(`${basename(file)}: ${error.message}`)
    return ''
  })

  // 0) The project's own files, and what they include.
  const sourceFiles = []
  for (const declared of info.declaredSources) {
    const candidate = isAbsolute(declared.path || '')
      ? declared.path
      : resolve(info.projectDir, declared.path || declared.name)
    if (/\.(c|h)$/i.test(candidate)) sourceFiles.push(candidate)
  }
  const projectTexts = new Map()
  for (const file of [...new Set(sourceFiles)]) projectTexts.set(file, await readText(file))

  const includeNames = new Set()
  for (const text of projectTexts.values()) {
    for (const match of text.matchAll(INCLUDE_RE)) includeNames.add(basename(match[1]).toLowerCase())
  }

  // Which headers exist on disk (Keil's INC + project include paths)?
  const available = new Map()
  for (const dir of searchDirs) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && /\.(h|inc)$/i.test(entry.name)) {
        const key = entry.name.toLowerCase()
        if (!available.has(key)) available.set(key, join(dir, entry.name))
      }
    }
  }

  // Headers to index: the included ones, plus one level of their own includes.
  const headerFiles = []
  for (const name of includeNames) {
    const file = available.get(name)
    if (file) headerFiles.push(file)
  }
  for (const file of [...headerFiles]) {
    const text = await readText(file)
    for (const match of text.matchAll(INCLUDE_RE)) {
      const nested = available.get(basename(match[1]).toLowerCase())
      if (nested && !headerFiles.includes(nested)) headerFiles.push(nested)
    }
  }
  // No includes at all (e.g. a bare assembly project): fall back to every header
  // in Keil's INC so completion still has SFRs.
  if (!headerFiles.length && options.c51IncludeDir) {
    for (const [name, file] of available) {
      if (file.toLowerCase().startsWith(options.c51IncludeDir.toLowerCase())) headerFiles.push(file)
    }
  }

  // 1) Merge everything: project sources beat headers beat the linker's mangled
  //    names, but a real linker address is always kept.
  const byName = new Map()
  const structs = {}
  const priority = { source: 3, header: 2, linker: 1 }
  const merge = (record, from) => {
    const existing = byName.get(record.name)
    if (!existing) {
      byName.set(record.name, { ...record, from })
      return
    }
    const wins = (priority[from] ?? 0) >= (priority[existing.from] ?? 0)
    const merged = { ...existing, ...(wins ? record : {}), from: wins ? from : existing.from }
    if (record.space && !merged.space) {
      merged.space = record.space
      merged.address = record.address ?? merged.address
      merged.detail = record.detail ?? merged.detail
    }
    byName.set(record.name, merged)
  }

  const headerNames = []
  for (const file of headerFiles) {
    const text = await readText(file)
    if (!text) continue
    headerNames.push(basename(file))
    const parsed = parseC51Text(text, { file, from: 'header' })
    for (const symbol of parsed.symbols) merge(symbol, 'header')
    Object.assign(structs, parsed.structs)
  }

  const sourceNames = []
  for (const [file, text] of projectTexts) {
    if (!text) continue
    sourceNames.push(basename(file))
    const parsed = parseC51Text(text, { file, from: 'source' })
    for (const symbol of parsed.symbols) merge(symbol, 'source')
    Object.assign(structs, parsed.structs)
  }

  // 2) The linker map (real addresses; may be stale after a failed build).
  const linkerMap = {
    path: join(info.projectDir, 'Listings', `${info.outputName}.m51`),
    mtime: '',
    stale: false,
    count: 0,
  }
  const mapText = await readText(linkerMap.path)
  if (mapText) {
    const mapStat = await stat(linkerMap.path).catch(() => undefined)
    linkerMap.mtime = mapStat ? mapStat.mtime.toISOString() : ''
    const linked = parseLinkerMap(mapText)
    linkerMap.count = linked.length
    for (const symbol of linked) merge(symbol, 'linker')
    let newest = 0
    for (const file of [...projectTexts.keys(), ...sourceFiles]) {
      const fileStat = await stat(file).catch(() => undefined)
      if (fileStat) newest = Math.max(newest, fileStat.mtimeMs)
    }
    if (mapStat && newest > mapStat.mtimeMs) linkerMap.stale = true
  }

  // Attach struct members to variables whose type names a known struct.
  const symbols = [...byName.values()].map((symbol) => {
    const typeName = (symbol.type ?? '').replace(/^struct\s+/, '').trim()
    if (typeName && structs[typeName]) symbol.members = structs[typeName]
    return symbol
  })

  const stats = {}
  for (const symbol of symbols) stats[symbol.kind] = (stats[symbol.kind] ?? 0) + 1

  return {
    project: info.project,
    projectDir: info.projectDir,
    device: info.device,
    outputName: info.outputName,
    includeDirs,
    headers: headerNames,
    sources: { headers: headerNames, sources: sourceNames, linkerMap: linkerMap.count ? basename(linkerMap.path) : '' },
    linkerMap,
    structs,
    symbols,
    stats,
    problems,
  }
}
