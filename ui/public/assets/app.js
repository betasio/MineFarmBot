'use strict'

const MAX_LOGS = 1000
const lowThresholdDefaults = { sand: 64, cactus: 64, string: 64, cobblestone: 128 }

const els = {
  toast: document.getElementById('toast'),
  serverMeta: document.getElementById('server-meta'),
  connectionBadge: document.getElementById('connection-badge'),
  pingValue: document.getElementById('ping-value'),
  lagValue: document.getElementById('lag-value'),
  reconnectValue: document.getElementById('reconnect-value'),
  reconnectCountdown: document.getElementById('reconnect-countdown'),
  uptimeValue: document.getElementById('uptime-value'),
  layerValue: document.getElementById('layer-value'),
  cellValue: document.getElementById('cell-value'),
  buildState: document.getElementById('build-state'),
  progressFill: document.getElementById('progress-fill'),
  etaValue: document.getElementById('eta-value'),
  ppmValue: document.getElementById('ppm-value'),
  checkpointValue: document.getElementById('checkpoint-value'),
  coordValue: document.getElementById('coord-value'),
  dimensionValue: document.getElementById('dimension-value'),
  lastActionAge: document.getElementById('last-action-age'),
  logFeed: document.getElementById('log-feed'),
  materialsPanel: document.getElementById('materials-panel'),
  refillTime: document.getElementById('refill-time'),
  refillContainer: document.getElementById('refill-container'),
  refillStatus: document.getElementById('refill-status'),
  errorSound: document.getElementById('error-sound'),
  pauseScrollBtn: document.getElementById('pause-scroll-btn'),
  clearLogBtn: document.getElementById('clear-log-btn'),
  exportLogBtn: document.getElementById('export-log-btn'),
  copyErrorBtn: document.getElementById('copy-error-btn'),
  openConfigBtn: document.getElementById('open-config-btn'),
  configDialog: document.getElementById('config-dialog'),
  closeConfigBtn: document.getElementById('close-config-btn'),
  reloadConfigBtn: document.getElementById('reload-config-btn'),
  configForm: document.getElementById('config-form'),
  configMessage: document.getElementById('config-message'),
  configRequiredAlert: document.getElementById('config-required-alert'),
  restartBotBtn: document.getElementById('restart-bot-btn'),
  authTypeSelect: document.getElementById('auth-type-select'),
  microsoftEmailGroup: document.getElementById('microsoft-email-group'),
  offlineUsernameGroup: document.getElementById('offline-username-group')
}

const state = {
  autoScroll: true,
  statusSnapshot: null,
  logEntries: [],
  lastError: '',
  lastActionAt: null,
  updateTicker: null,
  eventStream: null,
  controlsInFlight: false,
  toastTimer: null,
  configRequiredFields: [],
  missingRequiredFields: []
}

function showToast (message) {
  if (!els.toast) return
  if (state.toastTimer) clearTimeout(state.toastTimer)
  els.toast.textContent = message
  els.toast.classList.add('show')
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('show')
    state.toastTimer = null
  }, 2400)
}


function isDesktopApp () {
  return Boolean(window.minefarmDesktop && window.minefarmDesktop.isDesktop)
}

