/**
 * Electron shell for 8051 Studio — one window, no browser chrome.
 *
 * The Node HTTP host (`server.mjs`) runs inside this same process; the window
 * only points at it. Every compiler-specific step still lives in
 * `../keil-core.mjs`, so the shell stays replaceable (this file is the entire
 * desktop layer).
 *
 * Run:  node_modules\electron\dist\electron.exe .      (or: pnpm start)
 * Dev:  pnpm dev        ->  plain browser at http://127.0.0.1:4870/
 */
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.KEIL_IDE_PORT ?? 4870)
process.env.KEIL_IDE_PORT = String(PORT)
const URL_BASE = `http://127.0.0.1:${PORT}/`

// Only ONE Fixpoint may run at a time. Two of them fight over the HTTP port and the
// second one used to die with a raw "Uncaught Exception: listen EADDRINUSE" dialog.
// The lock must be taken BEFORE the host is imported, otherwise the server would
// already have tried to bind the port.
if (!app.requestSingleInstanceLock()) {
  process.exit(0)
}
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

// Windows draws the NATIVE title bar from the app's theme preference. Without
// this the frame stays light while the page is dark — the page screenshot never
// showed it, but the user sees a white bar above a dark window.
nativeTheme.themeSource = 'dark'

// A packaged app lives inside a read-only asar archive, so the settings file must
// go to the user's data folder instead. This has to happen BEFORE the host module
// is imported, because the host resolves the path once at load time.
if (app.isPackaged) {
  process.env.KEIL_IDE_SETTINGS = join(app.getPath('userData'), 'settings.json')
}

// Start the HTTP host in this process (top-level await so the window never races it).
await import('./server.mjs')

/** Wait until the host answers, so the window never shows a connection error. */
async function waitForHost(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`${URL_BASE}api/health`)
      if (response.ok) return true
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Create the single application window. */
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1b1d21',
    title: 'Fixpoint · Powered by wangcangxing',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.loadURL(URL_BASE)
  // Anything the page tries to open in a new window goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

app.whenReady().then(async () => {
  const ready = await waitForHost()
  if (!ready) {
    process.stderr.write(`8051 Studio: host did not answer on ${URL_BASE}\n`)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
