#!/usr/bin/env node
/**
 * Which InlineCompletion shape does this Monaco build actually accept?
 *
 *   V1  { insertText }                                  — no range (rejected?)
 *   V2  { insertText, range: empty range at the cursor } — insert, replace nothing
 *   V3  { insertText: word + text, range: over the word } — the "prefix" rule
 *
 * Usage: node verify/inline-range.mjs [cdpPort]
 */
const port = process.argv[2] ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target')
  process.exit(1)
}
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
const evaluate = async (expression, awaitPromise = false) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result?.exceptionDetails) return { error: result.exceptionDetails.exception?.description ?? 'failed' }
  return { value: result?.result?.value }
}

await send('Page.bringToFront')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 6000))

await evaluate(`(() => {
  window.__rangeBackup = state.editor.getModel()
  window.__marker = 0
  window.__register = (shape) => {
    if (window.__provider) window.__provider.dispose()
    window.__provider = monaco.languages.registerInlineCompletionsProvider("c51", {
      provideInlineCompletions: (model, position) => {
        const word = model.getWordAtPosition(position)
        if (shape === 1) return { items: [{ insertText: "/*V1*/" }] }
        if (shape === 2) return { items: [{ insertText: " /*V2*/", range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }
        const startColumn = word ? word.startColumn : position.column
        return { items: [{ insertText: (word ? word.word : "") + " /*V3*/", range: new monaco.Range(position.lineNumber, startColumn, position.lineNumber, position.column) }] }
      },
      freeInlineCompletions() {},
    })
  }
  return "helper ready"
})()`)

const inspect = `(() => {
  const controller = state.editor.getContribution("editor.contrib.inlineCompletionsController")
  const model = controller?.model?.get?.()
  const ghosts = model?.ghostTexts?.get?.() ?? []
  const marker = "/*V" + window.__marker + "*/"
  const domNode = [...document.querySelectorAll("body *")].find((element) => (element.textContent || "").includes(marker))
  return JSON.stringify({
    marker,
    ghostCount: ghosts.length,
    dom: domNode ? String(domNode.className) + " :: " + domNode.textContent.slice(0, 50) : null,
    domAnyV: [...document.querySelectorAll("body *")].map((e) => (e.textContent || "").match(/\\/\\*V[123]\\*\\//)?.[0]).filter(Boolean).slice(0, 3),
  })
})()`

for (const shape of [1, 2, 3]) {
  await evaluate(`(() => {
    window.__marker = ${shape}
    window.__register(${shape})
    const editor = state.editor
    if (window.__scratch && !window.__scratch.isDisposed()) window.__scratch.dispose()
    window.__scratch = monaco.editor.createModel("void main(void)\\n{\\n    tick\\n}\\n", "c51")
    editor.setModel(window.__scratch)
    editor.focus()
    editor.setPosition({ lineNumber: 3, column: 9 })
    return "shape ${shape} ready"
  })()`)
  await send('Input.insertText', { text: 'z' })
  await new Promise((resolve) => setTimeout(resolve, 1800))
  console.log(`V${shape}:`, (await evaluate(inspect)).value)
}

console.log(
  'cleanup:',
  (
    await evaluate(`(() => {
  if (window.__provider) window.__provider.dispose()
  const editor = state.editor
  editor.setModel(window.__rangeBackup)
  if (window.__scratch && !window.__scratch.isDisposed()) window.__scratch.dispose()
  return "restored"
})()`)
  ).value,
)
socket.close()
