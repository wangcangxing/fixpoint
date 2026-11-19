#!/usr/bin/env node
/**
 * Unit tests for ../../keil-flash.mjs — all fake processes and fake objects.
 * No python, no stcgal, no COM port, no hardware, no network.
 *
 * The cancel path is covered WITHOUT spawning a real taskkill.exe because
 * startStcgalFlash() takes an injectable `spawnImpl` used for BOTH the stcgal
 * child and the taskkill helper (this was fixed after a test author noticed
 * the first draft bypassed the injection point).
 *
 * Usage: node verify/flash-unit.mjs
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STCGAL_BAUDS,
  STCGAL_PROTOCOLS,
  discoverStcgal,
  parseStcgalLine,
  startStcgalFlash,
} from '../../keil-flash.mjs'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`}`)
}

console.log('--- 1) 常量 ---')
check('协议含 auto / stc89 / stc8', ['auto', 'stc89', 'stc8'].every((value) => STCGAL_PROTOCOLS.includes(value)), true)
check('波特率含 115200', STCGAL_BAUDS.includes(115200), true)

console.log('--- 2) discoverStcgal 候选顺序与判定 ---')
const configured = 'C:\\fake\\configured-python.exe'
const fakeRun = (argv) => {
  if (argv[0] === 'where.exe') return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' })
  if (argv[0] === configured) {
    return Promise.resolve({ exitCode: 0, stdout: 'stcgal 1.10 - an STC MCU ISP flash tool\n', stderr: '' })
  }
  return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'No module named stcgal' })
}
const found = await discoverStcgal(fakeRun, configured)
check('configured 优先命中', [found.python, found.source, found.stcgal], [configured, 'config', '1.10'])

// A second candidate must be a real file: discoverStcgal uses stat() before probing.
const base = await mkdtemp(join(tmpdir(), 'keil-flash-unit-'))
const secondPython = join(base, 'python.exe')
await writeFile(secondPython, 'not really python\n')
const fallbackRun = (argv) => {
  // The module discovers PATH pythons via `where.exe`; hand it our fake path.
  if (argv[0] === 'where.exe') return Promise.resolve({ exitCode: 0, stdout: `${secondPython}\n`, stderr: '' })
  if (argv[0] === secondPython) return Promise.resolve({ exitCode: 0, stdout: 'stcgal 1.10\n', stderr: '' })
  return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'No module named stcgal' })
}
const fallback = await discoverStcgal(fallbackRun, 'C:\\does-not-exist\\python.exe')
check('configured 失败后回退到真实存在的候选', fallback.python, secondPython)
check('回退来源不是 config 而是 known-root / path:*', /^(known-root|path:)/.test(fallback.source), true)
check('tried 记录了两个候选', fallback.tried.length >= 2, true)

const missing = await discoverStcgal(
  () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'No module named stcgal' }),
  'C:\\does-not-exist\\python.exe',
)
check('全失败时 python 为空、error 非空', [missing.python === '', missing.error.length > 0], [true, true])
// KEIL_PYTHON is included in PYTHON_FALLBACKS by code inspection; not exercised here
// because module-level constants are captured at import time (honest coverage note).

console.log('--- 3) parseStcgalLine 全事件表 ---')
check('握手 done → 进度 10', parseStcgalLine('Waiting for MCU, please cycle power: done'), {
  kind: 'progress', percent: 10, detail: '握手成功', status: '已握手，正在读取芯片信息…',
})
check('等待冷启动 → status', parseStcgalLine('Waiting for MCU, please cycle power:').kind, 'status')
check('擦除完成 → 进度 25', parseStcgalLine('Erasing flash: done').percent, 25)
check('写入 50% → 映射 58', parseStcgalLine('Writing 8192 bytes:  50% [====]').percent, 58)
check('设置选项 → 进度 95', parseStcgalLine('Setting options: done').percent, 95)
check('芯片型号 → log', parseStcgalLine('Target model:  STC8H8K64U').kind, 'log')
check('空白行 → null', parseStcgalLine('   '), null)

console.log('--- 4) startStcgalFlash（假 spawnImpl）---')
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  return child
}

let captured = []
const sent = []
const child1 = fakeChild()
const spawn1 = (file, argv) => {
  captured.push([file, argv])
  return file === 'taskkill.exe' ? new EventEmitter() : child1
}
const task1 = startStcgalFlash({
  python: 'C:\\Python312\\python.exe',
  port: 'COM7',
  filePath: 'C:\\fw\\led.hex',
  baud: 9600,
  protocol: 'stc8',
  autoreset: true,
  send: (event) => sent.push(event),
  spawnImpl: spawn1,
})
check(
  '参数拼装（含 -a）',
  captured[0][1],
  ['-m', 'stcgal', '-P', 'stc8', '-p', 'COM7', '-b', '9600', '-a', 'C:\\fw\\led.hex'],
)
// A progress line split across two chunks must produce exactly ONE event.
child1.stdout.emit('data', Buffer.from('Erasing flash: '))
child1.stdout.emit('data', Buffer.from('done\n'))
check('跨 chunk 行缓冲只发一次进度 25', sent.filter((event) => event.kind === 'progress' && event.percent === 25).length, 1)
child1.emit('close', 0)
check('退出码 0 → success', await task1.done, { success: true, exitCode: 0 })

captured = []
const child2 = fakeChild()
const task2 = startStcgalFlash({
  python: 'x', port: 'COM7', filePath: 'fw.hex', protocol: 'arm',
  send: () => {},
  spawnImpl: (file, argv) => { captured.push([file, argv]); return file === 'taskkill.exe' ? new EventEmitter() : child2 },
})
check('非法协议回落 auto', captured[0][1].slice(0, 4), ['-m', 'stcgal', '-P', 'auto'])
child2.emit('close', 2)
const failedResult = await task2.done
check('退出码非 0 → 失败且含提示', [failedResult.success, failedResult.exitCode, /退出码 2/.test(failedResult.error)], [false, 2, true])

const child3 = fakeChild()
const task3 = startStcgalFlash({
  python: 'x', port: 'COM7', filePath: 'fw.hex', send: () => {},
  spawnImpl: (file) => (file === 'taskkill.exe' ? new EventEmitter() : child3),
})
child3.emit('error', new Error('ENOENT'))
const spawnError = await task3.done
check('spawn error → 无法启动 stcgal', [spawnError.success, /无法启动 stcgal/.test(spawnError.error)], [false, true])

// cancel(): taskkill.exe must go through the SAME injected spawner — no real process.
let killed = null
const child4 = fakeChild()
const task4 = startStcgalFlash({
  python: 'x', port: 'COM7', filePath: 'fw.hex', send: () => {},
  spawnImpl: (file, argv) => {
    if (file === 'taskkill.exe') { killed = argv; const helper = new EventEmitter(); return helper }
    return child4
  },
})
task4.cancel()
check('cancel 通过注入的 spawnImpl 调 taskkill /T', killed, ['/F', '/T', '/PID', '4242'])
child4.emit('close', 0)
check('取消后 close(0) → cancelled', await task4.done, { success: false, cancelled: true })

await rm(base, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
