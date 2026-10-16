#!/usr/bin/env node
/**
 * Proof for the "打开 hex 目录 opens 文档" bug.
 *
 * Node auto-quotes any Windows argument containing a space, so the OLD form
 * `['/select,C:\\…\\C program.hex']` reached Explorer as ONE quoted token
 * ("/select,…") — an unrecognised switch, and Explorer falls back to 文档.
 * The FIX quotes only the path and passes the argv verbatim.
 *
 * This prints the REAL Windows command line for both forms (read back via WMI),
 * so the difference is a fact rather than a claim.
 *
 * Usage: node verify/argv-probe.mjs        (then read the pids with WMI)
 */
import { spawn } from 'node:child_process'

const target = process.argv[2] ?? 'E:\\单片机\\作业2\\Objects\\C program.hex'
// Long enough that the command line can be read back via WMI while it lives.
const hold = 'setTimeout(() => {}, 30000)'

// OLD: the whole "/select,<path>" token — what the code did before the fix.
const oldForm = spawn(process.execPath, ['-e', hold, `OLD /select,${target}`], { stdio: 'ignore' })
// NEW: switch unquoted, path quoted, argv passed through verbatim.
const quoted = /\s/.test(target) ? `"${target.replace(/\\+$/, '')}"` : target
const newForm = spawn(process.execPath, ['-e', hold, `NEW /select,${quoted}`], {
  stdio: 'ignore',
  windowsVerbatimArguments: true,
})
console.log(JSON.stringify({ target, oldPid: oldForm.pid, newPid: newForm.pid }))
