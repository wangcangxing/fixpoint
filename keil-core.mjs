/**
 * Shared Keil C51 core for both delivery routes of this workspace:
 *   - the DSH native plugin   (dsh-plugin-keil/lib/index.js)
 *   - the standalone MCP server (mcp-server-keil/server.mjs)
 *
 * Both routes must resolve the same UV4.exe and parse the same UV4 logs, so the
 * logic lives exactly once here. The only per-route difference is how a process
 * is started, which is injected as `run`:
 *   run(argv: string[], opts: { cwd?: string, graceMs?: number, signal?: AbortSignal })
 *     => Promise<{ exitCode: number | null, stdout: string, stderr: string, signal?: string | null }>
 *
 * Measured facts (Keil C51 V9.57 / uVision 5.24.2.86):
 *   - UV4 ERRORLEVEL: 0 ok, 1 warnings, 2 errors, 3 fatal, 11..20 tool errors.
 *   - C51 diagnostics are `file(line): error C202: message` — there is NO column
 *     number, unlike MDK/armcc which emits `file(line:col)`.
 *   - Keil C51 rejects a UTF-8 BOM in sources and then reports bogus C100
 *     cascades that hide the real errors.
 *   - A project may contain source files that are not part of the build; only
 *     `translated[]` (parsed from the log) tells you what was really compiled.
 *
 * @module keil-core
 */
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Keil registry key owning the C51 install (`Path` -> <root>\C51, `Version`). */
export const C51_REG_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Keil\\Products\\C51'

/** Last-resort UV4.exe locations when neither config, env, nor registry answers. */
export const UV4_FALLBACKS = [
  'C:\\Keil_v5\\UV4\\UV4.exe',
  'C:\\Keil\\UV4\\UV4.exe',
  'D:\\Keil_v5\\UV4\\UV4.exe',
]

/** Upper bound for collected subprocess output (UV4 logs are a few KB). */
export const COLLECT_MAX_BYTES = 262144

