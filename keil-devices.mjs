/**
 * The Keil C51 device library ("器件库"), read from the user's own install.
 *
 * Measured facts (2026-10-17, C51 V9.57 / µVision 5.24.2.86):
 *   - The database is `UV4\UV4.cdb` (NOT `*.uv2`; an earlier note in this repo was
 *     wrong about that). Keil ships `UV4\UVCDB2XML.exe` to export it.
 *   - `UVCDB2XML.exe -f UV4.cdb -a C51 out.xml` yields 1703 C51 devices / 77
 *     vendors in ~0.1 s. Without `-a C51` it exports the ARM database instead
 *     (2831 devices), because this install's TOOLS.INI says `TOOL_VARIANT=mdk_lite`.
 *   - That XML carries name/vendor/header/description but NOT `DeviceId`, the
 *     `Cpu` memory string or `<OnChipMemories>` — and those are required to build
 *     (`UV4 -b` fails with `L228 RAMSIZE PARAMETER OUT OF RANGE` when IRA is 0).
 *   - The raw `.cdb` DOES carry them as `CPU` / `REGFILE` fields. The file is an
 *     undocumented node stream; `scanCdbFields()` below reads those two fields with
 *     a verified signature (length-prefixed key/value) instead of trusting the
 *     container layout. Coverage measured: 1693 of 1703 C51 devices (the other 10
 *     are "see XXX" placeholders). AT89C51/52/55 were checked against the values
 *     µVision itself wrote into the user's projects (DeviceId aside).
 *   - The exported XML is NOT well-formed: descriptions contain bare `&`
 *     (50 occurrences for C51). Everything here is regex-based on purpose.
 *   - The library is from 2017: STC / STC15 / N76E003 are absent. AT89C52 is the
 *     compatible choice for those parts.
 *
 * Verified end-to-end: a project generated from AT89C52's cdb values (Vendor
 * `Atmel`, `Cpu` from cdb, IROM 0x2000 / IRAM 0x100, no `<DeviceId>`) builds with
 * `0 Error(s), 0 Warning(s)`.
 *
 * @module keil-devices
 */
import { readFile, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { resolveUv4 } from './keil-core.mjs'
import { parseC51Text, resolveC51IncludeDir } from './keil-symbols.mjs'

/** Strip the `:id` suffix the exporter appends to vendor names (`Atmel:3`). */
const vendorName = (raw) => String(raw ?? '').replace(/:\d+$/, '').trim()

/** One `<device>` block, tolerant of attribute order and of a missing `core`. */
const DEVICE_RE = /<device\s+name="([^"]*)"([^>]*)>([\s\S]*?)<\/device>/g
const VENDOR_RE = /<vendor\s+name="([^"]+)">([\s\S]*?)<\/vendor>/g
const attr = (attrs, name) => (new RegExp(`${name}="([^"]*)"`).exec(attrs) ?? [])[1] ?? ''
const tag = (body, name) => (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body) ?? [])[1] ?? ''

/**
 * Parse the XML the official converter produced. Deliberately not an XML parser:
 * the file is malformed (bare `&`), and regex keeps working.
 * @param {string} text
 * @returns {object[]} devices in document order
 */
export function parseDeviceXml(text) {
  const devices = []
  for (const vendorBlock of String(text).matchAll(VENDOR_RE)) {
    const vendor = vendorName(vendorBlock[1])
    const vendorId = (/(?::(\d+))$/.exec(vendorBlock[1]) ?? [])[1] ?? ''
    for (const match of vendorBlock[2].matchAll(DEVICE_RE)) {
      const body = match[3]
      devices.push({
        name: match[1].trim(),
        vendor,
        vendorId,
        core: attr(match[2], 'core'),
        family: attr(match[2], 'family') || 'C51',
        startup: tag(body, 'startup').trim(),
        system: tag(body, 'system').trim(),
        includeFile: tag(body, 'includeFile').trim(),
        includePath: tag(body, 'includePath').trim(),
        description: tag(body, 'description').trim(),
      })
    }
  }
  return devices
}