function formatDuration (ms) {
  if (ms == null || Number.isNaN(ms)) return '--'
  const totalSec = Math.max(Math.floor(ms / 1000), 0)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatTime (ts) {
  if (!ts) return '--'
  return new Date(ts).toLocaleTimeString()
}

function levelOf (entry) {
  const level = String(entry.level || 'info').toLowerCase()
  return ['error', 'warn', 'info'].includes(level) ? level : 'info'
}

function setByPath (obj, path, value) {
  const keys = path.split('.')
  let cursor = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

function getByPath (obj, path) {
  return path.split('.').reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj)
}


function getAuthTypeFromForm () {
  const raw = String((els.authTypeSelect && els.authTypeSelect.value) || 'microsoft').toLowerCase()
  return raw === 'offline' ? 'offline' : 'microsoft'
}

function getAuthRequiredFields () {
  return getAuthTypeFromForm() === 'offline'
    ? ['offlineUsername']
    : ['microsoftEmail']
}

function applyAuthVisibility () {
  const authType = getAuthTypeFromForm()
  els.microsoftEmailGroup.classList.toggle('hidden', authType !== 'microsoft')
  els.offlineUsernameGroup.classList.toggle('hidden', authType !== 'offline')
}

function updateConfigHealthBanner () {
  if (!els.configRequiredAlert) return
  const missing = state.missingRequiredFields
  if (!missing || missing.length === 0) {
    els.configRequiredAlert.hidden = true
    return
  }
  els.configRequiredAlert.hidden = false
  els.configRequiredAlert.textContent = `Setup required: missing ${missing.join(', ')}. Open Setup Wizard before starting.`
}

function updateStartButtonEnabled () {
  const startBtn = document.querySelector('[data-action="start"]')
  if (!startBtn) return
  const missing = state.missingRequiredFields || []
  startBtn.disabled = missing.length > 0 || state.controlsInFlight
}

function validateRequiredInForm () {
  const missing = []
  const requiredFields = [...state.configRequiredFields, ...getAuthRequiredFields()]
  const uniqueFields = [...new Set(requiredFields)]

  for (const field of uniqueFields) {
    const input = els.configForm.querySelector(`[name="${CSS.escape(field)}"]`)
    if (!input) continue
    if (input.closest('.hidden')) {
      input.classList.remove('field-invalid')
      continue
    }
    const value = input.type === 'checkbox' ? input.checked : input.value.trim()
    const invalid = value === '' || value == null
    input.classList.toggle('field-invalid', invalid)
    if (invalid) missing.push(field)
  }
  return missing
}

function markRequiredConfigFields () {
  const requiredSet = new Set([...state.configRequiredFields, ...getAuthRequiredFields()])
  for (const input of els.configForm.querySelectorAll('[name]')) {
    const required = requiredSet.has(input.name)
    input.required = required
    input.parentElement.classList.toggle('required-field', required)
  }
}

function fillConfigForm (cfg) {
  const authType = String(cfg.auth || 'microsoft').toLowerCase() === 'offline' ? 'offline' : 'microsoft'
  if (els.authTypeSelect) els.authTypeSelect.value = authType
  applyAuthVisibility()

  for (const input of els.configForm.querySelectorAll('[name]')) {
    if (input.name === 'microsoftEmail' || input.name === 'offlineUsername') continue
    const value = getByPath(cfg, input.name)
    if (input.type === 'checkbox') input.checked = Boolean(value)
    else input.value = value == null ? '' : String(value)
    input.classList.remove('field-invalid')
  }

  const username = String(cfg.username || '')
  const msInput = els.configForm.querySelector('[name="microsoftEmail"]')
  const offlineInput = els.configForm.querySelector('[name="offlineUsername"]')
  if (msInput) msInput.value = authType === 'microsoft' ? username : ''
  if (offlineInput) offlineInput.value = authType === 'offline' ? username : ''
}

function collectConfigFromForm () {
  const payload = {}
  const authType = getAuthTypeFromForm()

  for (const input of els.configForm.querySelectorAll('[name]')) {
    if (input.name === 'microsoftEmail' || input.name === 'offlineUsername') continue
    let value
    if (input.type === 'checkbox') value = input.checked
    else if (input.type === 'number') value = input.value === '' ? null : Number(input.value)
    else value = input.value.trim()
    if (value === '' || Number.isNaN(value)) continue
    setByPath(payload, input.name, value)
  }

  const usernameValue = authType === 'offline'
    ? (els.configForm.querySelector('[name="offlineUsername"]')?.value || '').trim()
    : (els.configForm.querySelector('[name="microsoftEmail"]')?.value || '').trim()

  if (usernameValue) payload.username = usernameValue
  payload.auth = authType

  return payload
}

async function loadConfigForm () {
  const data = await fetch('/config', { cache: 'no-store' }).then(r => r.json())
  if (!data.ok) throw new Error(data.error || 'Failed to load config')
  state.configRequiredFields = Array.isArray(data.requiredFields) ? data.requiredFields : []
  fillConfigForm(data.config || {})
  markRequiredConfigFields()
  const requiredMissing = validateRequiredInForm()
  state.missingRequiredFields = requiredMissing
  updateConfigHealthBanner()
  updateStartButtonEnabled()
  els.configMessage.textContent = requiredMissing.length > 0
    ? `Missing required fields: ${requiredMissing.join(', ')}`
    : 'Loaded current configuration.'
}

async function saveConfigForm () {
  const missing = validateRequiredInForm()
  if (missing.length > 0) {
    state.missingRequiredFields = missing
    updateConfigHealthBanner()
    updateStartButtonEnabled()
    throw new Error(`Missing required fields: ${missing.join(', ')}`)
  }

  const payload = collectConfigFromForm()
  const result = await fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: payload })
  })
  const body = await result.json().catch(() => ({}))
  if (!result.ok || body.ok === false) {
    if (Array.isArray(body.missingRequiredFields)) {
      state.missingRequiredFields = body.missingRequiredFields
      updateConfigHealthBanner()
      updateStartButtonEnabled()
    }
    throw new Error(body.error || 'Failed to save config')
  }

  state.configRequiredFields = Array.isArray(body.requiredFields) ? body.requiredFields : state.configRequiredFields
  state.missingRequiredFields = Array.isArray(body.missingRequiredFields) ? body.missingRequiredFields : []
  fillConfigForm(body.config || {})
  markRequiredConfigFields()
  state.missingRequiredFields = validateRequiredInForm()
  updateConfigHealthBanner()
  updateStartButtonEnabled()
  els.configMessage.textContent = body.message || 'Saved.'
  showToast('Configuration saved')
}