const DIAGNOSTIC = /^(?<file>[^(]+)\((?<line>\d+)(?::(?<col>\d+))?\)\s*:\s*(?<sev>fatal error|error|warning)\s+(?<code>[A-Z]{0,1}\d+)\s*:\s*(?<message>.*)$/
const LINKER = /^\*\*\*\s*(?<sev>FATAL ERROR|ERROR|WARNING)\s+(?<code>[A-Z]\d+)\s*:\s*(?<message>.*)$/
const TRANSLATED = /^(?:compiling|assembling|linking)\s+(?<file>.+?)\.{3}$/
const ERRORLEVEL_STATUS = new Map([
  [0, 'ok'],
  [1, 'warnings'],
  [2, 'errors'],
  [3, 'fatal'],
  [11, 'tool-error'],
  [12, 'device-not-found'],
  [13, 'tool-error'],
  [15, 'tool-error'],
  [20, 'tool-error'],
])

/** Map a UV4 exit code to a stable status word. */
export function statusFor(exitCode) {
  return ERRORLEVEL_STATUS.get(exitCode) ?? 'tool-error'
}

/**
 * Slice every OUTERMOST `<tag>...</tag>` block, tolerating same-name tags nested
 * inside — which µVision project files really do (`<Target>` appears again inside
 * a target's own option block, so a non-greedy regex stops far too early).
 * @param {string} text - the document text.
 * @param {string} tag - the exact tag name (e.g. `Target`, `Group`, `File`).
 * @returns {string[]} the outermost block contents, in document order.
 */
export function outerBlocks(text, tag) {
  const openToken = `<${tag}>`
  const closeToken = `</${tag}>`
  const events = []
  for (let index = text.indexOf(openToken); index !== -1; index = text.indexOf(openToken, index + 1)) {
    events.push({ index, delta: 1 })
  }
  for (let index = text.indexOf(closeToken); index !== -1; index = text.indexOf(closeToken, index + 1)) {
    events.push({ index: index + closeToken.length, delta: -1 })
  }
  events.sort((left, right) => left.index - right.index)
  const blocks = []
  let depth = 0
  let start = 0
  let started = false
  for (const event of events) {
    if (event.delta === 1) {
      if (!started) {
        start = event.index
        started = true
      }
      depth += 1
    } else {
      depth -= 1
      if (depth <= 0 && started) {
        blocks.push(text.slice(start, event.index))
        started = false
        depth = 0
      }
    }
  }
  return blocks
}

/**
 * Parse a UV4 build log.
 * @param {string} log - raw log text (`UV4 -o` output or the collected stdout).
 * @returns {{ errors: object[], warnings: object[], translated: string[] }}
 */
export function parseBuildLog(log) {
  const errors = []
  const warnings = []
  const translated = []
  for (const raw of String(log ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const compile = TRANSLATED.exec(line)
    if (compile) {
      translated.push(compile.groups.file.trim())
      continue
    }
    const diagnostic = DIAGNOSTIC.exec(line)
    if (diagnostic) {
      const { file, line: number, col, sev, code, message } = diagnostic.groups
      const entry = {
        file: file.trim(),
        line: Number(number),
        column: col ? Number(col) : null,
        severity: sev,
        code,
        message: message.trim(),
      }
      ;(sev === 'warning' ? warnings : errors).push(entry)
      continue
    }
    const linker = LINKER.exec(line)
    if (linker) {
      const entry = {
        file: null,
        line: null,
        column: null,
        severity: linker.groups.sev.toLowerCase(),
        code: linker.groups.code,
        message: linker.groups.message.trim(),
      }
      ;(entry.severity === 'warning' ? warnings : errors).push(entry)
    }
  }
  return { errors, warnings, translated }
}

/** Read a `REG_SZ` value from the Windows registry, or undefined when absent. */
export async function readRegSz(run, key, valueName, signal) {
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const { stdout } = await run([reg, 'query', key, '/v', valueName], { graceMs: 2000, signal })
  const match = String(stdout ?? '').match(/REG_SZ\s+(.+?)\s*$/m)
  return match ? match[1].trim() : undefined
}

/**
 * Resolve UV4.exe: explicit config, then `KEIL_UV4_PATH`, then the Keil C51
 * registry entry (`<C51 path>\..\UV4\UV4.exe`), then the common install roots.
 * @returns {Promise<{ uv4?: string, source?: string, tried: string[] }>}
 */
export async function resolveUv4(run, configured, signal) {
  const tried = []
  const candidates = []
  if (configured) candidates.push([configured, 'config'])
  if (process.env.KEIL_UV4_PATH) candidates.push([process.env.KEIL_UV4_PATH, 'env:KEIL_UV4_PATH'])
  const c51Path = await readRegSz(run, C51_REG_KEY, 'Path', signal)
  if (c51Path) candidates.push([join(dirname(c51Path), 'UV4', 'UV4.exe'), 'registry'])
  for (const fallback of UV4_FALLBACKS) candidates.push([fallback, 'fallback'])
  for (const [candidate, source] of candidates) {
    tried.push(candidate)
    try {
      const info = await stat(candidate)
      if (info.isFile()) return { uv4: candidate, source, tried }
    } catch {
      // keep looking
    }
  }
  return { uv4: undefined, source: undefined, tried }
}

/**
 * Inspect the toolchain this workspace drives.
 * @returns {Promise<object>} a JSON-serializable doctor value.
 */
export async function inspectToolchain(run, configured, signal) {
  const { uv4, source, tried } = await resolveUv4(run, configured, signal)
  const c51Path = await readRegSz(run, C51_REG_KEY, 'Path', signal)
  const c51Version = await readRegSz(run, C51_REG_KEY, 'Version', signal)
  return {
    uv4Path: uv4 ?? '',
    uv4Source: source ?? '',
    c51Path: c51Path ?? '',
    c51Version: c51Version ?? '',
    tried,
    status: uv4 ? 'ok' : 'uv4-not-found',
  }
}

/**
 * Build, rebuild, or clean one project and return structured diagnostics.
 * @param {Function} run - the injected process runner.
 * @param {{ project: string, mode?: 'build'|'rebuild'|'clean', target?: string, uv4Path?: string, signal?: AbortSignal }} options
 * @returns {Promise<object>} a JSON-serializable value (no undefined, no null strings).
 */
export async function buildProject(run, options) {
  const { project, mode = 'build', target, uv4Path, signal } = options ?? {}
  if (!project || typeof project !== 'string') {
    throw new Error('"project" is required and must be the path to a .uvproj/.uvprojx file')
  }
  // Check the project before spawning: a missing directory makes the spawn fail
  // with a bare `spawn <uv4> ENOENT`, which reads as "UV4 is missing" and hides
  // the real cause.
  const projectInfo = await stat(project).catch(() => undefined)
  if (!projectInfo?.isFile()) {
    throw new Error(`project file not found: ${project}`)
  }
  const flag = mode === 'rebuild' ? '-r' : mode === 'clean' ? '-c' : '-b'
  const { uv4, source, tried } = await resolveUv4(run, uv4Path, signal)
  if (!uv4) {
    throw new Error(
      `UV4.exe not found. Tried: ${tried.join(', ')}. Set KEIL_UV4_PATH or the plugin/server uv4Path option.`,
    )
  }

  const logPath = join(tmpdir(), `keil-c51-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`)
  const argv = [uv4, flag, project, '-j0', '-o', logPath]
  if (target) argv.push('-t', target)

  const started = Date.now()
  const { exitCode, stdout, stderr } = await run(argv, { cwd: dirname(project), graceMs: 10000, signal })
  const elapsedSec = Math.round((Date.now() - started) / 100) / 10

  let log = ''
  let logAvailable = true
  try {
    log = await readFile(logPath, 'utf8')
  } catch {
    logAvailable = false
    log = [stdout, stderr].filter(Boolean).join('\n')
  }

  const { errors, warnings, translated } = parseBuildLog(log)
  const logLines = log.split(/\r?\n/)
  return {
    exitCode,
    status: statusFor(exitCode),
    project,
    mode,
    target: target ?? '',
    uv4,
    uv4Source: source ?? '',
    elapsedSec,
    programSize: logLines.filter((l) => /^Program Size:/.test(l)).pop() ?? '',
    summary: logLines.filter((l) => /Error\(s\)/.test(l)).pop() ?? '',
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    translated,
    logAvailable,
    logPath,
    log,
  }
}

/** Render a build value as readable text (used by both routes as their result body). */
export function formatBuildResult(value) {
  const lines = [
    `Keil C51 ${value.mode} -> ${value.status} (ERRORLEVEL ${value.exitCode})`,
    `project: ${value.project}`,
  ]
  if (value.target) lines.push(`target: ${value.target}`)
  if (value.programSize) lines.push(value.programSize)
  if (value.summary) lines.push(value.summary)
  if (value.translated?.length) lines.push(`translated: ${value.translated.join(', ')}`)
  lines.push(`errors: ${value.errorCount}  warnings: ${value.warningCount}`)
  const row = (item) =>
    item.file
      ? `  ${item.file}(${item.line}): ${item.severity} ${item.code}: ${item.message}`
      : `  ${item.severity} ${item.code}: ${item.message}`
  for (const item of value.errors) lines.push(row(item))
  for (const item of value.warnings) lines.push(row(item))
  if (!value.logAvailable) lines.push('note: the UV4 -o log could not be read; showing the log excerpt below')
  lines.push('log:')
  lines.push(value.log || '(empty)')
  return lines.join('\n')
}

/** Render a doctor value as readable text. */
export function formatDoctor(value) {
  return [
    `Keil C51 doctor: ${value.status}`,
    `UV4.exe: ${value.uv4Path || '(not found)'}${value.uv4Source ? ` (via ${value.uv4Source})` : ''}`,
    `C51 install: ${value.c51Path || '(unknown)'}  version: ${value.c51Version || '(unknown)'}`,
    `tried: ${value.tried.join(', ')}`,
  ].join('\n')
}

/**
 * Build a `run` implementation over node:child_process, for hosts that are not
 * DSH (the MCP server and the keil-ide host). Non-blocking, output bounded by
 * COLLECT_MAX_BYTES, and an AbortSignal kills the child.
 * @returns {Function} the `run(argv, opts)` contract documented at the top.
 */
export function makeNodeRunner() {
  return function run(argv, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd ?? tmpdir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        if (stdout.length < COLLECT_MAX_BYTES) stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < COLLECT_MAX_BYTES) stderr += chunk.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal: signal ?? null, stdout, stderr }))
      opts.signal?.addEventListener('abort', () => child.kill(), { once: true })
    })
  }
}

