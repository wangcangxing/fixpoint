/**
 * STC 8051 ISP flashing for Fixpoint — a thin, host-side adapter over the
 * user's own `stcgal` (MIT, https://github.com/grigorig/stcgal).
 *
 * Why this shape: Fixpoint deliberately shipped WITHOUT flashing ("无烧录能力"
 * in its README; UVSOCK does not provide it). The proven engine is stcgal, a
 * plain CLI, so this module only has to (a) find the user's Python + stcgal,
 * (b) enumerate COM ports without native modules, (c) stream stcgal's stdout
 * back as progress events. It is a subprocess boundary: stcgal's MIT license
 * places no obligation on this app, and nothing here links Python code.
 *
 * Process launching follows keil-core.mjs's contract for one-shot probes (an
 * injected `run(argv, opts)`), while the flash itself needs streaming, so it
 * spawns directly and reports through callbacks — the same split the DSH-agent
 * path in server.mjs uses.
 *
 * Hardware-safety rules baked in:
 *   - flashing ALWAYS requires an explicit user action (the route is only
 *     reached from the 烧录 button); nothing auto-flashes;
 *   - cancelling kills the whole process tree (taskkill /T) so a half-written
 *     chip never leaves an orphan holding the COM port (Windows locks it);
 *   - port enumeration is pure WMI/PowerShell — zero node-gyp, per the same
 *     reasoning universal-flasher documents (their pitfall #5).
 *
 * @module keil-flash
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Protocol values stcgal 1.10 actually accepts (`stcgal -P` help, measured). */
export const STCGAL_PROTOCOLS = ['auto', 'stc89', 'stc89a', 'stc12a', 'stc12b', 'stc12', 'stc15a', 'stc15', 'stc8', 'stc8d', 'stc8g', 'usb15']

/** Common baud rates for STC ISP (115200 is stcgal's default). */
export const STCGAL_BAUDS = [2400, 9600, 19200, 38400, 57600, 115200]

/** Where to look for a Python when settings.flash.python is empty. */
const PYTHON_FALLBACKS = [
  process.env.KEIL_PYTHON,
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe'),
  'D:\\Python312\\python.exe',
  join(process.env.ProgramFiles ?? '', 'Python312', 'python.exe'),
].filter(Boolean)

const existsFile = async (path) => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a Python interpreter that can run `python -m stcgal`.
 * Order: explicit setting → `KEIL_PYTHON` → known roots → PATH (`python`/`py -3`).
 * A candidate only wins when `--version` actually runs AND stcgal imports.
 * @returns {Promise<{ python: string, source: string, stcgal: string, tried: string[], error?: string }>}
 */
export async function discoverStcgal(run, configured = '', signal) {
  const tried = []
  const candidates = []
  if (configured) candidates.push([configured, 'config'])
  for (const fallback of PYTHON_FALLBACKS) {
    if (await existsFile(fallback)) candidates.push([fallback, 'known-root'])
  }
  // PATH probe: resolve `python`/`py -3` to absolute paths via `where`.
  for (const [argv, label] of [[['where.exe', 'python'], 'path:python'], [['where.exe', 'python3'], 'path:python3']]) {
    const probe = await run(argv, { graceMs: 3000, signal }).catch(() => undefined)
    for (const line of String(probe?.stdout ?? '').split(/\r?\n/)) {
      const candidate = line.trim()
      if (/[\\/]python(\w*)?\.exe$/i.test(candidate)) candidates.push([candidate, label])
    }
  }

  let lastProblem = ''
  for (const [python, source] of candidates) {
    if (tried.includes(python)) continue
    tried.push(python)
    const version = await run([python, '-m', 'stcgal', '--version'], { graceMs: 15000, signal }).catch((error) => ({ exitCode: -1, stderr: error.message }))
    if (version.exitCode === 0) {
      const match = /stcgal\s+([\d.]+)/i.exec(String(version.stdout ?? ''))
      return { python, source, stcgal: match ? match[1] : '(版本未知)', tried }
    }
    const stderr = String(version.stderr ?? '')
    lastProblem = /No module named stcgal/i.test(stderr)
      ? `${python}: 没装 stcgal（pip install stcgal）`
      : `${python}: 启动失败 (exit ${version.exitCode})`
  }
  return { python: '', source: '', stcgal: '', tried, error: lastProblem || '找不到可用的 Python（设置里可指定 python 路径）' }
}

/**
 * Enumerate COM ports through WMI — no serialport, no node-gyp.
 * The UTF-8 prefix matters: the default console codepage mangles the Chinese
 * device names (measured on this machine: 蓝牙链接上的标准串行).
 * @returns {Promise<{ port: string, name: string }[]>} sorted by COM number
 */
