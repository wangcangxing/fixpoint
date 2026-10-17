#!/usr/bin/env node
/**
 * Skill install picker acceptance (headless Chrome + CDP):
 *   1. the skills pane offers "选择文件… / 选择文件夹…" next to the source field
 *   2. both dialog buttons are really visible, not clipped by the modal
 *   3. the endpoints decide title / start folder / filters correctly (dryRun)
 *   4. a picked path installs and uninstalls end to end
 *   5. in browser mode (no Electron) the button reports the honest fallback
 *   6. capture a screenshot of the pane
 *
 * The native dialog itself cannot be driven from CDP, so the window options are
 * asserted through `/api/pick-file`'s `dryRun` and the dialog wiring is the same
 * call the "打开文件" button already uses.
 *
 * Usage: node verify/skill-picker-ui.mjs [serverPort] [chromePort]
 *   (expects a server started with KEIL_IDE_PORT=<serverPort>; default 4897)
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const serverPort = process.argv[2] ?? '4897'
const chromePort = process.argv[3] ?? '9334'
const server = `http://127.0.0.1:${serverPort}`
const SKILL_NAME = 'picker-test-skill'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`,
  )
}

const health = await fetch(`${server}/api/health`).catch(() => undefined)
if (!health?.ok) {
  console.error(`no IDE server on ${server} — start one with KEIL_IDE_PORT=${serverPort}`)
  process.exit(2)
}

// A real skill file on disk, so the install half of the flow is not mocked.
const base = await mkdtemp(join(tmpdir(), 'keil-skill-picker-'))
const skillFile = join(base, `${SKILL_NAME}.md`)
await writeFile(skillFile, '---\nname: picker-test-skill\ndescription: 选择框端到端测试\n---\n正文：由 verify/skill-picker-ui.mjs 安装\n')
const existingDir = process.cwd()

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const { existsSync } = await import('node:fs')
const chrome = chromeCandidates.find((path) => existsSync(path))
if (!chrome) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}

const profile = join(tmpdir(), `dsh-chrome-skill-picker-${chromePort}`)
await rm(profile, { recursive: true, force: true }).catch(() => undefined)
await mkdir(profile, { recursive: true })

const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    server,
  ],
  { stdio: 'ignore', windowsHide: true },
)
process.on('exit', () => browser.kill())

let target
for (let attempt = 0; attempt < 60; attempt += 1) {
  const targets = await fetch(`http://127.0.0.1:${chromePort}/json`).then((response) => response.json()).catch(() => [])
  target = targets.find((entry) => entry.type === 'page')
  if (target) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!target) {
  console.error('no page target from Chrome')
  process.exit(2)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error)
    pending.delete(message.id)
  }
})
await new Promise((resolve) => socket.addEventListener('open', resolve))

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result))
  return result?.result?.value
}
const until = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

check('page loaded', await until(`document.readyState === 'complete' && !!document.getElementById('btn-settings')`), true)

await evaluate(`(() => {
  document.getElementById('btn-settings').click()
  document.querySelector('.settings-tabs .tab[data-tab="skills"]').click()
  return true
})()`)
check('skills pane open', await until(`!document.getElementById('settings').classList.contains('hidden')`), true)
check('picker buttons exist', await until(`!!document.getElementById('btn-pick-skill-file') && !!document.getElementById('btn-pick-skill-dir')`), true)

// A button can exist and still be clipped by `.modal-box { overflow: hidden }`:
// measure the rendered box and hit-test its centre.
const layout = await evaluate(`(() => {
  const measure = (id) => {
    const element = document.getElementById(id)
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
    return {
      text: element.textContent.trim(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
      clickable: !!hit && (hit === element || element.contains(hit)),
    }
  }
  const input = document.getElementById('skills-source')
  const fieldRect = input.getBoundingClientRect()
  const fileRect = document.getElementById('btn-pick-skill-file').getBoundingClientRect()
  return {
    file: measure('btn-pick-skill-file'),
    dir: measure('btn-pick-skill-dir'),
    inputPlaceholder: input.getAttribute('placeholder'),
    inputEditable: !input.readOnly,
    buttonsBesideInput: fileRect.left > fieldRect.right - 1,
  }
})()`)
console.log(`      layout: ${JSON.stringify(layout)}`)
check('file button label', /选择文件/.test(layout.file.text), true)
check('folder button label', /选择文件夹/.test(layout.dir.text), true)
check('both buttons inside the viewport', [layout.file.inViewport, layout.dir.inViewport], [true, true])
check('both buttons are clickable', [layout.file.clickable, layout.dir.clickable], [true, true])
check('buttons sit to the right of the source field', layout.buttonsBesideInput, true)
check('source field stays usable as a fallback', layout.inputEditable, true)

// --- the endpoint really builds the dialog options we ask for ---
const dryRun = async (path, body) =>
  evaluate(`fetch('${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.json())`)

const fileDry = await dryRun('/api/pick-file', {
  dryRun: true,
  title: '选择技能文件',
  defaultPath: existingDir,
  filters: [
    { name: '技能文件', extensions: ['md', 'prompt', 'zip'] },
    { name: '全部文件', extensions: ['*'] },
  ],
})
check('file picker: title kept', fileDry.title, '选择技能文件')
check('file picker: existing start folder kept', fileDry.defaultPath, existingDir)
check('file picker: filters kept', fileDry.filters, [
  { name: '技能文件', extensions: ['md', 'prompt', 'zip'] },
  { name: '全部文件', extensions: ['*'] },
])
check('file picker: nobody bypassed the desktop check', fileDry.parented, false)

const badStart = await dryRun('/api/pick-file', { dryRun: true, defaultPath: join(base, 'no-such-dir') })
check('file picker: non-existent start folder dropped', badStart.defaultPath, '')
check('file picker: default title kept for "打开文件"', badStart.title, '打开文件')
check(
  'file picker: default source filters kept',
  badStart.filters.map((entry) => entry.name),
  ['源文件', '全部文件'],
)

const emptyFilter = await dryRun('/api/pick-file', { dryRun: true, filters: [{ name: '空', extensions: [] }, { name: '点号', extensions: ['.md'] }] })
check('file picker: empty filter list dropped', emptyFilter.filters, [{ name: '点号', extensions: ['md'] }])

const projectDry = await dryRun('/api/pick-project', { dryRun: true })
check('project picker: default title', projectDry.title, '打开工程')
check('project picker: default filters', projectDry.filters, [{ name: '工程文件', extensions: ['uvproj', 'uvprojx', 'uv2'] }])

// --- browser mode has no native dialog: the button must say so, not fail silently ---
await evaluate(`document.getElementById('btn-pick-skill-file').click(); true`)
await new Promise((resolve) => setTimeout(resolve, 800))
const fallbackStatus = await evaluate(`document.getElementById('settings-status').textContent`)
check('browser mode: honest fallback message', /当前不是桌面应用模式/.test(fallbackStatus), true)

// --- the picked path is what the install button consumes ---
await evaluate(`(() => {
  document.getElementById('skills-source').value = ${JSON.stringify(skillFile)}
  document.getElementById('btn-install-skill').click()
  return true
})()`)
check('install from the picked path', await until(`/已安装 ${SKILL_NAME}/.test(document.getElementById('settings-status').textContent)`), true)

const listed = await evaluate(`fetch('/api/skills').then((r) => r.json()).then((data) => data.skills.map((skill) => skill.name))`)
check('installed skill listed', listed.includes(SKILL_NAME), true)
check('source field cleared after install', await evaluate(`document.getElementById('skills-source').value`), '')

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) {
  await writeFile('verify/screenshot-skill-picker.png', Buffer.from(shot.data, 'base64'))
  console.log('      screenshot: verify/screenshot-skill-picker.png')
}

await evaluate(`(() => {
  const row = [...document.querySelectorAll('#skills-installed .row')].find((entry) => entry.textContent.includes(${JSON.stringify(SKILL_NAME)}))
  const button = row && [...row.querySelectorAll('button')].find((entry) => entry.textContent.includes('卸载'))
  if (button) button.click()
  return true
})()`)
check('uninstall cleans up', await until(`/已卸载 ${SKILL_NAME}/.test(document.getElementById('settings-status').textContent)`), true)
const after = await evaluate(`fetch('/api/skills').then((r) => r.json()).then((data) => data.skills.map((skill) => skill.name))`)
check('skill gone after uninstall', after.includes(SKILL_NAME), false)

await rm(base, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
socket.close()
browser.kill()
process.exit(failed ? 1 : 0)
