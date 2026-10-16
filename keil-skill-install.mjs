/**
 * Installing skills into THIS IDE's own table, deliberately isolated from any
 * other agent's skills directory.
 *
 * DSH's skill spec allows sharing roots (`<project>/.dsh/skills`,
 * `<agentsHome>/skills`, `<dshHome>/skills`). This IDE opts out by default: the
 * only roots it scans are its own, and a skill arrives here by an explicit
 * **install** step:
 *
 *   source = a `.md` / `.prompt` file
 *          | a directory containing `SKILL.md`
 *          | a `.zip` that contains `<name>/SKILL.md`
 *
 * The target is `<targetDir>/<name>.md` (flat) or `<targetDir>/<name>/SKILL.md`
 * (bundle), and nothing outside the IDE's own roots is ever written or removed.
 *
 * The ZIP reader is minimal on purpose (no dependencies): central directory →
 * local headers → raw or deflate. ZIP64 and encryption are refused with a clear
 * message rather than silently mis-read.
 *
 * @module keil-skill-install
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { SKILL_NAME_RE, parseSkill } from './keil-skills.mjs'

const MAX_SKILL_BYTES = 512 * 1024
const MAX_ZIP_BYTES = 8 * 1024 * 1024
const MAX_ZIP_ENTRIES = 500

/** Refuse a path that tries to escape its root. */
function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  const base = resolve(root)
  return target === base || target.startsWith(base + sep) ? target : ''
}

