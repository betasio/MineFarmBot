'use strict'

const { app, BrowserWindow, dialog, Tray, Menu, nativeImage, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const { loadConfig, validateConfig } = require('../config')

let mainWindow = null
let botProcess = null
let tray = null
let shutdownRequested = false
let forceQuit = false

const statePath = path.join(app.getPath('userData'), 'window-state.json')
const iconPath = path.join(__dirname, 'assets', 'icon.svg')

function resolveGuiUrl () {
  const cfg = validateConfig(loadConfig())
  const host = (cfg.gui && cfg.gui.host) || '127.0.0.1'
  const port = (cfg.gui && cfg.gui.port) || 8787
  const uiHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${uiHost}:${port}`
}

function loadWindowState () {
  try {
    if (!fs.existsSync(statePath)) return null
    const raw = fs.readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null
    return {
      width: Math.max(1000, Math.floor(parsed.width)),
      height: Math.max(680, Math.floor(parsed.height)),
      x: Number.isFinite(parsed.x) ? Math.floor(parsed.x) : undefined,
      y: Number.isFinite(parsed.y) ? Math.floor(parsed.y) : undefined
    }
  } catch {
    return null
  }
}

function saveWindowState () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(bounds, null, 2), 'utf8')
  } catch {}
}

function getAppIcon () {
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath)
  return nativeImage.createEmpty()
}

function createTray () {
  const trayIcon = getAppIcon()
  tray = new Tray(trayIcon)
  tray.setToolTip('MineFarmBot')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show MineFarmBot',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    {
      label: 'Restart Bot Process',
      click: () => {
        restartBotProcess().catch(err => {
          dialog.showErrorBox('Restart failed', err.message || String(err))
        })
      }
    },
    {
      label: 'Exit',
      click: () => {
        forceQuit = true
        app.quit()
      }
    }
  ]))

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) mainWindow.hide()
      else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

function createWindow () {
  const saved = loadWindowState() || {}
  mainWindow = new BrowserWindow({
    width: saved.width || 1480,
    height: saved.height || 920,
    x: saved.x,
    y: saved.y,
    minWidth: 1080,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#0b111a',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  mainWindow.on('resize', saveWindowState)
  mainWindow.on('move', saveWindowState)
  mainWindow.on('minimize', event => {
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('close', event => {
    if (forceQuit) return
    event.preventDefault()
    saveWindowState()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function startBotProcess () {
  const botEntry = path.join(__dirname, '..', 'bot.js')
  botProcess = spawn(process.execPath, [botEntry], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
  })

  botProcess.stdout.on('data', chunk => process.stdout.write(`[BOT] ${chunk}`))
  botProcess.stderr.on('data', chunk => process.stderr.write(`[BOT:ERR] ${chunk}`))

  botProcess.on('exit', (code, signal) => {
    const crashed = !shutdownRequested
    botProcess = null

    if (crashed) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      dialog.showErrorBox('MineFarmBot stopped unexpectedly', `Bot process terminated with ${reason}.`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(
          "document.body.innerHTML = '<div style=\"font-family:sans-serif;padding:20px;color:#fff;background:#1a2230\"><h2>Bot stopped unexpectedly</h2><p>Check terminal logs for details and restart the app.</p></div>'"
        ).catch(() => {})
      }
    }
  })
}

function stopBotProcess () {
  shutdownRequested = true
  if (!botProcess) return
  try {
    botProcess.kill('SIGINT')
  } catch {}
}

async function restartBotProcess () {
  stopBotProcess()
  await new Promise(resolve => setTimeout(resolve, 1200))
  shutdownRequested = false
  startBotProcess()
  await loadGuiWhenReady()
  return { ok: true }
}

async function loadGuiWhenReady () {
  const url = resolveGuiUrl()
  const deadline = Date.now() + 30000

  while (Date.now() < deadline) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      await mainWindow.loadURL(url)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  dialog.showErrorBox('GUI failed to load', `Could not connect to ${url} within timeout. Ensure bot GUI transport is enabled.`)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

ipcMain.handle('desktop:restart-bot', async () => {
  try {
    await restartBotProcess()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

app.whenReady().then(async () => {
  shutdownRequested = false
  forceQuit = false
  createWindow()
  createTray()
  startBotProcess()
  await loadGuiWhenReady()
})

app.on('before-quit', () => {
  forceQuit = true
  saveWindowState()
  stopBotProcess()
  if (tray) tray.destroy()
})

app.on('window-all-closed', event => {
  event.preventDefault()
})

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
})
