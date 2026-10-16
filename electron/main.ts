/**
 * Electron main process: the app window (electron/renderer) and a tray icon.
 * The page reaches the F1–F9 services only through `window.ofa` (preload)
 * and the typed IPC contract in src/app/contract.ts.
 *
 *   offline-field-assistant                       the app
 *   offline-field-assistant --ipc-smoke [--fixtures DIR] [--out FILE] [--require-model-pack]
 *                                                 run the IPC smoke suite in the hidden window, then exit
 *   offline-field-assistant ofa <command> …       any ofa command (doctor, models install, …), then exit
 *
 * Everything the app keeps lives in OFA_HOME, by default
 * ~/Library/Application Support/OfflineFieldAssistant (models/, packs/,
 * license/, logs/). The log key is kept with safeStorage, in OFA_HOME.
 *
 * Bundled to build/main.mjs by scripts/build-electron.ts.
 */
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, nativeTheme, safeStorage, session as electronSession } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_EVENT, IPC_INVOKE } from '../src/app/contract.js'
import { createDispatcher } from '../src/app/dispatch.js'
import { isDevelopmentBuild } from '../src/app/release-policy.js'
import { AppServices } from '../src/app/services.js'
import { readFixtures, rendererScript, runSmoke, type SmokeAnswer } from '../src/app/smoke.js'
import { runOfa } from '../src/cli/run.js'
import { APP_HOME, loadConfig } from '../src/core/config.js'
import { createSdkPort, shutdown } from '../src/core/qvac.js'
import { keychainVault, safeStorageVault } from '../src/features/platform/keys.js'
import { TRUSTED_PACK_KEYS } from '../src/features/packs/trusted-keys.js'
import { TRUSTED_LICENSE_KEYS } from '../src/features/platform/license-keys.js'
import { openSession } from '../src/features/platform/session.js'

const here = import.meta.dirname
const args = process.argv.slice(app.isPackaged ? 1 : 2)

// safeStorage keeps its key in the Keychain item "<app name> Safe Storage",
// which only the code identity that made it may read without asking. Dev
// runs use the stock Electron binary: give them an item of their own.
if (!app.isPackaged) app.setName('Offline Field Assistant Dev')

process.env.OFA_HOME ||= APP_HOME
/**
 * The log key: safeStorage, in OFA_HOME. OFA_KEY_STORE=keychain keeps it in a
 * Keychain item of its own instead (OFA_KEYCHAIN_SERVICE), owned by
 * /usr/bin/security: for unattended runs of ad hoc builds, each of which is
 * a new code identity that macOS would ask about.
 */
const vault = () =>
  process.env.OFA_KEY_STORE === 'keychain'
    ? keychainVault({ service: loadConfig().keychainService })
    : safeStorageVault({ safeStorage, file: path.join(process.env.OFA_HOME!, 'log-key.bin') })

// Commands and the smoke suite run without a Dock icon; the app shows one with its window.
if (args[0] === 'ofa' || args.includes('--ipc-smoke')) app.dock?.hide()
// Nothing in this app talks to the network; keep Chromium from trying either.
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-domain-reliability')
app.commandLine.appendSwitch('no-pings')

