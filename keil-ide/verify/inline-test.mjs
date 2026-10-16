#!/usr/bin/env node
/**
 * End-to-end test of inline (ghost text) completion in the RUNNING app.
 *
 * It answers the only questions that matter for this feature: does typing make
 * gray text appear, where exactly does it live in the DOM, and does a real Tab
 * key (not just the command) commit it?
 *
 *   1. reload the page so the current app.js is in effect,
 *   2. swap in a throwaway C51 model (the user's buffer is never touched),
 *   3. type one character so Monaco asks the provider for a completion,
 *   4. find the ghost text by CONTENT (class names are internal) and describe it,
 *   5. press a real Tab key over CDP, then fall back to the commit command,
 *   6. restore the original model and dispose the scratch one.
 *
 * Usage: node verify/inline-test.mjs [cdpPort]
 */
const port = process.argv[2] ?? '9222'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target; targets =', JSON.stringify(targets))
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
  if (result?.exceptionDetails) return { error: result.exceptionDetails.exception?.description ?? 'evaluate failed' }
  return { value: result?.result?.value }
}

// 1) fresh page
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 6000))

const chat = await evaluate('JSON.stringify({model: state.ai?.model, inline: state.ai?.inline, project: state.settings?.project})')
console.log('app state:', chat.value ?? chat.error)

// 2) scratch model + one typed character
const setup = await evaluate(`(() => {
  const editor = state.editor
  window.__inlineBackup = editor.getModel()
  window.__inlineScratch = monaco.editor.createModel("void main(void)\\n{\\n    unsigned int tick = 0;\\n    t\\n}\\n", "c51")
  editor.setModel(window.__inlineScratch)
  editor.focus()
  editor.setPosition({ lineNumber: 4, column: 6 })
  editor.trigger("keyboard", "type", { text: "i" })
  return "typed at " + JSON.stringify(editor.getPosition())
})()`)
console.log('setup:', setup.value ?? setup.error)

// 3) find the ghost text by CONTENT: class names are internal, the text is not.
//    Note: Monaco tokenizes ghost text into several spans, so match containers too
//    (a leaf-only search misses it).
const findGhost = `(() => {
  const withText = []
  for (const element of document.querySelectorAll("body *")) {
    const text = element.textContent || ""
    if (text.includes("mock FIM") || text.includes("tick++")) {
      withText.push({ tag: element.tagName, cls: String(element.className), kids: element.children.length, txt: text.slice(0, 60) })
    }
  }
  const classNames = [...new Set([...document.querySelectorAll("body *")].map((e) => String(e.className)).filter((c) => /ghost|inline|completion|ced|suggest/i.test(c)))]
  return JSON.stringify({
    withText: withText.slice(-6),
    classNames: classNames.slice(0, 12),
    zones: [...document.querySelectorAll(".view-zones > *, .view-overlays > *")].map((e) => String(e.className)).slice(0, 8),
    debug: window.__inlineDebug,
  }, null, 1)
})()`

const ghost = await evaluate(
  `(async () => {
     const started = Date.now()
     while (Date.now() - started < 9000) {
       const probe = ${findGhost}
       if (JSON.parse(probe).withText.length) return probe
       await new Promise((r) => setTimeout(r, 150))
     }
     return ${findGhost}
   })()`,
  true,
)
console.log('ghost text:', ghost.value ?? ghost.error)

// Keep a picture of the feature actually working (ghost text is visual).
if (!String(ghost.value ?? '').includes('"withText": []')) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (shot?.data) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile('verify/screenshot-inline.png', Buffer.from(shot.data, 'base64'))
    console.log('screenshot: verify/screenshot-inline.png')
  }
}

const before = await evaluate('window.__inlineScratch.getValue()')

// 4a) a REAL Tab key press
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
await new Promise((resolve) => setTimeout(resolve, 500))
const afterTab = await evaluate('window.__inlineScratch.getValue()')
console.log(`tab committed: ${before.value !== afterTab.value}`)

// 4b) fall back to the command, to separate rendering from the keybinding
let afterCommand = afterTab
if (before.value === afterTab.value) {
  await evaluate(`(state.editor.trigger("keyboard", "editor.action.inlineSuggest.commit", {}), "command sent")`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  afterCommand = await evaluate('window.__inlineScratch.getValue()')
  console.log(`command committed: ${before.value !== afterCommand.value}`)
}

const finalText = before.value === afterCommand.value ? afterTab.value : afterCommand.value
if (before.value !== finalText) {
  console.log('--- model after commit ---')
  console.log(finalText)
}

// 5) clean up: reload the page instead of model-swapping, so a previously
//    damaged editor state (a disposed backup model) can never leak into the app.
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 4000))
const cleanup = await evaluate('JSON.stringify({ model: state.current?.name ?? null, lines: state.editor?.getModel()?.getLineCount() ?? 0 })')
console.log('cleanup (page reloaded):', cleanup.value ?? cleanup.error)

socket.close()
