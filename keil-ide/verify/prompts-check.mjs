#!/usr/bin/env node
/**
 * Preset-prompt checks, including the FALLBACK semantics the user specified:
 * the bundled presets are used ONLY when the user configured none, or when their
 * file is unreadable — never alongside the user's own presets.
 *
 * Also re-checks the "新建文件" regression: the ask dialog must really become
 * visible (the earlier duplicate id made it appear on the chat textarea instead).
 *
 * Usage: node verify/prompts-check.mjs <demoProject> [cdpPort]
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const [demoProject, port = '9222'] = process.argv.slice(2)
if (!demoProject) {
  console.error('usage: node verify/prompts-check.mjs <demoProject> [cdpPort]')
  process.exit(1)
}
const demoDir = dirname(demoProject)
const projectPrompts = join(demoDir, '.keil-ide', 'prompts.json')

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}
const api = async (path, init) => {
  const response = await fetch(`http://127.0.0.1:4870${path}`, init)
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
// NOTE: this already prefixes `project=` — do NOT wrap it in another `project=` when
// building a URL (that produced "?project=project=D%3A…" and the server then looked
// for a project named "project=D:\…", so the project layer was never found).
const q = (project) => encodeURIComponent(project)

await rm(projectPrompts, { force: true }).catch(() => {})
await rm(join(demoDir, '.keil-ide'), { recursive: true, force: true }).catch(() => {})

console.log('--- 1) 用户没配置 → 用内置兜底 ---')
const bundled = await api(`/api/prompts?project=${q(demoProject)}`)
check('走内置', bundled.body.usedBundled, true)
check('内置有预设', bundled.body.prompts.length > 0, true)
check('兜底原因说明是"还没配置"', /还没有配置/.test(bundled.body.bundledReason ?? ''), true)

console.log('--- 2) 用户/工程配置了 → 内置完全不参与 ---')
await mkdir(dirname(projectPrompts), { recursive: true })
await writeFile(
  projectPrompts,
  JSON.stringify(
    {
      presets: [
        { name: '解释这份代码', description: '被工程层覆盖的那条', text: '工程层版本：只讲重点。' },
        { name: '工程专用：查外设配置', description: '只有这个工程有', text: '检查 TMOD/SCON/TCON 的配置是否自相矛盾。' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)
const mine = await api(`/api/prompts?project=${q(demoProject)}`)
check('不用内置了', mine.body.usedBundled, false)
check('条数 = 我的 2 条（内置一条都不混进来）', mine.body.prompts.length, 2)
check('同名被工程层覆盖', mine.body.prompts.find((entry) => entry.name === '解释这份代码').text, '工程层版本：只讲重点。')
check('工程专属也进来了', mine.body.prompts.some((entry) => entry.name === '工程专用：查外设配置'), true)
check('来源标成 project', mine.body.prompts.every((entry) => entry.from === 'project'), true)

console.log('--- 3) 用户文件损坏 → 回退内置并报错 ---')
await writeFile(projectPrompts, '{ 这不是 JSON', 'utf8')
const broken = await api(`/api/prompts?project=${q(demoProject)}`)
check('损坏时回退内置', broken.body.usedBundled, true)
check('兜底原因说明是"读不出来"', /读不出来/.test(broken.body.bundledReason ?? ''), true)
check('problems 里有解析错误', (broken.body.problems ?? []).length > 0, true)

console.log('--- 4) 保存接口的校验与写入 ---')
const bad = await post('/api/prompts/save', { which: 'project', project: demoProject, text: '{ 坏 JSON' })
check('坏 JSON → 400', bad.status, 400)
const noArray = await post('/api/prompts/save', { which: 'project', project: demoProject, text: '{"presets":{}}' })
check('presets 不是数组 → 400', noArray.status, 400)
const missingField = await post('/api/prompts/save', {
  which: 'project',
  project: demoProject,
  text: '{"presets":[{"name":"x"}]}',
})
check('缺 text → 400', missingField.status, 400)
const good = await post('/api/prompts/save', {
  which: 'project',
  project: demoProject,
  text: JSON.stringify({ presets: [{ name: '保存测试', description: '', text: '你好' }] }),
})
check('合法内容 → 200', good.status, 200)
check('写入了 1 条', good.body.count, 1)
const source = await api(`/api/prompts/source?which=project&project=${q(demoProject)}`)
check('source 接口能读回原文', /保存测试/.test(source.body.text), true)
check('source 报出真实路径', source.body.path.endsWith('.keil-ide\\prompts.json'), true)

console.log('--- 5) 界面：下拉能填进输入框（CDP）---')
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const send = (method, params) =>
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
const evaluate = async (expression, awaitPromise = true) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result?.exceptionDetails) return { error: result.exceptionDetails.exception?.description ?? 'failed' }
  return { value: result?.result?.value }
}
await send('Page.enable')
await post('/api/settings', { project: demoProject })
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 7000))

const dropdown = await evaluate(`(async () => {
  const select = document.getElementById('preset')
  const names = [...select.options].map((o) => o.value).filter(Boolean)
  select.value = names[0]
  select.dispatchEvent(new Event('change'))
  return JSON.stringify({ names, filled: document.getElementById('prompt').value.slice(0, 20) })
})()`)
const preset = JSON.parse(dropdown.value ?? '{}')
check('下拉里是工程层的预设', preset.names, ['保存测试'])
check('选中后填进了聊天输入框', preset.filled, '你好')

const askDialog = await evaluate(`(async () => {
  document.getElementById('btn-new-file').click()
  await new Promise((r) => setTimeout(r, 600))
  const modal = document.getElementById('ask-modal')
  const textarea = document.getElementById('prompt')
  const style = getComputedStyle(modal)
  return JSON.stringify({
    modalDisplay: style.display,
    modalVisibleBox: modal.getBoundingClientRect().height > 40,
    inputFocused: document.activeElement?.id ?? '',
    textareaDisplay: getComputedStyle(textarea).display,
  })
})()`)
const ask = JSON.parse(askDialog.value ?? '{}')
check('输入弹窗真的显示出来了（这次是 #ask-modal）', ask.modalDisplay !== 'none' && ask.modalVisibleBox, true)
check('聊天输入框没有被误隐藏', ask.textareaDisplay !== 'none', true)
check('焦点在弹窗输入框里', ask.inputFocused, 'prompt-input')
await evaluate(`(document.getElementById('btn-prompt-close').click(), 'closed')`)

const settingsTab = await evaluate(`(async () => {
  document.getElementById('btn-settings').click()
  await new Promise((r) => setTimeout(r, 1000))
  document.querySelector('.settings-tabs .tab[data-tab="presets"]').click()
  await new Promise((r) => setTimeout(r, 700))
  const json = document.getElementById('presets-json').value
  return JSON.stringify({
    tab: document.querySelector('.pane-tab.active')?.dataset.pane ?? '',
    jsonHasPreset: /保存测试/.test(json),
    info: document.getElementById('presets-info').textContent.split('\\n')[0],
  })
})()`)
const tab = JSON.parse(settingsTab.value ?? '{}')
check('设置里有"预设提示词"页签', tab.tab, 'presets')
check('编辑器载入的是 user 层（默认编辑层）', tab.jsonHasPreset, false)
check('面板说明了当前用的是谁的预设', /你自己的预设/.test(tab.info), true)
await evaluate(`(document.getElementById('btn-settings-close').click(), 'closed')`)

await rm(join(demoDir, '.keil-ide'), { recursive: true, force: true }).catch(() => {})
await post('/api/settings', { project: 'E:\\单片机\\作业2\\C program.uvproj' })
console.log(`\n已清理 ${join(demoDir, '.keil-ide')}，工程切回用户的`)
console.log(failed ? `${failed} 项失败` : '全部通过')
socket.close()
process.exit(failed ? 1 : 0)