/**
 * Read one µVision project's identity and declared sources from its .uvproj.
 * Deliberately regex-based: real projects contain malformed tags, so this never
 * pretends to be a general XML parser.
 *
 * `declaredSources` is what the project claims to build; the build log's
 * `translated[]` is what it actually translated. Comparing the two against the
 * files on disk is what catches the orphan-source-file trap.
 *
 * @param {string} project - path to the .uvproj/.uvprojx file.
 * @returns {Promise<object>} project facts including the derived hex path.
 */
export async function readProjectInfo(project) {
  const text = await readFile(project, 'utf8')
  const first = (re) => {
    const match = re.exec(text)
    return match ? match[1].trim() : ''
  }
  const projectDir = dirname(project)
  const outputName = first(/<OutputName>([^<]*)<\/OutputName>/)
  const includePaths = []
  for (const match of text.matchAll(/<IncludePath>([^<]*)<\/IncludePath>/g)) {
    for (const part of match[1].split(';')) {
      const trimmed = part.trim()
      if (trimmed) includePaths.push(trimmed)
    }
  }
  const objectsDir = join(projectDir, 'Objects')
  const declaredSources = []
  const block = /<File>([\s\S]*?)<\/File>/g
  let match
  while ((match = block.exec(text)) !== null) {
    const body = match[1]
    const name = /<FileName>([^<]*)<\/FileName>/.exec(body)
    if (!name) continue
    const type = /<FileType>([^<]*)<\/FileType>/.exec(body)
    const path = /<FilePath>([^<]*)<\/FilePath>/.exec(body)
    declaredSources.push({
      name: name[1].trim(),
      fileType: type ? type[1].trim() : '',
      path: path ? path[1].trim() : '',
    })
  }
  // µVision keeps a real hierarchy — Target > Group > File — and that is what the
  // project pane shows. `declaredSources` stays flat for the tools that only need
  // "what is in the build"; `targets` carries the hierarchy for the tree view.
  const targets = []
  for (const targetBody of outerBlocks(text, 'Target')) {
    const name = (/<TargetName>([^<]*)<\/TargetName>/.exec(targetBody) ?? [])[1] ?? ''
    const groups = []
    for (const groupBody of outerBlocks(targetBody, 'Group')) {
      const groupName = (/<GroupName>([^<]*)<\/GroupName>/.exec(groupBody) ?? [])[1] ?? ''
      const files = []
      for (const fileBody of outerBlocks(groupBody, 'File')) {
        const fileName = (/<FileName>([^<]*)<\/FileName>/.exec(fileBody) ?? [])[1]
        if (!fileName) continue
        files.push({
          name: fileName.trim(),
          fileType: ((/<FileType>([^<]*)<\/FileType>/.exec(fileBody) ?? [])[1] ?? '').trim(),
          path: ((/<FilePath>([^<]*)<\/FilePath>/.exec(fileBody) ?? [])[1] ?? '').trim(),
        })
      }
      groups.push({ name: groupName || 'Group', files })
    }
    targets.push({ name: name || 'Target', groups })
  }

  return {
    project,
    projectDir,
    targetName: first(/<TargetName>([^<]*)<\/TargetName>/),
    device: first(/<Device>([^<]*)<\/Device>/),
    outputName,
    createHexFile: first(/<CreateHexFile>([^<]*)<\/CreateHexFile>/) === '1',
    // µVision skips targets without this flag during its own Batch Build.
    selectedForBatchBuild: first(/<SelectedForBatchBuild>([^<]*)<\/SelectedForBatchBuild>/) === '1',
    objectsDir,
    hexPath: outputName ? join(objectsDir, `${outputName}.hex`) : '',
    includePaths,
    declaredSources,
    targets,
  }
}