function setControlButtonsDisabled (disabled) {
  state.controlsInFlight = disabled
  for (const btn of document.querySelectorAll('[data-action]')) {
    if (btn.dataset.action === 'start') continue
    btn.disabled = disabled
  }
  updateStartButtonEnabled()
}

function appendLog (entry) {
  const payload = {
    level: levelOf(entry),
    message: String(entry.message || ''),
    timestamp: entry.timestamp || Date.now()
  }

  state.logEntries.push(payload)
  if (state.logEntries.length > MAX_LOGS) state.logEntries.shift()

  const line = document.createElement('p')
  line.className = `log-line ${payload.level}`
  line.textContent = `[${new Date(payload.timestamp).toLocaleTimeString()}] [${payload.level.toUpperCase()}] ${payload.message}`
  els.logFeed.appendChild(line)
  while (els.logFeed.childElementCount > MAX_LOGS) {
    els.logFeed.removeChild(els.logFeed.firstElementChild)
  }

  if (state.autoScroll) els.logFeed.scrollTop = els.logFeed.scrollHeight
}

function renderMaterials (inventory = {}, refill = {}) {
  const thresholds = refill.thresholds || lowThresholdDefaults
  const keys = ['sand', 'cactus', 'string', 'cobblestone']
  const fragment = document.createDocumentFragment()

  for (const key of keys) {
    const value = Number(inventory[key] || 0)
    const threshold = Number(thresholds[key] || lowThresholdDefaults[key] || 1)
    const fillPct = Math.min((value / Math.max(threshold * 2, 1)) * 100, 100)
    const row = document.createElement('div')
    row.className = 'material-row'
    const isLow = value <= threshold
    row.innerHTML = `<div class="material-head"><span>${key[0].toUpperCase() + key.slice(1)}</span><strong>${value}${isLow ? ' <span class="low">LOW</span>' : ''}</strong></div><div class="material-bar"><div class="material-fill" style="width:${fillPct}%"></div></div>`
    fragment.appendChild(row)
  }

  els.materialsPanel.replaceChildren(fragment)
}

function renderDynamicTimeFields () {
  const status = state.statusSnapshot
  if (!status) return
  els.reconnectCountdown.textContent = status.reconnectAt ? formatDuration(Math.max(status.reconnectAt - Date.now(), 0)) : '--'
  els.lastActionAge.textContent = state.lastActionAt ? `${formatDuration(Date.now() - state.lastActionAt)} ago` : '--'
}