function option(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<number | undefined> {
  if (args[0] === 'ofa') {
    await app.whenReady()
    return runOfa(args.slice(1), { vault: vault() })
  }
  const smoke = args.includes('--ipc-smoke')
  if (!smoke && !app.requestSingleInstanceLock()) return 0
  await app.whenReady()

  const config = loadConfig()
  const session = await openSession(config, { vault: vault(), onLogError: (err) => console.error(`⚠ Activity log: ${err.message}`) })
  const services = new AppServices({ config, session, sdk: createSdkPort() })
  const dispatch = createDispatcher(services, session)
  const page = path.join(here, 'renderer', 'index.html')
  const pageUrl = pathToFileURL(page).href
  lockDown(pageUrl)

  ipcMain.handle(IPC_INVOKE, async (event, channel: unknown, request: unknown, callId: unknown) => {
    // Only our own page may call, never a frame it might embed.
    if (event.senderFrame?.url !== pageUrl || event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, error: { code: 'bad-request', message: 'Calls are accepted only from the app page' } }
    }
    const id = typeof callId === 'string' ? callId.slice(0, 100) : undefined
    return dispatch(channel, request, { ...(id ? { callId: id } : {}), emit: (e) => event.sender.send(IPC_EVENT, e) })
  })

  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Offline Field Assistant',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // The page's own background, so the window never flashes white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d181d' : '#e9eff1',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const pageErrors: string[] = []
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') pageErrors.push(e.message)
  })
  await win.loadFile(page)

  const quit = async () => {
    await services.close().catch(() => undefined)
    await shutdown().catch(() => undefined)
  }

  if (smoke) {
    const fixtures = await readFixtures(path.resolve(option('--fixtures') ?? path.join(app.getAppPath(), 'tests/fixtures')))
    const ui = await pageCheck(win, pageErrors)
    const report = await runSmoke(
      async (call) => JSON.parse(await win.webContents.executeJavaScript(rendererScript(call))) as SmokeAnswer,
      fixtures,
      { requireModelPack: args.includes('--require-model-pack') },
      (s) => console.error(`${s.ok ? '✓' : '✗'} ${s.name.padEnd(36)} ${(s.ms / 1000).toFixed(1).padStart(5)} s${s.problem ? `  ${s.problem}` : ''}`)
    )
    report.steps.unshift(ui)
    if (ui.ok) report.passed++
    else report.failed++
    report.ok &&= ui.ok
    const out = option('--out')
    const json = JSON.stringify({ electron: process.versions.electron, packaged: app.isPackaged, home: process.env.OFA_HOME, ...report }, null, 2)
    if (out) await fs.writeFile(out, json + '\n')
    console.error(`\n${report.passed}/${report.passed + report.failed} smoke steps passed in ${(report.totalMs / 1000).toFixed(1)} s`)
    await quit()
    return report.ok ? 0 : 1
  }

  // Closing the window keeps the app (and its loaded models) running; the
  // Dock icon or the tray brings it back, and Quit ends it.
  let quitting = false
  const showWindow = () => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })
  app.on('activate', showWindow)
  app.on('second-instance', showWindow)
  // ⌘Q or the app menu's Quit: close the models first, as the tray's Quit does.
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    void quit().then(() => app.exit(0))
  })
  showWindow()

  const status = await dispatch('app.status', {})
  const tray = new Tray(trayIcon())
  tray.setToolTip('Offline Field Assistant')
  const lines: string[] = [`Offline Field Assistant ${app.getVersion()}`]
  if (isDevelopmentBuild([...TRUSTED_PACK_KEYS, ...TRUSTED_LICENSE_KEYS])) lines.push('Development build: not for release')
  if (status.ok) {
    const s = status.value as { license: { message: string }; models: { models: { status: string }[] } }
    lines.push(s.license.message, s.models.models.every((m) => m.status === 'ok') ? 'Models installed' : 'Models missing: install the model pack')
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Offline Field Assistant', click: showWindow },
      { type: 'separator' },
      ...lines.map((label) => ({ label, enabled: false })),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          void quit().then(() => app.exit(0))
        }
      }
    ])
  )
  app.on('window-all-closed', () => undefined)
  return undefined
}

/** The smoke suite's first step: the page itself started, with its six sections and no errors. */
async function pageCheck(win: BrowserWindow, errors: string[]) {
  const t0 = performance.now()
  const sections = (await win.webContents.executeJavaScript(`document.querySelectorAll('#app .section').length`)) as number
  const problem = sections !== 6 ? `${sections} sections on the page, expected 6` : errors.length ? `page error: ${errors[0]}` : undefined
  const ui = { name: 'page shows its six sections', channel: 'page', ok: !problem, ms: performance.now() - t0, ...(problem ? { problem } : {}) }
  console.error(`${ui.ok ? '✓' : '✗'} ${ui.name.padEnd(36)} ${(ui.ms / 1000).toFixed(1).padStart(5)} s${problem ? `  ${problem}` : ''}`)
  return ui
}

/**
 * The page may load nothing but its own files. The one permission it may
 * have is the microphone and camera (push-to-talk, photographing a page),
 * and only the app's own page may ask; macOS still asks the person once.
 */
function lockDown(pageUrl: string) {
  const s = electronSession.defaultSession
  s.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://') && !details.url.startsWith('blob:') })
  )
  s.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = permission === 'media' && 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    callback(permission === 'media' && wc.getURL() === pageUrl && media.length > 0 && media.every((t) => t === 'audio' || t === 'video'))
  })
  s.setPermissionCheckHandler((wc, permission) => permission === 'media' && wc?.getURL() === pageUrl)
}

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(here, 'trayTemplate.png'))
  icon.setTemplateImage(true)
  return icon
}

main()
  .then((code) => {
    if (code !== undefined) app.exit(code)
  })
  .catch((err) => {
    console.error('✖', err)
    app.exit(1)
  })
