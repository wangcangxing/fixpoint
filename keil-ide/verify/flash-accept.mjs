#!/usr/bin/env node
/**
 * /api/flash/* end-to-end acceptance — real host + real stcgal discovery, but
 * ZERO hardware writes. Coverage matrix (honest boundaries):
 *
 *   verified here:   status with missing engine, status with auto-discovered
 *                    engine (1.10), start errors (no project / no hex), start
 *                    SSE stream against a NON-EXISTENT port (COM255) ending in
 *                    done{success:false}, busy released afterwards, idle cancel.
 *   NOT covered:     a successful flash (needs a real STC board + explicit
 *                    human consent), concurrent 409 (too racy with the fast
 *                    COM255 failure — enforced by `activeFlash` in code and
 *                    covered by flash-unit.mjs's mutual-exclusion assertions).
 *
 * No real COM port from the machine's port list is ever used. COM255 does not
 * exist on this host, so stcgal fails to open it before any protocol traffic.
 *
 * Usage: node verify/flash-accept.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4885
const base = `http://127.0.0.1:${port}`
const work = await mkdtemp(join(tmpdir(), 'keil-flash-accept-'))
const settingsPath = join(work, 'settings.json')
const home = join(work, 'home')
await mkdir(home, { recursive: true })

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

const server = spawn(process.execPath, [join(root, 'keil-ide', 'server.mjs')], {
  cwd: join(root, 'keil-ide'),
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    KEIL_IDE_PORT: String(port),
    KEIL_IDE_SETTINGS: settingsPath,
    KEIL_IDE_AI_MODE: 'openai',
    KEIL_IDE_AI_BASEURL: 'http://127.0.0.1:9/v1',
    KEIL_IDE_AI_KEY: 'x',
    KEIL_IDE_INLINE: '0',
  },
  stdio: 'ignore',
  windowsHide: true,
})
process.on('exit', () => server.kill())

const waitFor = async (url, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false)
    if (ok) return true
    await new Promise((done) => setTimeout(done, 250))
  }
  return false
}
if (!(await waitFor(`${base}/api/health`))) {
  console.error(`could not start the test host on ${base} (port busy?)`)
  process.exit(2)
}

const put = async (patch) => {
  const data = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((response) => response.json())
  return data
}
const jsonPost = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const configure = async (patch) => put(patch)

console.log('--- 1) status：配置的 python 无效（模块会继续尝试 known-root/PATH） ---')
await configure({ flash: { python: 'C:\\does-not-exist\\python.exe' } })
const missing = await fetch(`${base}/api/flash/status`).then((response) => response.json())
// discoverStcgal does not stop at the first bad candidate: it falls back to
// KEIL_PYTHON / known roots / PATH. With a real stcgal installed here, a bad
// configured path therefore STILL discovers 1.10. Assert the honest contract:
// the bad path is recorded in `tried`, and the winner is NOT the bad path.
check('无效配置被记录到 tried', (missing.tried ?? []).includes('C:\\does-not-exist\\python.exe'), true)
check('回退命中后 stcgal 版本为 1.10', missing.stcgal, '1.10')
check('python 不是那个无效路径', missing.python === 'C:\\does-not-exist\\python.exe', false)
check('ports 是数组', Array.isArray(missing.ports), true)
check('busy=false', missing.busy, false)

console.log('--- 2) status：自动发现本机引擎（只读 --version） ---')
await configure({ flash: { python: '' } })
const healthy = await fetch(`${base}/api/flash/status`).then((response) => response.json())
check('自动发现 stcgal 版本', healthy.stcgal, '1.10')
check('python 非空', (healthy.python ?? '').length > 0, true)

console.log('--- 3) start：无工程 → 400 ---')
await configure({ project: '' })
const noProject = await jsonPost('/api/flash/start', { port: 'COM255' })
check('无工程状态码', noProject.status, 400)
check('无工程错误文案', (await noProject.json()).error.includes('工程'), true)

console.log('--- 4) start：有工程但 hex 未生成 → 400 + Create Hex File 提示 ---')
const projectPath = join(work, 'fake.uvproj')
await writeFile(
  projectPath,
  '<Project><Targets><Target><TargetName>T</TargetName><OutputName>fake</OutputName><CreateHexFile>0</CreateHexFile></Target></Targets></Project>',
  'utf8',
)
await configure({ project: projectPath })
const noHex = await jsonPost('/api/flash/start', { port: 'COM255' })
check('无 hex 状态码', noHex.status, 400)
check('提示勾选 Create Hex File', (await noHex.json()).error.includes('Create Hex File'), true)

console.log('--- 5) start：COM255（不存在）→ SSE + done 失败，全程不碰实物 ---')
const fakeHex = join(work, 'Objects', 'flashing.hex')
await mkdir(dirname(fakeHex), { recursive: true })
await writeFile(fakeHex, ':0100000001FE\n:00000001FF\n', 'utf8')
const withHexProject = join(work, 'flashing.uvproj')
await writeFile(
  withHexProject,
  '<Project><Targets><Target><TargetName>T</TargetName><OutputName>flashing</OutputName><CreateHexFile>1</CreateHexFile></Target></Targets></Project>',
  'utf8',
)
await configure({ project: withHexProject })
const started = await jsonPost('/api/flash/start', { port: 'COM255' })
if (started.status !== 200) {
  const body = await started.clone().json().catch(() => ({}))
  console.log(`      start 400 body: ${JSON.stringify(body)}`)
}
check('SSE 状态码', started.status, 200)
check('content-type 是 event-stream', /text\/event-stream/.test(started.headers.get('content-type') ?? ''), true)

const frames = []
const reader = started.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const timeoutMs = 30000
const startedAt = Date.now()
const handle = (payload) => {
  frames.push(payload)
}
outer: while (Date.now() - startedAt < timeoutMs) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  let index
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, index)
    buffer = buffer.slice(index + 2)
    const line = frame.split('\n').find((part) => part.startsWith('data:'))
    if (!line) continue
    try {
      handle(JSON.parse(line.slice(5).trim()))
    } catch {
      // ignore partial
    }
    if (frames.some((item) => item.done)) break outer
  }
}
const doneFrame = frames.find((item) => item.done)?.done
check('收到 done 帧', Boolean(doneFrame), true)
check('至少一条 log 帧', frames.some((item) => typeof item.log === 'string'), true)
check('done.success=false', doneFrame?.success ?? null, false)
check('done.exitCode 非 0', (doneFrame?.exitCode ?? 0) !== 0, true)

console.log('--- 6) 流结束后 busy 释放 ---')
const after = await fetch(`${base}/api/flash/status`).then((response) => response.json())
check('busy 已释放', after.busy, false)

console.log('--- 7) 空闲 cancel ---')
const cancelled = await jsonPost('/api/flash/cancel', {}).then((response) => response.json())
check('cancel 返回 false', cancelled.cancelled, false)

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
server.kill()
process.exit(failed ? 1 : 0)