function updateStatus (status) {
  state.statusSnapshot = status
  const lifecycleState = String(status.lifecycleState || '').toLowerCase()
  const connectionState = lifecycleState || status.connectionState || 'idle'
  const connectionCss = {
    idle: 'offline',
    connecting: 'reconnecting',
    auth_required: 'reconnecting',
    running: 'online',
    reconnecting: 'reconnecting',
    stopped: 'offline',
    error: 'offline',
    online: 'online',
    offline: 'offline'
  }[connectionState] || 'offline'
  els.connectionBadge.textContent = connectionState.toUpperCase()
  els.connectionBadge.className = `badge ${connectionCss}`

  els.serverMeta.textContent = `Server: ${status.host}:${status.port} | Bot: ${status.username}`
  els.pingValue.textContent = typeof status.ping === 'number' ? `${status.ping} ms` : '--'
  els.lagValue.textContent = status.lagMode ? 'ON' : 'OFF'
  els.reconnectValue.textContent = `${status.retry && Number.isFinite(status.retry.attempt) ? status.retry.attempt : (status.reconnectAttempts || 0)}`
  els.uptimeValue.textContent = formatDuration(status.uptimeMs)

  const build = status.build || {}
  const metrics = build.metrics || {}
  const layer = Number(build.layer || 0)
  const layersTotal = Number(build.layersTotal || 0)
  const cell = Number(build.cell || 0)
  const cellsTotal = Number(build.cellsTotal || 0)

  els.layerValue.textContent = `${layer} / ${layersTotal}`
  els.cellValue.textContent = `${cell} / ${cellsTotal}`
  els.buildState.textContent = String(build.status || build.state || 'idle').toUpperCase()
  els.ppmValue.textContent = Number(metrics.placementsPerMinute || 0).toFixed(1)
  els.etaValue.textContent = formatDuration(metrics.etaMs)
  els.checkpointValue.textContent = `Layer ${layer}, Cell ${cell}`

  const done = Number(metrics.totalPlaced || 0)
  const estimatedTotal = Number(metrics.estimatedTotalCells || (layersTotal * cellsTotal) || 0)
  const progressPct = estimatedTotal > 0 ? Math.min((done / estimatedTotal) * 100, 100) : 0
  els.progressFill.style.width = `${progressPct.toFixed(1)}%`
  const progressBar = els.progressFill.parentElement
  if (progressBar) progressBar.setAttribute('aria-valuenow', progressPct.toFixed(0))

  els.coordValue.textContent = status.coordinates
    ? `${status.coordinates.x.toFixed(1)}, ${status.coordinates.y.toFixed(1)}, ${status.coordinates.z.toFixed(1)}`
    : '--'
  els.dimensionValue.textContent = status.dimension || '--'

  renderMaterials(status.inventory || {}, status.refill || {})

  const refill = status.refill || {}
  els.refillStatus.textContent = refill.needsRefill ? 'NEEDS REFILL' : 'OK'
  const container = refill.lastRefillContainer
  els.refillContainer.textContent = container ? `${container.name} @ ${container.position.x},${container.position.y},${container.position.z}` : '--'
  els.refillTime.textContent = formatTime(refill.lastRefillSuccessAtMs)

  renderDynamicTimeFields()
}

