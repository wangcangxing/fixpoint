#!/usr/bin/env node
/**
 * Branding + border audit of the running page.
 *
 * Reads what the user actually sees: the document title, the brand/credit text,
 * every visible line that still mentions a vendor/product string, and the
 * computed border colours of the structural boxes (they must be black).
 *
 * Usage: node verify/brand-check.mjs [cdpPort]
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

await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 6000))

const audit = await evaluate(`(() => {
  // Only borders that actually have width: a 0px border reports the element's text
  // colour, which made the first version of this audit look wrong.
  const border = (selector) => {
    const node = document.querySelector(selector)
    if (!node) return null
    const style = getComputedStyle(node)
    const sides = [
      ['top', style.borderTopWidth, style.borderTopColor],
      ['right', style.borderRightWidth, style.borderRightColor],
      ['bottom', style.borderBottomWidth, style.borderBottomColor],
      ['left', style.borderLeftWidth, style.borderLeftColor],
    ]
    return sides
      .filter(([, width]) => parseFloat(width) > 0)
      .map(([side, width, color]) => side + '=' + color)
      .join(' ')
  }
  // Every visible line still containing a vendor/product string.
  const forbidden = /keil|µvision|uvision|\\bc51\\b|uv4/i
  const hits = document.body.innerText
    .split('\\n')
    .map((line) => line.trim())
    .filter((line) => line && forbidden.test(line))
    .slice(0, 8)
  return JSON.stringify({
    title: document.title,
    brand: document.querySelector('.brand')?.textContent?.trim() ?? null,
    credit: document.querySelector('.credit')?.textContent?.trim() ?? null,
    // The credit must always read in full; chips may truncate, it may not.
    creditTruncated: (() => {
      const node = document.querySelector('.credit')
      return node ? node.scrollWidth > node.clientWidth + 1 : null
    })(),
    toolbarRows: (() => {
      const node = document.querySelector('.toolbar')
      return node ? Math.round(node.getBoundingClientRect().height) : null
    })(),
    truncatedChips: [...document.querySelectorAll('.toolbar .chip')]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => node.textContent.slice(0, 16)),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    vendorHits: hits,
    htmlLangTitleTag: document.querySelector('title')?.textContent ?? null,
    borders: {
      toolbar: border('.toolbar'),
      filesPane: border('.pane.files'),
      paneTitle: border('.pane-title'),
      chatPane: border('.pane.chat'),
      chip: border('.chip'),
      input: border('input[type="text"]'),
      button: border('.toolbar > button'),
      problems: border('footer.pane.problems'),
      accentChipOk: border('.chip.ok'),
    },
  }, null, 1)
})()`)
console.log(audit.value ?? audit.error)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot?.data) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile('verify/screenshot-brand.png', Buffer.from(shot.data, 'base64'))
  console.log('screenshot: verify/screenshot-brand.png')
}
socket.close()