/** Minimal ZIP reader: returns `{ name, method, data }[]` (method 0 = stored, 8 = deflate). */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length > MAX_ZIP_BYTES) throw new Error(`zip 过大（>${MAX_ZIP_BYTES} 字节）`)
  // End of central directory: scan backwards for its signature.
  let eocd = -1
  for (let index = buf.length - 22; index >= 0 && index > buf.length - 66_000; index -= 1) {
    if (buf.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）')
  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || offset === 0xffffffff) throw new Error('暂不支持 ZIP64')
  const entries = []
  for (let index = 0; index < entryCount && index < MAX_ZIP_ENTRIES; index += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 中央目录已损坏')
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1')
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue // directory entry
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip 局部头已损坏: ${name}`)
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`zip 用了不支持的压缩方式 ${method}: ${name}`)
    if (data.length > MAX_SKILL_BYTES) throw new Error(`zip 内文件过大: ${name}`)
    entries.push({ name, method, data })
  }
  return entries
}

/** Validate a candidate skill body and return its parsed form. */
function validateSkill(text, fileName, descriptionMaxLength) {
  const skill = parseSkill(text, { fileName, descriptionMaxLength })
  if (!SKILL_NAME_RE.test(skill.name)) {
    throw new Error(`技能名 "${skill.name}" 不是 kebab-case（小写字母/数字，用 - 连接）`)
  }
  if (!skill.content.trim()) throw new Error('技能正文为空')
  return skill
}

/**
 * Install one skill from a file, directory bundle, or zip.
 * @param {{source: string, targetDir: string, scope?: string, force?: boolean, descriptionMaxLength?: number}} options
 */
export async function installSkill(options) {
  const { source, targetDir, scope = 'user', force = false, descriptionMaxLength = 500 } = options
  if (!source || !isAbsolute(source)) return { ok: false, code: 400, error: '请给出绝对路径（文件、目录或 .zip）' }
  if (!targetDir || !isAbsolute(targetDir)) return { ok: false, code: 400, error: '缺少安装目标目录' }
  const info = await stat(source).catch(() => undefined)
  if (!info) return { ok: false, code: 404, error: `找不到来源: ${source}` }

  let skill
  let bundleFiles = [] // [{ relative, data }] for bundle form
  try {
    if (info.isDirectory()) {
      const bundleFile = join(source, 'SKILL.md')
      const bundleText = await readFile(bundleFile, 'utf8').catch(() => undefined)
      if (bundleText) {
        skill = validateSkill(bundleText, 'SKILL.md', descriptionMaxLength)
        bundleFiles = [{ relative: 'SKILL.md', data: Buffer.from(bundleText, 'utf8') }]
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name === 'SKILL.md') continue
          const data = await readFile(join(source, entry.name))
          if (data.length <= MAX_SKILL_BYTES) bundleFiles.push({ relative: entry.name, data })
        }
      } else {
        const entries = await readdir(source, { withFileTypes: true })
        const md = entries.find((entry) => entry.isFile() && /\.(md|prompt)$/i.test(entry.name))
        if (!md) return { ok: false, code: 400, error: '目录里既没有 SKILL.md，也没有 .md/.prompt 文件' }
        const text = await readFile(join(source, md.name), 'utf8')
        skill = validateSkill(text, md.name, descriptionMaxLength)
        bundleFiles = [{ relative: `${skill.name}.md`, data: Buffer.from(text, 'utf8') }]
      }
    } else if (/\.zip$/i.test(source)) {
      const entries = readZipEntries(await readFile(source))
      const skillEntry = entries.find((entry) => /(^|\/)SKILL\.md$/i.test(entry.name))
      const flatEntry = skillEntry ? undefined : entries.find((entry) => /\.(md|prompt)$/i.test(entry.name))
      const chosen = skillEntry ?? flatEntry
      if (!chosen) return { ok: false, code: 400, error: 'zip 里没有 SKILL.md 或 .md 文件' }
      const text = chosen.data.toString('utf8')
      const fileName = basename(chosen.name)
      skill = validateSkill(text, fileName === 'SKILL.md' ? `${basename(dirname(chosen.name))}.md` : fileName, descriptionMaxLength)
      // Keep a bundle's sibling resources, but only the ones under its own folder.
      const folder = dirname(chosen.name)
      bundleFiles = entries
        .filter((entry) => (folder && folder !== '.' ? entry.name.startsWith(`${folder}/`) : !entry.name.includes('/')))
        .map((entry) => ({ relative: folder && folder !== '.' ? entry.name.slice(folder.length + 1) : entry.name, data: entry.data }))
      if (!bundleFiles.length) bundleFiles = [{ relative: 'SKILL.md', data: chosen.data }]
    } else {
      const text = await readFile(source, 'utf8')
      if (text.length > MAX_SKILL_BYTES) return { ok: false, code: 400, error: '技能文件过大' }
      skill = validateSkill(text, basename(source), descriptionMaxLength)
      bundleFiles = [{ relative: `${skill.name}.md`, data: Buffer.from(text, 'utf8') }]
    }
  } catch (error) {
    return { ok: false, code: 400, error: error.message }
  }

  const isBundle = bundleFiles.length > 1 || bundleFiles[0]?.relative === 'SKILL.md'
  const target = isBundle ? safeJoin(targetDir, skill.name) : safeJoin(targetDir, `${skill.name}.md`)
  if (!target) return { ok: false, code: 400, error: '安装路径越界' }
  const existing = await stat(target).catch(() => undefined)
  if (existing && !force) {
    return { ok: false, code: 409, error: `${skill.name} 已安装（先卸载，或用 force 覆盖）`, name: skill.name }
  }
  if (existing && force) await rm(target, { recursive: true, force: true })

  await mkdir(targetDir, { recursive: true })
  let bytes = 0
  if (isBundle) {
    await mkdir(target, { recursive: true })
    for (const file of bundleFiles) {
      const filePath = safeJoin(target, file.relative)
      if (!filePath) continue // a resource trying to escape the bundle is skipped
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, file.data)
      bytes += file.data.length
    }
  } else {
    await writeFile(target, bundleFiles[0].data)
    bytes = bundleFiles[0].data.length
  }
  return {
    ok: true,
    name: skill.name,
    description: skill.description,
    scope,
    form: isBundle ? 'bundle' : 'flat',
    path: target,
    files: bundleFiles.length,
    bytes,
  }
}

/**
 * Remove an installed skill. Only paths inside `allowedRoots` may be deleted, and
 * `bundled` skills (shipped with the app) are never removable.
 */
export async function uninstallSkill({ name, roots = [] }) {
  const wanted = String(name ?? '').trim().toLowerCase()
  if (!SKILL_NAME_RE.test(wanted)) return { ok: false, code: 400, error: '技能名不是 kebab-case' }
  const candidates = []
  for (const root of roots) {
    if (root.source === 'bundled') continue
    candidates.push(join(root.dir, wanted), join(root.dir, `${wanted}.md`), join(root.dir, `${wanted}.prompt`))
  }
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => undefined)
    if (!info) continue
    await rm(candidate, { recursive: true, force: true })
    return { ok: true, name: wanted, removed: candidate }
  }
  return { ok: false, code: 404, error: `没有安装名为 ${name} 的技能（内置技能不能卸载）` }
}
