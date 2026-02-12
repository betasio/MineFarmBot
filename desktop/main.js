'use strict'

const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

const { loadConfig, validateConfig } = require('../config')

let mainWindow = null
let botProcess = null
let shutdownRequested = false

function resolveGuiUrl () {
  const cfg = validateConfig(loadConfig())
  const host = (cfg.gui && cfg.gui.host) || '127.0.0.1'
  const port = (cfg.gui && cfg.gui.port) || 8787
  const uiHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${uiHost}:${port}`
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#0b111a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function startBotProcess () {
  const botEntry = path.join(__dirname, '..', 'bot.js')
  botProcess = spawn(process.execPath, [botEntry], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  botProcess.stdout.on('data', chunk => {
    process.stdout.write(`[BOT] ${chunk}`)
  })

  botProcess.stderr.on('data', chunk => {
    process.stderr.write(`[BOT:ERR] ${chunk}`)
  })

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

function stopBotProcess () {
  shutdownRequested = true
  if (!botProcess) return
  try {
    botProcess.kill('SIGINT')
  } catch {}
}

app.whenReady().then(async () => {
  shutdownRequested = false
  createWindow()
  startBotProcess()
  await loadGuiWhenReady()
})

app.on('window-all-closed', () => {
  stopBotProcess()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopBotProcess()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
