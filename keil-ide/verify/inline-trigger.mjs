#!/usr/bin/env node
/**
 * Decides WHY no ghost text is painted, by separating three trigger paths:
 *
 *   A. model.trigger()      — call the controller's own fetch directly,
 *   B. Input.insertText     — a real (CDP-level) keyboard insertion,
 *   C. editor command       — the programmatic `type` used by earlier tests.
 *
 * If A/B produce ghost texts but C does not, the earlier "it does not work"
 * conclusion was a test artifact, not a product defect.
 *
 * Usage: node verify/inline-trigger.mjs [cdpPort]
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

/** Ghost text count from the controller model + the DOM text, if any. */
const inspect = `(() => {
  const controller = state.editor.getContribution("editor.contrib.inlineCompletionsController")
  const model = controller?.model?.get?.()
  const ghostTexts = model?.ghostTexts?.get?.() ?? []
  const domNode = [...document.querySelectorAll("body *")].find((element) =>
    (element.textContent || "").includes("STATIC") || (element.textContent || "").includes("tick++"))
  return JSON.stringify({
    active: model?._isActive?.get?.(),
    ghostCount: ghostTexts.length,
    firstGhost: ghostTexts[0] ? JSON.stringify(ghostTexts[0]).slice(0, 220) : null,
    dom: domNode ? domNode.tagName + "." + String(domNode.className) + " :: " + domNode.textContent.slice(0, 60) : null,
    debug: window.__inlineDebug,
  })
})()`

const setup = await evaluate(`(() => {
  const editor = state.editor
  window.__trigBackup = editor.getModel()
  window.__trigModel = monaco.editor.createModel("void main(void)\\n{\\n    unsigned int tick = 0;\\n    t\\n}\\n", "c51")
  editor.setModel(window.__trigModel)
  editor.focus()
  editor.setPosition({ lineNumber: 4, column: 6 })
  window.__static = monaco.languages.registerInlineCompletionsProvider("c51", {
    provideInlineCompletions: () => ({ items: [{ insertText: "/*STATIC*/" }] }),
    freeInlineCompletions() {},
  })
  return "ready"
})()`)
console.log('setup:', setup.value ?? setup.error)

// A) the controller's own trigger
console.log(
  'A model.trigger():',
  (
    await evaluate(
      `(async () => {
  const controller = state.editor.getContribution("editor.contrib.inlineCompletionsController")
  await controller.model.get().trigger()
  await new Promise((r) => setTimeout(r, 1200))
  return ${inspect}
})()`,
      true,
    )
  ).value ?? 'failed',
)

// B) a real CDP-level keyboard insertion
console.log('B Input.insertText:', (await send('Input.insertText', { text: 'x' })) ?? 'sent')
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log(
  'B result:',
  (await evaluate(inspect)).value ?? 'failed',
)

// C) the programmatic type command used by the earlier test
await evaluate(`(state.editor.trigger("keyboard", "type", { text: "y" }), "typed")`)
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log(
  'C programmatic type:',
  (await evaluate(inspect)).value ?? 'failed',
)

console.log(
  'cleanup:',
  (
    await evaluate(`(() => {
  window.__static.dispose()
  const editor = state.editor
  editor.setModel(window.__trigBackup)
  if (window.__trigModel && !window.__trigModel.isDisposed()) window.__trigModel.dispose()
  return "restored"
})()`)
  ).value,
)
socket.close()