async function sendControl (action) {
  if (state.controlsInFlight) return
  if (action === 'start' && state.missingRequiredFields.length > 0) {
    showToast('Complete Setup Wizard required fields before starting.')
    return
  }

  setControlButtonsDisabled(true)
  try {
    const result = await fetch('/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })

    const payload = await result.json().catch(() => ({}))
    if (!result.ok || payload.ok === false) throw new Error(payload.error || `Action failed: ${action}`)

    state.lastActionAt = Date.now()
    appendLog({ level: 'info', message: `Control action accepted: ${action}`, timestamp: Date.now() })
    showToast(`Action sent: ${action.toUpperCase()}`)
  } finally {
    setControlButtonsDisabled(false)
  }
}

function exportLogs () {
  const blob = new Blob([JSON.stringify(state.logEntries, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `minefarmbot-log-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(link.href)
}

async function copyLastError () {
  if (!state.lastError) return showToast('No error to copy yet.')
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    appendLog({ level: 'warn', message: 'Clipboard API unavailable in this browser context.', timestamp: Date.now() })
    return
  }
  await navigator.clipboard.writeText(state.lastError)
  appendLog({ level: 'info', message: 'Copied last error to clipboard', timestamp: Date.now() })
  showToast('Copied last error.')
}

function setupControls () {
  for (const btn of document.querySelectorAll('[data-action]')) {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action')
      sendControl(action).catch(err => {
        state.lastError = err.message
        appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
        showToast(err.message)
      })
    })
  }

  els.pauseScrollBtn.addEventListener('click', () => {
    state.autoScroll = !state.autoScroll
    els.pauseScrollBtn.textContent = state.autoScroll ? 'Pause Scroll' : 'Resume Scroll'
  })

  els.clearLogBtn.addEventListener('click', () => {
    state.logEntries = []
    els.logFeed.replaceChildren()
    showToast('Log cleared.')
  })

  els.exportLogBtn.addEventListener('click', exportLogs)
  els.copyErrorBtn.addEventListener('click', () => copyLastError().catch(() => {}))

  if (isDesktopApp()) {
    els.restartBotBtn.classList.remove('hidden')
    els.restartBotBtn.addEventListener('click', async () => {
      try {
        const result = await window.minefarmDesktop.restartBot()
        if (!result || result.ok === false) {
          throw new Error(result && result.error ? result.error : 'Restart failed')
        }
        showToast('Bot process restarted')
        appendLog({ level: 'info', message: 'Desktop wrapper restarted bot process', timestamp: Date.now() })
      } catch (err) {
        showToast(err.message)
        appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
      }
    })
  }

  els.openConfigBtn.addEventListener('click', () => {
    loadConfigForm().then(() => {
      els.configDialog.showModal()
    }).catch(err => {
      appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
      showToast(err.message)
    })
  })

  els.closeConfigBtn.addEventListener('click', () => els.configDialog.close())
  els.reloadConfigBtn.addEventListener('click', () => {
    loadConfigForm().catch(err => {
      els.configMessage.textContent = err.message
      showToast(err.message)
    })
  })

  els.authTypeSelect.addEventListener('change', () => {
    applyAuthVisibility()
    markRequiredConfigFields()
    const missing = validateRequiredInForm()
    state.missingRequiredFields = missing
    updateConfigHealthBanner()
    updateStartButtonEnabled()
    els.configMessage.textContent = missing.length > 0
      ? `Missing required fields: ${missing.join(', ')}`
      : 'All required fields are present.'
  })

  els.configForm.addEventListener('input', () => {
    const missing = validateRequiredInForm()
    state.missingRequiredFields = missing
    updateConfigHealthBanner()
    updateStartButtonEnabled()
    els.configMessage.textContent = missing.length > 0
      ? `Missing required fields: ${missing.join(', ')}`
      : 'All required fields are present.'
  })

  els.configForm.addEventListener('submit', event => {
    event.preventDefault()
    saveConfigForm().catch(err => {
      els.configMessage.textContent = err.message
      showToast(err.message)
    })
  })
}

function onErrorEvent (payload) {
  state.lastError = payload.message || 'Unknown error'
  appendLog(payload)
  els.errorSound.play().catch(() => {})
  if (window.Notification && Notification.permission === 'granted') {
    new Notification('MineFarmBot Error', { body: state.lastError })
  }
}

function teardownEventStream () {
  if (!state.eventStream) return
  state.eventStream.close()
  state.eventStream = null
}

function setupEventStream () {
  teardownEventStream()
  state.eventStream = new EventSource('/events')
  state.eventStream.addEventListener('status', event => updateStatus(JSON.parse(event.data)))
  state.eventStream.addEventListener('log', event => appendLog(JSON.parse(event.data)))
  state.eventStream.addEventListener('warning', event => appendLog(JSON.parse(event.data)))
  state.eventStream.addEventListener('error', event => onErrorEvent(JSON.parse(event.data)))
  state.eventStream.onerror = () => appendLog({ level: 'warn', message: 'Event stream interrupted. Browser will retry automatically.', timestamp: Date.now() })
}

function setupDesktopEvents () {
  if (!isDesktopApp()) return

  window.minefarmDesktop.onStatus(status => updateStatus(status))
  window.minefarmDesktop.onLog(entry => appendLog(entry))
  window.minefarmDesktop.onWarning(entry => appendLog(entry))
  window.minefarmDesktop.onError(entry => onErrorEvent(entry))
  window.minefarmDesktop.onStatusTransition(event => {
    if (!event || !event.current) return
    appendLog({
      level: 'info',
      message: `Lifecycle state changed: ${String(event.previous || 'none')} → ${String(event.current)}`,
      timestamp: event.timestamp || Date.now()
    })
  })
}

async function init () {
  setupControls()

  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }

  const [status] = await Promise.all([
    fetch('/status', { cache: 'no-store' }).then(r => r.json()),
    loadConfigForm().catch(() => {})
  ])

  updateStatus(status)
  if (isDesktopApp()) setupDesktopEvents()
  else setupEventStream()
  state.updateTicker = setInterval(renderDynamicTimeFields, 1000)

  window.addEventListener('beforeunload', () => {
    if (state.updateTicker) clearInterval(state.updateTicker)
    if (state.toastTimer) clearTimeout(state.toastTimer)
    teardownEventStream()
  })
}

init().catch(err => {
  state.lastError = err.message
  appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
  showToast(err.message)
})
