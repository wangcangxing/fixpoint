#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol probe for the keil-ide window.
 *
 * Reloads the page, collects console messages and uncaught exceptions, then
 * evaluates a few expressions so UI failures can be diagnosed from evidence
 * instead of guessed. Node 24 ships a global WebSocket, so there is no dependency.
 *
 * Usage:
 *   # start the app with:  electron . --remote-debugging-port=9222
 *   node verify/cdp-probe.mjs [port] ["expression" ...]
 */
const port = process.argv[2] ?? '9222'
const extraExpressions = process.argv.slice(3)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target found; targets =', JSON.stringify(targets, null, 2))
  process.exit(1)
}
console.log(`page: ${page.title}  ${page.url}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const events = []

/** Send one CDP command and await its reply. */
function send(method, params) {
  return new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')
    events.push(`[console.${message.params.type}] ${text}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    events.push(`[exception] ${details.text} ${details.exception?.description ?? ''}`.trim())
  }
  if (message.method === 'Log.entryAdded') {
    events.push(`[log.${message.params.entry.level}] ${message.params.entry.text}`)
  }
})

await new Promise((resolve) => socket.addEventListener('open', resolve))
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 4500))

const expressions = [
  'typeof require',
  'typeof monaco',
  'document.getElementById("editor").getBoundingClientRect().width',
  'JSON.stringify({body:document.body.scrollWidth, win:window.innerWidth, main:document.querySelector("main").scrollWidth})',
  'document.querySelectorAll(".msg").length',
  'Array.from(document.querySelectorAll(".msg")).map(m=>m.textContent.slice(0,240)).join(" || ")',
  'document.getElementById("ai-chip").textContent',
  'JSON.stringify(Array.from(document.querySelectorAll("main > *")).map(e=>e.className+":"+Math.round(e.getBoundingClientRect().width)))',
  'document.querySelectorAll(".files li").length',
  'document.getElementById("hex-chip").textContent',
  'document.querySelectorAll(".monaco-editor").length',
  'document.querySelector(".view-lines") ? document.querySelector(".view-lines").textContent.slice(0,120) : "(no view-lines)"',
  'state.editor ? "editor ok" : "no editor"',
  // Project tree structure, as depth:label pairs (depth from the row's indent).
  'JSON.stringify([...document.querySelectorAll("#tree .node-row")].map((row) => (Number(String(row.style.paddingLeft).replace("px",""))/14) + ":" + (row.querySelector(".node-label")?.textContent ?? "?")))',
  // Click the header node: proves the read allow-list reaches Keil\'s INC dir.
  '(async () => { const rows=[...document.querySelectorAll("#tree .node-row")]; const target=rows.find((row)=>row.querySelector(".node-label")?.textContent.includes("reg51.h")); if(!target) return "no reg51.h node"; target.click(); await new Promise(r=>setTimeout(r,1200)); return "opened=" + (state.current?.path ?? "(none)") + " line1=" + (state.editor.getModel().getLineContent(1).slice(0,36)); })()',
  // Prefix completion (SFRs): a throwaway model + ONE triggerSuggest call.
  // Triggering twice toggles the widget closed, so typing first would hide it.
  '(async () => { const e = state.editor; const original = e.getModel(); const model = monaco.editor.createModel("void main(void) {\\n  T\\n}\\n", "c51"); e.setModel(model); e.setPosition({lineNumber:2, column:4}); e.trigger("keyboard","editor.action.triggerSuggest",{}); await new Promise(r=>setTimeout(r,1800)); const rows=[...document.querySelectorAll(".suggest-widget .monaco-list-row")].map(r=>r.textContent.replace(/\\s+/g," ").trim()).slice(0,12); e.setModel(original); model.dispose(); return "prefix[T] rows="+rows.length+" ["+rows.join(" | ")+"]"; })()',
  // Member completion: swap in the sandbox project's index (which has a struct).
  '(async () => { const e = state.editor; const original = e.getModel(); const saved = state.symbols; state.symbols = await (await fetch("/api/symbols?project="+encodeURIComponent("D:\\\\program\\\\keil-ai-loop\\\\demo\\\\led.uvproj"))).json(); const model = monaco.editor.createModel("struct LedConfig { unsigned char mode; unsigned int period; };\\nstruct LedConfig cfg;\\nvoid main(void) {\\n  cfg.\\n}\\n","c51"); e.setModel(model); e.setPosition({lineNumber:4, column:7}); e.trigger("keyboard","editor.action.triggerSuggest",{}); await new Promise(r=>setTimeout(r,1600)); const rows=[...document.querySelectorAll(".suggest-widget .monaco-list-row")].map(r=>r.textContent.replace(/\\s+/g," ").trim()).slice(0,8); e.setModel(original); model.dispose(); state.symbols = saved; return "member rows="+rows.length+" ["+rows.join(" | ")+"]"; })()',
  'document.getElementById("symbol-chip").textContent',
  // Word-based fallback: same throwaway-model approach, so nothing is toggled.
  '(async () => { const e = state.editor; const original = e.getModel(); const model = monaco.editor.createModel("void main(void) {\\n  P\\n}\\n", "c51"); e.setModel(model); e.setPosition({lineNumber:2, column:4}); e.trigger("keyboard","editor.action.triggerSuggest",{}); await new Promise(r=>setTimeout(r,1800)); const rows=[...document.querySelectorAll(".suggest-widget .monaco-list-row")].map(r=>r.textContent.replace(/\\s+/g," ").trim()).slice(0,12); e.setModel(original); model.dispose(); return "prefix[P] rows="+rows.length+" ["+rows.join(" | ")+"]"; })()',
  'state.ai ? "ai=" + state.ai.mode : "ai unset"',
  ...extraExpressions,
]

for (const expression of expressions) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  const value = result?.result?.value
  console.log(`\n> ${expression.slice(0, 110)}\n  ${typeof value === 'undefined' ? JSON.stringify(result) : JSON.stringify(value)}`)
}

console.log('\n--- console / log events ---')
console.log(events.length ? events.join('\n') : '(none)')
socket.close()
