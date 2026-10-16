#!/usr/bin/env node
/**
 * Multi-project workspace (`.uvmpw`) acceptance:
 *   1. create a workspace with two generated projects
 *   2. parse it back (members, device, batch flag)
 *   3. the app's "build all" produces a hex per member
 *   4. add / remove / duplicate handling
 *   5. one-click "participate in batch build" patches SelectedForBatchBuild
 *   6. DECISIVE: the REAL µVision (`UV4 -b <workspace>`) batch-builds it — that is
 *      what proves the generated XML matches µVision's schema in practice
 *   7. the UI lists the members and switching one switches the project
 *
 * Usage: node verify/workspace-check.mjs [cdpPort]
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

const port = process.argv[2] ?? '9222'
const root = 'D:\\program\\keil-ai-loop'
const demo = join(root, 'demo')
const dir = join(root, 'demo', 'ws-check')
const uv4 = 'E:\\qrs\\software\\UV4\\UV4.exe'

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
const exists = (p) => stat(p).then(() => true).catch(() => false)

await rm(dir, { recursive: true, force: true }).catch(() => {})
await post('/api/settings', { workspace: '' })

console.log('--- 0) 造两个可编译工程（拷 demo，改输出名）---')
const members = []
for (const name of ['alpha', 'beta']) {
  const projectDir = join(dir, name)
  await mkdir(projectDir, { recursive: true })
  await cp(join(demo, 'main.c'), join(projectDir, 'main.c'))
  await cp(join(demo, 'STARTUP.A51'), join(projectDir, 'STARTUP.A51'))
  const xml = (await readFile(join(demo, 'led.uvproj'), 'utf8')).replace('<OutputName>led</OutputName>', `<OutputName>${name}</OutputName>`)
  const project = join(projectDir, `${name}.uvproj`)
  await writeFile(project, xml, 'utf8')
  members.push(project)
}
check('两个工程已就绪', await Promise.all(members.map(exists)), [true, true])

console.log('--- 1) 新建工作区 ---')
const created = await post('/api/workspace/new', { dir, name: 'ws-check', projects: members })
check('新建成功', created.status, 200)
const workspaceFile = created.body.workspace
check('写出的文件是 .uvmpw', workspaceFile.endsWith('ws-check.uvmpw'), true)
const xml = await readFile(workspaceFile, 'utf8')
check('用了 schema 里的小写 <project>', /<project>/.test(xml), true)
check('带 NodeIsCheckedInBatchBuild', /<NodeIsCheckedInBatchBuild>1<\/NodeIsCheckedInBatchBuild>/.test(xml), true)
check('带 WorkspaceName', /<WorkspaceName>ws-check<\/WorkspaceName>/.test(xml), true)

console.log('--- 2) 解析回来 ---')
const read = await api(`/api/workspace?file=${encodeURIComponent(workspaceFile)}`)
check('两个成员', read.body.projects.length, 2)
check('成员名来自工程输出名', read.body.projects.map((entry) => entry.name).sort(), ['alpha', 'beta'])
check('器件读到了', read.body.projects.every((entry) => entry.device === 'AT89C51'), true)
check('文件都存在', read.body.projects.every((entry) => entry.exists), true)

console.log('--- 3) 一键参与批量编译（改前备份 .uvproj）---')
// Both members carry SelectedForBatchBuild=0 here (they are copies of the demo
// project), so the one-click fix must touch BOTH.
for (const member of members) {
  const text = await readFile(member, 'utf8')
  await writeFile(member, text.replace(/<SelectedForBatchBuild>1<\/SelectedForBatchBuild>/, '<SelectedForBatchBuild>0</SelectedForBatchBuild>'), 'utf8')
}
const allow = await post('/api/workspace/allow-batch', { file: workspaceFile })
check('改了两个工程', allow.body.count, 2)
check('改后标记为参与', (await api(`/api/workspace?file=${encodeURIComponent(workspaceFile)}`)).body.projects.every((entry) => entry.selectedForBatchBuild), true)
check('备份已生成', await exists(join(dirname(members[0]), '.backups')), true)

console.log('--- 4) 全部编译（应用自己按顺序编译）---')
const built = await post('/api/workspace/build', { file: workspaceFile })
check('两个都成功', built.body.results.map((entry) => entry.status), ['ok', 'ok'])
check('各自出了 hex', built.body.results.map((entry) => entry.hex?.exists), [true, true])
check('没有失败计数', built.body.failed, 0)

console.log('--- 5) 成员的增删与重复 ---')
check('重复加入 → 409', (await post('/api/workspace/add', { file: workspaceFile, project: members[0] })).status, 409)
const gammaDir = join(dir, 'gamma')
await mkdir(gammaDir, { recursive: true })
await cp(join(demo, 'main.c'), join(gammaDir, 'main.c'))
await cp(join(demo, 'STARTUP.A51'), join(gammaDir, 'STARTUP.A51'))
await writeFile(join(gammaDir, 'gamma.uvproj'), (await readFile(join(demo, 'led.uvproj'), 'utf8')).replace('<OutputName>led</OutputName>', '<OutputName>gamma</OutputName>'), 'utf8')
check('加入第三个 → ok', (await post('/api/workspace/add', { file: workspaceFile, project: join(gammaDir, 'gamma.uvproj') })).status, 200)
check('现在是 3 个成员', (await api(`/api/workspace?file=${encodeURIComponent(workspaceFile)}`)).body.projects.length, 3)
check('移出第三个 → ok', (await post('/api/workspace/remove', { file: workspaceFile, project: join(gammaDir, 'gamma.uvproj') })).status, 200)
check('又回到 2 个', (await api(`/api/workspace?file=${encodeURIComponent(workspaceFile)}`)).body.projects.length, 2)
check('移出不存在的 → 404', (await post('/api/workspace/remove', { file: workspaceFile, project: join(gammaDir, 'gamma.uvproj') })).status, 404)

console.log('--- 6) 决定性：让真 µVision 批量编译这个工作区 ---')
await rm(join(dir, 'alpha', 'Objects'), { recursive: true, force: true }).catch(() => {})
await rm(join(dir, 'beta', 'Objects'), { recursive: true, force: true }).catch(() => {})
const log = join(dir, 'uv4-batch.log')
const exitCode = await new Promise((resolve) => {
  const child = spawn(uv4, ['-b', workspaceFile, '-j0', '-o', log], { stdio: 'ignore' })
  child.on('exit', resolve)
  child.on('error', () => resolve(-1))
})
check('UV4 退出码 0（接受这个工作区）', exitCode, 0)
const logText = await readFile(log, 'utf8').catch(() => '')
check('批量编译汇总为 2 succeeded', /2 succeeded, 0 failed, 0 skipped/.test(logText), true)
check('alpha 的 hex 生成了', await exists(join(dir, 'alpha', 'Objects', 'alpha.hex')), true)
check('beta 的 hex 生成了', await exists(join(dir, 'beta', 'Objects', 'beta.hex')), true)

console.log('--- 7) 界面：成员列表与切换 ---')
await post('/api/settings', { workspace: workspaceFile })
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
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 7000))
const ui = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll('#workspace-list .row')]
  const names = rows.map((row) => row.querySelector('.name')?.textContent?.trim()).filter(Boolean)
  const memberRows = rows.filter((row) => row.querySelector('.name'))
  memberRows[1]?.click()
  await new Promise((r) => setTimeout(r, 2500))
  return JSON.stringify({
    visible: !document.getElementById('workspace-list').classList.contains('hidden'),
    names,
    select: document.getElementById('workspace').value,
    switchedTo: state.settings.project,
  })
})()`)
const state = JSON.parse(ui.value ?? '{}')
check('成员列表可见', state.visible, true)
check('列出了两个成员', (state.names ?? []).filter((name) => !name.startsWith('+')).length, 2)
check('下拉里是工作区路径', /ws-check\.uvmpw$/.test(state.select ?? ''), true)
check('点第二个成员切换了工程', /beta\.uvproj$/.test(state.switchedTo ?? ''), true)

await post('/api/settings', { workspace: '', project: 'E:\\单片机\\作业2\\C program.uvproj' })
await rm(dir, { recursive: true, force: true }).catch(() => {})
console.log(`\n已清理测试目录，工作区清空、工程切回用户的`)
console.log(failed ? `${failed} 项失败` : '全部通过')
socket.close()
process.exit(failed ? 1 : 0)
