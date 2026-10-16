#!/usr/bin/env node
/**
 * Layout probe: resize the real window to several sizes, measure the key boxes,
 * and capture a screenshot per size. Reports horizontal/vertical overflow so
 * "the inside does not adapt" becomes a number instead of an opinion.
 *
 * Usage: node verify/layout-check.mjs [cdpPort] [--settings]
 */
const port = process.argv[2] ?? '9222'
const withSettings = process.argv.includes('--settings')
const sizes = [
  [1440, 920],
  [1200, 760],
  [1024, 660],
  [900, 600],
  [800, 520],
]

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

const { writeFile } = await import('node:fs/promises')
const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.id })
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 6000))
if (withSettings) {
  await evaluate(`(document.getElementById('btn-settings').click(), 'opened')`, true)
  await new Promise((resolve) => setTimeout(resolve, 1200))
}

for (const [width, height] of sizes) {
  // The real window may refuse bounds changes (maximized / managed by the OS), so
  // the CSS viewport is overridden instead — that is what layout depends on.
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const probe = await evaluate(`(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const box = node.getBoundingClientRect()
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), right: Math.round(box.right), bottom: Math.round(box.bottom) }
    }
    const box = (node) => node.getBoundingClientRect()
    // Overflow outside the viewport, ignoring Monaco's virtualised internals
    // (their coordinates are intentionally huge).
    const overflowers = [...document.querySelectorAll('body *')]
      .filter((node) => !node.closest('.monaco-editor') && !node.closest('.scrollbar'))
      .filter((node) => {
        const r = box(node)
        return r.width > 0 && r.height > 0 && (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1)
      })
      .slice(0, 6)
      .map((node) => node.tagName.toLowerCase() + '.' + String(node.className).split(' ')[0] + ' right=' + Math.round(box(node).right) + ' bottom=' + Math.round(box(node).bottom))
    const toolbar = document.querySelector('.toolbar')
    const settingsButton = document.getElementById('btn-settings')
    const buttonBox = settingsButton ? box(settingsButton) : null
    return JSON.stringify({
      viewport: [window.innerWidth, window.innerHeight],
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      verticalOverflow: document.documentElement.scrollHeight > window.innerHeight,
      toolbarWrap: toolbar ? { h: Math.round(box(toolbar).height), scrollW: toolbar.scrollWidth, clientW: toolbar.clientWidth } : null,
      settingsButton: buttonBox ? { right: Math.round(buttonBox.right), visible: buttonBox.right <= window.innerWidth + 1 && buttonBox.bottom <= window.innerHeight + 1 } : null,
      panes: [...document.querySelectorAll('main > *')].map((node) => Math.round(box(node).width)),
      modal: rect('#settings .modal-box'),
      modalFooterVisible: (() => {
        const row = document.querySelector('.modal-box > .modal-row')
        if (!row || !document.querySelector('#settings:not(.hidden)')) return 'n/a'
        const r = box(row)
        return r.bottom <= window.innerHeight + 1
      })(),
      tabsDirection: (() => {
        const tabs = document.querySelector('.settings-tabs')
        return tabs ? getComputedStyle(tabs).flexDirection : 'n/a'
      })(),
      overflowers,
    }, null, 1)
  })()`)
  console.log(`\n=== viewport ${width}x${height} ===`)
  console.log(probe.value ?? probe.error)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (shot?.data) {
    const name = `verify/layout-${width}x${height}${withSettings ? '-settings' : ''}.png`
    await writeFile(name, Buffer.from(shot.data, 'base64'))
    console.log(`screenshot: ${name}`)
  }
}
await send('Emulation.clearDeviceMetricsOverride')
socket.close()