export async function listSerialPorts(run, signal) {
  const script =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -eq 'Ports' } | Select-Object Name | ConvertTo-Json -Compress"
  const { stdout } = await run(['powershell.exe', '-NoProfile', '-Command', script], { graceMs: 8000, signal }).catch(() => ({ stdout: '' }))
  let parsed = []
  try {
    parsed = JSON.parse(String(stdout).trim() || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) parsed = [parsed]
  const ports = []
  for (const item of parsed) {
    const name = String(item?.Name ?? '')
    const match = /\((COM\d+)\)/i.exec(name)
    if (match) ports.push({ port: match[1].toUpperCase(), name })
  }
  ports.sort((left, right) => Number(left.port.slice(3)) - Number(right.port.slice(3)))
  return ports
}

/**
 * One line of stcgal output → progress events. The strings matched here are
 * stcgal 1.10's own (verified against `stcgal --help` output and universal-
 * flasher's measured parser); unknown lines still surface as plain logs.
 */
export function parseStcgalLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (trimmed.includes('Waiting for MCU, please cycle power: done')) {
    return { kind: 'progress', percent: 10, detail: '握手成功', status: '已握手，正在读取芯片信息…' }
  }
  if (trimmed.includes('Waiting for MCU, please cycle power')) {
    return { kind: 'status', status: '⏳ 等待单片机冷启动（请断电后重新上电）…' }
  }
  if (trimmed.includes('Erasing flash: done')) {
    return { kind: 'progress', percent: 25, detail: '擦除完成', status: '擦除完成，正在写入…' }
  }
  const writing = /Writing\s+\d+\s+bytes:\s+(\d+)%/i.exec(trimmed)
  if (writing) {
    const raw = Number(writing[1])
    return { kind: 'progress', percent: 25 + Math.round(raw * 0.65), detail: `写入 ${raw}%` }
  }
  if (trimmed.includes('Setting options: done')) {
    return { kind: 'progress', percent: 95, detail: '选项设置完成' }
  }
  if (/^(Target model|Target frequency|Target voltage|Available Flash|Using protocol|Boot baud|Vendor Command)/i.test(trimmed)) {
    return { kind: 'log', text: trimmed }
  }
  return { kind: 'log', text: trimmed }
}

/**
 * Start an stcgal flash. Returns a task the caller must keep while running.
 *
 * Events go out through `send({ status | progress | log | done })`, the same
 * shape the chat SSE uses, so the UI has one reader style. `task.cancel()`
 * kills the whole process tree (taskkill /T) — a bare child.kill() can leave
 * python holding the COM port (Windows serial ports are exclusive, pitfall #3
 * of the donor project).
 *
 * `spawnImpl` is injectable for tests (same philosophy as keil-core's `run`):
 * unit tests hand in a fake spawner and assert the event stream without
 * touching python, stcgal, or any hardware. It is used BOTH for the stcgal
 * child and for `taskkill.exe` in cancel(), so a test never spawns a real
 * process through the back door.
 *
 * @param {{ python: string, port: string, filePath: string, baud?: number,
 *            protocol?: string, autoreset?: boolean, send: Function,
 *            spawnImpl?: Function }} options
 * @returns {{ cancel: () => void, done: Promise<object> }}
 */
export function startStcgalFlash({
  python,
  port,
  filePath,
  baud = 115200,
  protocol = 'auto',
  autoreset = false,
  send,
  spawnImpl = spawn,
}) {
  const args = ['-m', 'stcgal', '-P', STCGAL_PROTOCOLS.includes(protocol) ? protocol : 'auto', '-p', port, '-b', String(baud)]
  if (autoreset) args.push('-a')
  args.push(filePath)

  const child = spawnImpl(python, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let cancelled = false
  let settled = false
  let stdoutTail = ''

  const handle = (chunk) => {
    const text = stdoutTail + chunk.toString('utf8')
    const lines = text.split(/\r?\n/)
    // Keep the unterminated tail so a progress line split across chunks is not lost.
    stdoutTail = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseStcgalLine(line)
      if (event) send(event)
    }
  }
  child.stdout.on('data', handle)
  child.stderr.on('data', handle)

  const done = new Promise((resolve) => {
    child.on('error', (error) => {
      if (settled) return
      settled = true
      resolve({ success: false, error: `无法启动 stcgal: ${error.message}` })
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      if (stdoutTail.trim()) send(parseStcgalLine(stdoutTail) ?? { kind: 'log', text: stdoutTail.trim() })
      resolve(
        cancelled
          ? { success: false, cancelled: true }
          : exitCode === 0
            ? { success: true, exitCode }
            : {
                success: false,
                exitCode,
                error:
                  `stcgal 退出码 ${exitCode}。常见原因：① 未及时断电上电（冷启动）；② COM 口选错或被其他程序占用；③ 波特率/协议不匹配；④ TX/RX 未交叉连接。`,
              },
      )
    })
  })

  return {
    cancel() {
      cancelled = true
      // /T kills the tree (python may spawn nothing today, but the port must
      // be released even if stcgal hangs inside a serial read).
      const killer = spawnImpl('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
    },
    done,
  }
}