/**
 * Read the `CPU` and `REGFILE` fields out of `UV4.cdb`.
 *
 * The container is a stream of nodes; a device's fields follow its name record.
 * Rather than re-implement that layout, this scans for the key/value signature
 * (`05 <keylen:u16> <key> <vallen:u16> <value>`) and attributes each hit to the
 * most recent name record (`<kind:01|02> <strlen:u16> <string>`, whose length
 * field sits 2 bytes before the kind byte and equals strlen + 4).
 *
 * @param {Buffer} buffer - the raw .cdb
 * @returns {Map<string, {cpu?: string, regfile?: string}>} keyed by device name
 */
export function scanCdbFields(buffer) {
  const byName = new Map()
  const u16 = (at) => buffer[at] | (buffer[at + 1] << 8)
  const readable = (at, length) => {
    if (at < 0 || at + length > buffer.length) return false
    for (let index = at; index < at + length; index += 1) {
      const byte = buffer[index]
      if (byte < 0x20 || byte > 0x7e) return false
    }
    return true
  }
  const slice = (at, length) => buffer.toString('latin1', at, at + length)

  let current = null
  for (let index = 4; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 0x01 || buffer[index] === 0x02) {
      const length = u16(index + 1)
      if (length > 0 && length < 80 && u16(index - 2) === length + 4 && readable(index + 3, length)) {
        const value = slice(index + 3, length)
        if (buffer[index] === 0x02) {
          current = value
          if (!byName.has(value)) byName.set(value, {})
        }
        index += 2 + length
        continue
      }
    }
    if (buffer[index] === 0x05) {
      const keyLength = u16(index + 1)
      if (keyLength > 0 && keyLength < 20 && readable(index + 3, keyLength)) {
        const key = slice(index + 3, keyLength)
        const valueLength = u16(index + 3 + keyLength)
        if (
          valueLength > 0 &&
          valueLength < 400 &&
          index + 5 + keyLength + valueLength <= buffer.length &&
          readable(index + 5 + keyLength, valueLength)
        ) {
          const value = slice(index + 5 + keyLength, valueLength)
          const record = current ? byName.get(current) : undefined
          if (record && key === 'CPU' && !record.cpu) record.cpu = value
          if (record && key === 'REGFILE' && !record.regfile) record.regfile = value
          index += 4 + keyLength + valueLength
          continue
        }
      }
    }
  }
  return byName
}

/** `IRAM(0-0x7F)` / `IRAM(0 - 0xFF)` -> `0x80` / `0x100`; undefined when absent. */
export function parseMemory(cpu, name) {
  const match = new RegExp(`${name}\\s*\\(\\s*(0x[0-9a-fA-F]+|\\d+)\\s*-\\s*(0x[0-9a-fA-F]+|\\d+)\\s*\\)`).exec(
    String(cpu ?? ''),
  )
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return `0x${(end - start + 1).toString(16)}`
}

/** `REGX51.H("Atmel")` -> `REGX51.H`. */
const registerFile = (raw) => String(raw ?? '').replace(/\(.*$/, '').trim()

/**
 * Where the database and its converter live, given the toolchain discovery.
 * @returns {Promise<{ok: boolean, uv4Dir?: string, cdb?: string, converter?: string, error?: string}>}
 */
export async function resolveDeviceDatabase(run) {
  const { uv4 } = await resolveUv4(run)
  if (!uv4) return { ok: false, error: '找不到 UV4.exe（先确认 Keil C51 已安装，或设置 KEIL_UV4_PATH）' }
  const uv4Dir = resolve(uv4, '..')
  const cdb = join(uv4Dir, 'UV4.cdb')
  const converter = join(uv4Dir, 'UVCDB2XML.exe')
  for (const [path, label] of [
    [cdb, 'UV4.cdb'],
    [converter, 'UVCDB2XML.exe'],
  ]) {
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) return { ok: false, error: `${label} 不在 ${uv4Dir}` }
  }
  return { ok: true, uv4Dir, cdb, converter }
}

