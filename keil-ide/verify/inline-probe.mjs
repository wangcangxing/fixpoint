#!/usr/bin/env node
/**
 * Mechanism probe for Monaco inline (ghost text) completions.
 *
 * The provider is being called and returns items, yet nothing is painted. This
 * script isolates the cause with three comparisons inside the live editor:
 *
 *   A. what the controller actually holds (`getContribution` internals),
 *   B. a STATIC synchronous provider vs my ASYNC provider (timing?),
 *   C. automatic typing vs the EXPLICIT `inlineSuggest.trigger` command.
 *
 * Everything runs on a scratch model; the user's buffer is never touched.
 *
 * Usage: node verify/inline-probe.mjs [cdpPort]
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
// Background pages are throttled and some UI (view zones, ghost text) is skipped;
// this makes the renderer believe it is focused even when the window is behind.
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 6000))

console.log(
  'visibility:',
  (
    await evaluate(`JSON.stringify({
  visibilityState: document.visibilityState,
  hasFocus: document.hasFocus(),
  hidden: document.hidden,
})`)
  ).value,
)

// Scratch model + a static synchronous provider, registered up front.
console.log(
  'setup:',
  (
    await evaluate(`(() => {
  const editor = state.editor
  window.__probeBackup = editor.getModel()
  window.__probeModel = monaco.editor.createModel("void main(void)\\n{\\n    unsigned int tick = 0;\\n    t\\n}\\n", "c51")
  editor.setModel(window.__probeModel)
  editor.focus()
  window.__static = monaco.languages.registerInlineCompletionsProvider("c51", {
    provideInlineCompletions: () => ({ items: [{ insertText: "/*STATIC*/" }] }),
    freeInlineCompletions() {},
  })
  return "scratch model + static provider ready"
})()`)
  ).value,
)

/** Type one char, then wait and report whether any ghost text showed up. */
const typeAndLook = async (label, char) => {
  const result = await evaluate(
    `(async () => {
       const editor = state.editor
       editor.setPosition({ lineNumber: 4, column: editor.getModel().getLineMaxColumn(4) })
       editor.trigger("keyboard", "type", { text: ${JSON.stringify(char)} })
       const started = Date.now()
       let found = ""
       while (Date.now() - started < 6000) {
         const node = [...document.querySelectorAll("body *")].find((element) =>
           (element.textContent || "").includes("STATIC") || (element.textContent || "").includes("tick++"))
         if (node) { found = element_class(node); break }
         await new Promise((r) => setTimeout(r, 120))
       }
       function element_class(node) { return node.tagName + "." + String(node.className) + " :: " + node.textContent.slice(0, 60) }
       return JSON.stringify({ found, waitedMs: Date.now() - started, debug: window.__inlineDebug })
     })()`,
    true,
  )
  console.log(`${label}:`, result.value ?? result.error)
}

// B1: automatic typing (both providers answer: static + my async one)
await typeAndLook('B1 automatic typing', 'x')

// A: what does the controller hold now? (observables need .get())
console.log(
  'A controller:',
  (
    await evaluate(`(() => {
  const controller = state.editor.getContribution("editor.contrib.inlineCompletionsController")
  if (!controller) return "no controller contribution"
  const read = (observable) => {
    try {
      const value = observable && observable.get ? observable.get() : observable
      if (Array.isArray(value)) return "array[" + value.length + "]"
      if (value === null) return "null"
      if (value === undefined) return "undefined"
      return typeof value === "object" ? "object:" + Object.keys(value).slice(0, 8).join(",") : String(value)
    } catch (error) { return "err:" + error.message }
  }
  const model = controller.model && controller.model.get ? controller.model.get() : controller.model
  return JSON.stringify({
    enabled: read(controller._enabled),
    enabledInConfig: read(controller._enabledInConfig),
    debounce: read(controller._debounceValue),
    modelPresent: Boolean(model),
    ghostTexts: read(controller._ghostTexts),
    stabilized: read(controller._stablizedGhostTexts),
    widgets: read(controller._ghostTextWidgets),
    modelKeys: model ? Object.keys(model).slice(0, 12) : null,
    modelState: model && model.state ? Object.keys(model.state) : null,
  }, null, 1)
})()`)
  ).value,
)

// C: explicit trigger command
console.log(
  'C explicit trigger:',
  (
    await evaluate(
      `(async () => {
  const editor = state.editor
  editor.setPosition({ lineNumber: 4, column: editor.getModel().getLineMaxColumn(4) })
  editor.trigger("keyboard", "editor.action.inlineSuggest.trigger", {})
  const started = Date.now()
  let found = ""
  while (Date.now() - started < 6000) {
    const node = [...document.querySelectorAll("body *")].find((element) => (element.textContent || "").includes("STATIC"))
    if (node) { found = node.tagName + "." + String(node.className) + " :: " + node.textContent.slice(0, 60); break }
    await new Promise((r) => setTimeout(r, 120))
  }
  return JSON.stringify({ found, waitedMs: Date.now() - started, debug: window.__inlineDebug })
})()`,
      true,
    )
  ).value,
)

// cleanup
console.log(
  'cleanup:',
  (
    await evaluate(`(() => {
  window.__static.dispose()
  const editor = state.editor
  editor.setModel(window.__probeBackup)
  if (window.__probeModel && !window.__probeModel.isDisposed()) window.__probeModel.dispose()
  return "restored: " + (editor.getModel() === window.__probeBackup)
})()`)
  ).value,
)
socket.close()
