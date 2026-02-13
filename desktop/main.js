'use strict'

const { app, BrowserWindow, dialog, Tray, Menu, nativeImage, ipcMain, shell } = require('electron')
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')

const { DEFAULT_CONFIG, validateConfig } = require('../config')

let mainWindow = null
let botProcess = null
let tray = null
let shutdownRequested = false
let forceQuit = false
let currentProfileId = null

const statePath = path.join(app.getPath('userData'), 'window-state.json')
const profilesDir = path.join(app.getPath('userData'), 'profiles')
const iconPath = path.join(__dirname, 'assets', 'icon.svg')
const launcherPath = path.join(__dirname, 'launcher.html')

function ensureProfilesDir () {
  fs.mkdirSync(profilesDir, { recursive: true })
}

function profileDir (profileId) {
  return path.join(profilesDir, profileId)
}

function profileConfigPath (profileId) {
  return path.join(profileDir(profileId), 'config.json')
}

function profileCheckpointPath (profileId) {
  return path.join(profileDir(profileId), 'build-checkpoint.json')
}

function profileMetaPath (profileId) {
  return path.join(profileDir(profileId), 'profile.json')
}

function slugify (value) {
  return String(value || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot'
}

function readProfileMeta (profileId) {
  const metaFile = profileMetaPath(profileId)
  if (!fs.existsSync(metaFile)) return null
  try {
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  } catch {
    return null
  }
}

function listProfiles () {
  ensureProfilesDir()
  const entries = fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const id = entry.name
      const meta = readProfileMeta(id) || { id, name: id, auth: 'microsoft', createdAt: Date.now(), updatedAt: Date.now() }
      const checkpointFile = profileCheckpointPath(id)
      let checkpoint = null
      if (fs.existsSync(checkpointFile)) {
        try {
          checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
        } catch {}
      }
      return {
        id,
        name: meta.name,
        auth: meta.auth,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        host: meta.host,
        username: meta.username,
        checkpoint
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return entries
}

function createProfile (payload) {
  const now = Date.now()
  const profileName = String(payload && payload.name ? payload.name : '').trim()
  if (!profileName) throw new Error('Profile name is required')

  const idBase = slugify(profileName)
  const id = `${idBase}-${now.toString(36)}`
  const dir = profileDir(id)
  fs.mkdirSync(dir, { recursive: true })

  const auth = String(payload && payload.auth ? payload.auth : 'microsoft').toLowerCase() === 'offline' ? 'offline' : 'microsoft'
  const identity = String(payload && payload.identity ? payload.identity : '').trim()
  if (!identity) throw new Error(auth === 'offline' ? 'Offline username is required' : 'Microsoft email is required')

  const host = String(payload && payload.host ? payload.host : '').trim()
  if (!host) throw new Error('Server host is required')

  const base = validateConfig(DEFAULT_CONFIG)
  const config = validateConfig({
    ...base,
    auth,
    username: identity,
    host,
    port: Number(payload && payload.port ? payload.port : base.port),
    gui: {
      ...base.gui,
      host: '127.0.0.1',
      port: Number(payload && payload.guiPort ? payload.guiPort : base.gui.port)
    }
  })

  fs.writeFileSync(profileConfigPath(id), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  fs.writeFileSync(profileMetaPath(id), JSON.stringify({
    id,
    name: profileName,
    auth,
    host: config.host,
    username: config.username,
    createdAt: now,
    updatedAt: now
  }, null, 2), 'utf8')

  return { id, name: profileName }
}


function removeProfileDir (targetDir) {
  if (!fs.existsSync(targetDir)) return
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const full = path.join(targetDir, entry.name)
    if (entry.isDirectory()) removeProfileDir(full)
    else {
      try { fs.unlinkSync(full) } catch {}
    }
  }
  try { fs.rmdirSync(targetDir) } catch {}
}

function deleteProfile (profileId) {
  if (!profileId) throw new Error('Profile id is required')
  const dir = profileDir(profileId)
  if (!fs.existsSync(dir)) throw new Error('Profile not found')

  if (currentProfileId === profileId) {
    stopBotProcess()
    currentProfileId = null
  }

  removeProfileDir(dir)
  return { ok: true }
}

function resolveGuiUrlFromProfile (profileId) {
  const config = validateConfig(JSON.parse(fs.readFileSync(profileConfigPath(profileId), 'utf8')))
  const host = (config.gui && config.gui.host) || '127.0.0.1'
  const port = (config.gui && config.gui.port) || 8787
  const uiHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${uiHost}:${port}`
}

function parseMsaPrompt (text) {
  const codeMatch = text.match(/use the code\s+([A-Z0-9]+)/i)
  const urlMatch = text.match(/https?:\/\/[^\s]+/i)
  const url = urlMatch ? urlMatch[0] : null
  const isMicrosoftLink = Boolean(url && /microsoft\.com\/link|login\.live\.com|microsoftonline\.com/i.test(url))
  if (!codeMatch && !isMicrosoftLink) return null
  return {
    code: codeMatch ? codeMatch[1] : null,
    url: isMicrosoftLink ? url : 'https://www.microsoft.com/link'
  }
}

function startBotProcess (profileId) {
  const botEntry = path.join(__dirname, '..', 'bot.js')
  const cfgPath = profileConfigPath(profileId)
  const checkpointPath = profileCheckpointPath(profileId)

  botProcess = spawn(process.execPath, [botEntry], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MINEFARMBOT_DESKTOP: '1',
      BOT_CONFIG_PATH: cfgPath,
      BOT_CHECKPOINT_PATH: checkpointPath
    }
  })

  const onOutput = (prefix, chunk) => {
    const text = chunk.toString()
    process.stdout.write(`${prefix}${text}`)

    const msa = parseMsaPrompt(text)
    if (msa && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:msa-code', msa)
      shell.openExternal(msa.url).catch(() => {})
    }
  }

  botProcess.stdout.on('data', chunk => onOutput('[BOT] ', chunk))
  botProcess.stderr.on('data', chunk => onOutput('[BOT:ERR] ', chunk))

  botProcess.on('exit', (code, signal) => {
    const crashed = !shutdownRequested
    botProcess = null

    if (crashed) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      dialog.showErrorBox('MineFarmBot stopped unexpectedly', `Bot process terminated with ${reason}.`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        loadLauncher().catch(() => {})
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
  if (!currentProfileId) throw new Error('No active profile to restart')
  stopBotProcess()
  await new Promise(resolve => setTimeout(resolve, 1200))
  shutdownRequested = false
  startBotProcess(currentProfileId)
  await loadGuiWhenReady(currentProfileId)
  return { ok: true }
}

async function launchProfile (profileId) {
  if (!profileId) throw new Error('Profile id is required')
  if (!fs.existsSync(profileConfigPath(profileId))) throw new Error('Profile config not found')

  currentProfileId = profileId
  stopBotProcess()
  await new Promise(resolve => setTimeout(resolve, 1000))

  shutdownRequested = false
  startBotProcess(profileId)
  await loadGuiWhenReady(profileId)

  const meta = readProfileMeta(profileId)
  if (meta) {
    meta.updatedAt = Date.now()
    fs.writeFileSync(profileMetaPath(profileId), JSON.stringify(meta, null, 2), 'utf8')
  }

  return { ok: true }
}

async function loadGuiWhenReady (profileId) {
  const url = resolveGuiUrlFromProfile(profileId)
  const deadline = Date.now() + 90000

  while (Date.now() < deadline) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      await probeGui(url)
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 350))
    }
  }

  if (!mainWindow || mainWindow.isDestroyed()) return

  try {
    await mainWindow.loadURL(url)
    return
  } catch {}

  dialog.showErrorBox('GUI failed to load', `Could not connect to ${url} within timeout. Ensure bot GUI transport is enabled.`)
}

function probeGui (baseUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/status`, { timeout: 1000 }, (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
        res.resume()
        resolve()
        return
      }
      res.resume()
      reject(new Error(`status ${res.statusCode || 'unknown'}`))
    })

    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function loadLauncher () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  await mainWindow.loadFile(launcherPath)
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
  tray = new Tray(getAppIcon())
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
      click: () => restartBotProcess().catch(err => dialog.showErrorBox('Restart failed', err.message || String(err)))
    },
    {
      label: 'Back to Bot Launcher',
      click: () => {
        stopBotProcess()
        currentProfileId = null
        loadLauncher().catch(() => {})
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

ipcMain.handle('desktop:list-profiles', async () => ({ ok: true, profiles: listProfiles() }))
ipcMain.handle('desktop:create-profile', async (_event, payload) => {
  try {
    const created = createProfile(payload || {})
    return { ok: true, profile: created, profiles: listProfiles() }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})
ipcMain.handle('desktop:launch-profile', async (_event, profileId) => {
  try {
    await launchProfile(profileId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})
ipcMain.handle('desktop:delete-profile', async (_event, profileId) => {
  try {
    deleteProfile(profileId)
    if (!currentProfileId && mainWindow && !mainWindow.isDestroyed()) await loadLauncher()
    return { ok: true, profiles: listProfiles() }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})
ipcMain.handle('desktop:restart-bot', async () => {
  try {
    await restartBotProcess()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})
ipcMain.handle('desktop:stop-bot', async () => {
  stopBotProcess()
  currentProfileId = null
  await loadLauncher()
  return { ok: true }
})

app.whenReady().then(async () => {
  shutdownRequested = false
  forceQuit = false
  ensureProfilesDir()
  createWindow()
  createTray()
  await loadLauncher()
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