/**
 * Convert the C51 part of the database to XML and parse it.
 * @param {Function} run - the injected process runner from keil-core.
 * @param {{cdb: string, converter: string}} db
 */
export async function exportDevices(run, db) {
  const output = join(tmpdir(), `keil-devices-${process.pid}-${Date.now().toString(36)}.xml`)
  try {
    const result = await run([db.converter, '-f', db.cdb, '-a', 'C51', output], { graceMs: 30000 })
    if (result.exitCode !== 0) {
      throw new Error(`UVCDB2XML 退出码 ${result.exitCode}: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`)
    }
    return parseDeviceXml(await readFile(output, 'utf8'))
  } finally {
    await unlink(output).catch(() => undefined)
  }
}

let cache = null

/**
 * Load (and cache) the whole C51 device library, with each device's project
 * fields resolved. The cache is keyed on the database's mtime + size.
 *
 * @param {Function} run
 * @param {{force?: boolean}} [options]
 * @returns {Promise<object>} `{ ok, devices, vendors, byName, dbPath, exportedAt, error? }`
 */
export async function loadDeviceLibrary(run, options = {}) {
  const db = await resolveDeviceDatabase(run)
  if (!db.ok) return { ok: false, error: db.error, devices: [], vendors: [], byName: new Map() }
  const info = await stat(db.cdb)
  const key = `${db.cdb}|${info.mtimeMs}|${info.size}`
  if (!options.force && cache && cache.key === key) return cache.value

  let devices
  let cdbFields
  try {
    devices = await exportDevices(run, db)
    cdbFields = scanCdbFields(await readFile(db.cdb))
  } catch (error) {
    return {
      ok: false,
      error: `器件库读取失败: ${error instanceof Error ? error.message : String(error)}`,
      devices: [],
      vendors: [],
      byName: new Map(),
    }
  }

  const byName = new Map()
  for (const device of devices) {
    const fields = cdbFields.get(device.name) ?? {}
    const cpu = fields.cpu ?? ''
    const header = device.includeFile || registerFile(fields.regfile)
    const entry = {
      ...device,
      cpu,
      registerFile: registerFile(fields.regfile) || header,
      iromSize: parseMemory(cpu, 'IROM') ?? '',
      iramSize: parseMemory(cpu, 'IRAM') ?? '',
      xramSize: parseMemory(cpu, 'XRAM') ?? '0x0',
      // The linker's fatal check is RAMSIZE (`L228`), so RAM is what a project
      // needs; 268 real C51 parts (external-ROM designs) legitimately have no
      // IROM, and `IRO 0x0` builds (measured).
      hasMemory: Boolean(parseMemory(cpu, 'IRAM')),
      hasRom: Boolean(parseMemory(cpu, 'IROM')),
    }
    // Names are unique across the C51 set (measured), but keep the first anyway.
    if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }

  const counts = new Map()
  for (const device of byName.values()) counts.set(device.vendor, (counts.get(device.vendor) ?? 0) + 1)
  const vendors = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))

  const value = {
    ok: true,
    dbPath: db.cdb,
    uv4Dir: db.uv4Dir,
    exportedAt: new Date().toISOString(),
    devices: [...byName.values()],
    vendors,
    byName,
  }
  cache = { key, value }
  return value
}

/**
 * The subset `keil-project.mjs` needs to write a correct `<TargetOption>`.
 * `deviceId` is intentionally absent: the exporter does not provide it and
 * `UV4 -b` builds without it (measured).
 */
