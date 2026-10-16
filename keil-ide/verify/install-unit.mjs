#!/usr/bin/env node
/**
 * Unit tests for ../../keil-skill-install.mjs: install from a flat file, a
 * directory bundle, and a zip (stored here; pass a deflate zip path as argv[2]
 * to also cover the inflate path).
 *
 * Usage: node verify/install-unit.mjs [optional-deflate-zip]
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkill, readZipEntries, uninstallSkill } from '../../keil-skill-install.mjs'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

/** CRC32, only because a zip should be well-formed. */
function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

/** Minimal stored-only zip writer (test infrastructure). */
function storeZip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, eocd])
}

const base = await mkdtemp(join(tmpdir(), 'keil-install-'))
const target = join(base, 'skills')
const srcDir = join(base, 'src')
await mkdir(srcDir, { recursive: true })

// --- flat file ---
const flat = join(srcDir, 'led-pwm.md')
await writeFile(flat, '---\nname: led-pwm\ndescription: 呼吸灯分段调光\n---\n正文 PWM\n')
const flatResult = await installSkill({ source: flat, targetDir: target })
check('装平铺技能：成功', [flatResult.ok, flatResult.form, flatResult.name], [true, 'flat', 'led-pwm'])
check('装平铺技能：文件落盘', (await stat(join(target, 'led-pwm.md'))).isFile(), true)

// --- duplicate + force ---
check('重复安装 → 409', (await installSkill({ source: flat, targetDir: target })).code, 409)
check('force 覆盖 → 成功', (await installSkill({ source: flat, targetDir: target, force: true })).ok, true)

// --- bad inputs ---
const badName = join(srcDir, 'Bad_Name.md')
await writeFile(badName, '---\nname: Bad_Name\ndescription: 非法名\n---\n正文\n')
check('非法技能名 → 400', (await installSkill({ source: badName, targetDir: target })).code, 400)
check('相对路径 → 400', (await installSkill({ source: 'led-pwm.md', targetDir: target })).code, 400)
check('不存在的来源 → 404', (await installSkill({ source: join(srcDir, 'nope.md'), targetDir: target })).code, 404)

// --- directory bundle with a sibling resource ---
const bundleSrc = join(srcDir, 'bundle-src')
await mkdir(bundleSrc, { recursive: true })
await writeFile(join(bundleSrc, 'SKILL.md'), '---\nname: timer-pro\ndescription: 定时器进阶\n---\n正文 定时器\n')
await writeFile(join(bundleSrc, 'tmpl.c'), 'void tmpl(void) {}\n')
const bundleResult = await installSkill({ source: bundleSrc, targetDir: target })
check('装目录包：成功', [bundleResult.ok, bundleResult.form, bundleResult.files], [true, 'bundle', 2])
check('目录包：SKILL.md 落盘', (await stat(join(target, 'timer-pro', 'SKILL.md'))).isFile(), true)
check('目录包：同级资源一起装', (await readFile(join(target, 'timer-pro', 'tmpl.c'), 'utf8')).includes('tmpl'), true)

// --- zip (stored) with a bundle + a traversal attempt ---
const zipPath = join(srcDir, 'zip-skill.zip')
await writeFile(
  zipPath,
  storeZip([
    { name: 'zip-skill/SKILL.md', data: '---\nname: zip-skill\ndescription: 来自 zip\n---\n正文 zip\n' },
    { name: 'zip-skill/extra.txt', data: 'resource\n' },
    { name: 'zip-skill/../evil.txt', data: 'should not escape\n' },
  ]),
)
const entries = readZipEntries(await readFile(zipPath))
check('zip 读取条目数', entries.length, 3)
check('zip 读到 SKILL.md', entries.some((entry) => entry.name.endsWith('SKILL.md')), true)
const zipResult = await installSkill({ source: zipPath, targetDir: target })
check('装 zip：成功且为目录包', [zipResult.ok, zipResult.form, zipResult.name], [true, 'bundle', 'zip-skill'])
check('zip：资源一起装', (await stat(join(target, 'zip-skill', 'extra.txt'))).isFile(), true)
check('zip：越界文件未被写出', await stat(join(base, 'evil.txt')).then(() => true).catch(() => false), false)

// --- deflate zip (produced by an external tool, passed in) ---
const deflateZip = process.argv[2]
if (deflateZip) {
  const result = await installSkill({ source: deflateZip, targetDir: target, force: true })
  check('deflate zip 也能装（method 8）', result.ok, true)
} else {
  console.log('SKIP  deflate zip（未提供 argv[2]）')
}

// --- uninstall ---
const roots = [{ dir: target, source: 'user-ide', rank: 400 }, { dir: join(base, 'bundled'), source: 'bundled', rank: 600 }]
await mkdir(join(base, 'bundled'), { recursive: true })
await writeFile(join(base, 'bundled', 'keep-me.md'), '---\nname: keep-me\ndescription: 内置\n---\n正文\n')
check('卸载已安装技能', (await uninstallSkill({ name: 'led-pwm', roots })).ok, true)
check('卸载后文件消失', await stat(join(target, 'led-pwm.md')).then(() => true).catch(() => false), false)
check('卸载不存在的 → 404', (await uninstallSkill({ name: 'nope', roots })).code, 404)
check('内置技能不可卸载', (await uninstallSkill({ name: 'keep-me', roots })).code, 404)
check('内置文件仍在', (await stat(join(base, 'bundled', 'keep-me.md'))).isFile(), true)
check('卸载目录包', (await uninstallSkill({ name: 'timer-pro', roots })).ok, true)

await rm(base, { recursive: true, force: true })

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
