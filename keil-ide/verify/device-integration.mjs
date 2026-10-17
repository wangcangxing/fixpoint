#!/usr/bin/env node
/**
 * Device library integration acceptance — starts its own host, so one command
 * proves the whole chain:
 *   1. GET /api/devices returns the real C51 library (1703 devices)
 *   2. GET /api/device returns AT89C52's cdb memory + header SFRs
 *   3. POST /api/project/new resolves the device from the library and writes a
 *      correct `<TargetOption>` (no stale DeviceId)
 *   4. that generated project really builds with the local UV4 (hex produced)
 *   5. a part the 2017 library does not know (STC89C52) falls back to the default
 *      memory AND says so in `libraryNote`
 *   6. /api/chat injects [当前器件] and [器件库] into what the model receives
 *
 * Usage: node verify/device-integration.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeNodeRunner, resolveUv4 } from '../../keil-core.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4888
const mockPort = 4889
const base = `http://127.0.0.1:${port}`
const settingsPath = join(tmpdir(), `keil-device-settings-${Date.now()}.json`)
const workDir = join(tmpdir(), `keil-device-proj-${Date.now()}`)

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}
const exists = (path) => stat(path).then(() => true).catch(() => false)
const json = (path, init) => fetch(`${base}${path}`, init).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }))
const post = (path, body) =>
  json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const waitFor = async (url, attempts = 60) => {
  for (let index = 0; index < attempts; index += 1) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}

await mkdir(workDir, { recursive: true })
const server = spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
  cwd: join(root, 'keil-ide'),
  env: {
    ...process.env,
    KEIL_IDE_PORT: String(port),
    KEIL_IDE_SETTINGS: settingsPath,
    KEIL_IDE_AI_MODE: 'openai',
    KEIL_IDE_AI_BASEURL: `http://127.0.0.1:${mockPort}/v1`,
    KEIL_IDE_AI_KEY: 'test',
    KEIL_IDE_INLINE: '0',
  },
  stdio: 'ignore',
  windowsHide: true,
})
const mock = spawn(process.execPath, [join(root, 'keil-ide', 'verify', 'mock-openai.mjs'), String(mockPort)], {
  stdio: 'ignore',
  windowsHide: true,
})
const cleanup = () => {
  server.kill()
  mock.kill()
}
process.on('exit', cleanup)

if (!(await waitFor(`${base}/api/health`)) || !(await waitFor(`http://127.0.0.1:${mockPort}/v1/models`))) {
  console.error('could not start the test host (ports 4888/4889 busy?)')
  process.exit(2)
}

const library = await json('/api/devices')
check('device list status', library.status, 200)
check('device count', library.body.total, 1703)
check('vendor count', library.body.vendors.length, 77)

const one = await json('/api/device?name=AT89C52&header=1')
check('device detail status', one.status, 200)
check('AT89C52 project fields', one.body.project, {
  device: 'AT89C52',
  vendor: 'Atmel',
  cpu: 'IRAM(0-0xFF) IROM(0-0x1FFF) CLOCK(24000000)',
  deviceId: '',
  registerFile: 'REGX52.H',
  iromSize: '0x2000',
  iramSize: '0x100',
  xramSize: '0x0',
})
check('header SFRs', one.body.header.ok && one.body.header.sfr.includes('P0') && one.body.header.sfr.includes('T2CON'), true)

const created = await post('/api/project/new', { dir: workDir, name: 'dev52', device: { device: 'AT89C52' } })
check('create status', created.status, 200)
check('memory came from the library', created.body.memorySource, 'library')
const projectPath = join(workDir, 'dev52.uvproj')
const xml = await readFile(projectPath, 'utf8')
check('Device tag', /<Device>AT89C52<\/Device>/.test(xml), true)
check('Vendor tag', /<Vendor>Atmel<\/Vendor>/.test(xml), true)
check('no stale DeviceId', /<DeviceId>/.test(xml), false)
check('RegisterFile tag', /<RegisterFile>REGX52\.H<\/RegisterFile>/.test(xml), true)
check('IROM size', /<IRO>[\s\S]*?<Size>0x2000<\/Size>[\s\S]*?<\/IRO>/.test(xml), true)
check('IRAM size', /<IRA>[\s\S]*?<Size>0x100<\/Size>[\s\S]*?<\/IRA>/.test(xml), true)

const { uv4 } = await resolveUv4(makeNodeRunner())
if (uv4) {
  const logPath = join(workDir, 'build.log')
  const built = spawn(uv4, ['-b', projectPath, '-j0', '-o', logPath], { cwd: workDir, stdio: 'ignore', windowsHide: true })
  const exitCode = await new Promise((done) => built.on('close', done))
  check('UV4 build exit code', exitCode, 0)
  check('hex produced', await exists(join(workDir, 'Objects', 'dev52.hex')), true)
} else {
  console.log('SKIP  UV4 not found; build check skipped')
}

const unknown = await post('/api/project/new', { dir: workDir, name: 'stc', device: { device: 'STC89C52' } })
check('unknown part falls back', unknown.body.memorySource, 'default')
check('unknown part is called out', /器件库里没有 STC89C52/.test(unknown.body.libraryNote ?? ''), true)

await post('/api/settings', { project: projectPath })
const chat = await post('/api/chat', { prompt: 'AT89C52 和 AT89S52 有什么区别？' })
check('chat status', chat.status, 200)
const last = await fetch(`http://127.0.0.1:${mockPort}/last-request`).then((response) => response.json())
const userMessage = last?.messages?.find((message) => message.role === 'user')?.content ?? ''
const systemMessage = last?.messages?.find((message) => message.role === 'system')?.content ?? ''
check('chat carries the current device', /\[当前器件\] AT89C52/.test(userMessage), true)
check('chat looks up a mentioned device', /\[器件库\] AT89S52/.test(userMessage), true)
check('system prompt points at the library', /器件库/.test(systemMessage), true)

if (!failed) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
console.log(failed ? `\n${failed} check(s) failed (kept ${workDir})` : '\nall checks passed')
cleanup()
process.exit(failed ? 1 : 0)