export function deviceProjectFields(device) {
  return {
    device: device.name,
    vendor: device.vendor,
    cpu: device.cpu,
    // The exporter does not expose µVision's numeric DeviceId. Emitting the
    // default's 2976 here would be a lie about a different chip, and the XML
    // generator omits the tag when it is empty (UV4 -b builds without it).
    deviceId: '',
    registerFile: device.registerFile || device.includeFile,
    // 0x0 is explicit, not a guess: µVision accepts it (measured) and it is the
    // honest value for the external-ROM parts that have no on-chip IROM.
    iromSize: device.iromSize || '0x0',
    iramSize: device.iramSize,
    xramSize: device.xramSize || '0x0',
  }
}

/**
 * Read one device's header (SFR definitions) from the user's C51 install.
 * Read-only and confined to `<C51>\INC`.
 * @returns {Promise<{ok: boolean, path?: string, text?: string, error?: string}>}
 */
export async function readDeviceHeader(run, device, { maxBytes = 256 * 1024 } = {}) {
  if (!device?.includeFile) return { ok: false, error: '该器件没有头文件字段' }
  const include = await resolveC51IncludeDir(run)
  if (!include.dir) return { ok: false, error: '找不到 C51\\INC 目录' }
  const relative = join(device.includePath || '', device.includeFile)
  const target = resolve(include.dir, relative)
  const root = resolve(include.dir)
  if (target !== root && !target.startsWith(root + sep)) {
    return { ok: false, error: '头文件路径越界（已拒绝）' }
  }
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) return { ok: false, path: target, error: `头文件不存在: ${target}` }
  if (info.size > maxBytes) return { ok: false, path: target, error: `头文件过大（${info.size} 字节）` }
  return { ok: true, path: target, text: await readFile(target, 'utf8') }
}

/** SFR / sbit names declared by a device header (for prompts, not for editing). */
export function headerSfrNames(text) {
  const parsed = parseC51Text(String(text ?? ''), { file: '', from: 'header' })
  return parsed.symbols
    .filter((symbol) => symbol.kind === 'sfr' || symbol.kind === 'sbit')
    .map((symbol) => symbol.name)
}

/** A compact one-device description for the AI prompt. */
export function deviceBrief(device, { sfr = [], maxDescription = 600 } = {}) {
  const memory = device.hasMemory
    ? `ROM ${device.hasRom ? device.iromSize : '无（外部程序存储器）'} / RAM ${device.iramSize}`
    : 'ROM/RAM 未取到'
  const description = String(device.description ?? '').replace(/\s+/g, ' ').slice(0, maxDescription)
  return [
    `${device.name}（${device.vendor}，${device.family}）— ${memory}`,
    device.includeFile ? `头文件: ${device.includeFile}${device.includePath ? `（${device.includePath}）` : ''}` : '',
    description ? `描述: ${description}` : '',
    sfr.length ? `SFR/位: ${sfr.slice(0, 40).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Device names mentioned by the user in a prompt. Word-boundary matched so that
 * `AT89C51` does not fire inside `AT89C51RC2`, and capped so a long prompt cannot
 * pull in dozens of devices.
 * @returns {object[]} up to `limit` devices
 */
export function findMentionedDevices(prompt, devices, { limit = 3 } = {}) {
  const text = String(prompt ?? '').toLowerCase()
  if (!text) return []
  const hits = []
  for (const device of devices) {
    const needle = device.name.toLowerCase()
    if (needle.length < 4) continue
    let from = text.indexOf(needle)
    while (from !== -1) {
      const before = text[from - 1] ?? ''
      const after = text[from + needle.length] ?? ''
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
        hits.push({ device, at: from })
        break
      }
      from = text.indexOf(needle, from + 1)
    }
  }
  // Prompt order, not library order: "AT89C52 和 AT89C51RC2" should list AT89C52 first.
  return hits
    .sort((left, right) => left.at - right.at)
    .slice(0, limit)
    .map((hit) => hit.device)
}
