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
  configMessage: document.getElementById('config-message')
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
  configRequiredFields: []
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
  if (level === 'error' || level === 'warn' || level === 'info') return level
  return 'info'
}

function showToast (message) {
  if (!els.toast) return
  if (state.toastTimer) {
    clearTimeout(state.toastTimer)
    state.toastTimer = null
  }

  els.toast.textContent = message
  els.toast.classList.add('show')
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('show')
    state.toastTimer = null
  }, 2500)
}



function setByPath (obj, path, value) {
  const keys = path.split('.')
  let cursor = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (!cursor[k] || typeof cursor[k] !== 'object') cursor[k] = {}
    cursor = cursor[k]
  }
  cursor[keys[keys.length - 1]] = value
}

function getByPath (obj, path) {
  return path.split('.').reduce((acc, k) => (acc && Object.prototype.hasOwnProperty.call(acc, k) ? acc[k] : undefined), obj)
}

function markRequiredConfigFields () {
  for (const input of els.configForm.querySelectorAll('input[name]')) {
    const required = state.configRequiredFields.includes(input.name)
    input.required = required || input.required
    input.parentElement.style.color = required ? '#f3cb5d' : ''
  }
}

function fillConfigForm (cfg) {
  for (const input of els.configForm.querySelectorAll('input[name]')) {
    const value = getByPath(cfg, input.name)
    if (input.type === 'checkbox') input.checked = Boolean(value)
    else if (value == null) input.value = ''
    else input.value = String(value)
  }
}

async function loadConfigForm () {
  const data = await fetch('/config', { cache: 'no-store' }).then(r => r.json())
  if (!data.ok) throw new Error(data.error || 'Failed to load config')
  state.configRequiredFields = Array.isArray(data.requiredFields) ? data.requiredFields : []
  fillConfigForm(data.config || {})
  markRequiredConfigFields()
  els.configMessage.textContent = 'Loaded current configuration.'
}

function collectConfigFromForm () {
  const payload = {}
  for (const input of els.configForm.querySelectorAll('input[name]')) {
    let value
    if (input.type === 'checkbox') value = input.checked
    else if (input.type === 'number') value = input.value === '' ? null : Number(input.value)
    else value = input.value.trim()

    if (value === '' || Number.isNaN(value)) continue
    setByPath(payload, input.name, value)
  }
  return payload
}

async function saveConfigForm () {
  const payload = collectConfigFromForm()
  const result = await fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: payload })
  })
  const body = await result.json().catch(() => ({}))
  if (!result.ok || body.ok === false) {
    throw new Error(body.error || 'Failed to save config')
  }
  fillConfigForm(body.config || {})
  els.configMessage.textContent = body.message || 'Saved.'
  showToast('Config saved successfully')
}
function setControlButtonsDisabled (disabled) {
  state.controlsInFlight = disabled
  for (const btn of document.querySelectorAll('[data-action]')) {
    btn.disabled = disabled
  }
}

function trimLogFeedDom () {
  while (els.logFeed.childElementCount > MAX_LOGS) {
    els.logFeed.removeChild(els.logFeed.firstElementChild)
  }
}

function appendLog (entry) {
  const payload = {
    level: levelOf(entry),
    message: String(entry.message || ''),
    timestamp: entry.timestamp || Date.now()
  }

  state.logEntries.push(payload)
  if (state.logEntries.length > MAX_LOGS) {
    state.logEntries.shift()
  }

  const line = document.createElement('p')
  line.className = `log-line ${payload.level}`
  line.textContent = `[${new Date(payload.timestamp).toLocaleTimeString()}] [${payload.level.toUpperCase()}] ${payload.message}`
  els.logFeed.appendChild(line)
  trimLogFeedDom()

  if (state.autoScroll) {
    els.logFeed.scrollTop = els.logFeed.scrollHeight
  }
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
    row.innerHTML = [
      '<div class="material-head">',
      `<span>${key[0].toUpperCase() + key.slice(1)}</span>`,
      `<strong>${value}${isLow ? ' <span class="low">LOW</span>' : ''}</strong>`,
      '</div>',
      `<div class="material-bar"><div class="material-fill" style="width:${fillPct}%"></div></div>`
    ].join('')

    fragment.appendChild(row)
  }

  els.materialsPanel.replaceChildren(fragment)
}

function renderDynamicTimeFields () {
  const status = state.statusSnapshot
  if (!status) return

  if (status.reconnectAt) {
    els.reconnectCountdown.textContent = formatDuration(Math.max(status.reconnectAt - Date.now(), 0))
  } else {
    els.reconnectCountdown.textContent = '--'
  }

  if (state.lastActionAt) {
    els.lastActionAge.textContent = `${formatDuration(Date.now() - state.lastActionAt)} ago`
  } else {
    els.lastActionAge.textContent = '--'
  }
}

function updateStatus (status) {
  state.statusSnapshot = status

  const connectionState = status.connectionState || 'offline'
  const connectionCss = ['online', 'reconnecting', 'offline'].includes(connectionState) ? connectionState : 'offline'
  els.connectionBadge.textContent = connectionState.toUpperCase()
  els.connectionBadge.className = `badge ${connectionCss}`

  els.serverMeta.textContent = `Server: ${status.host}:${status.port} | Bot: ${status.username}`
  els.pingValue.textContent = typeof status.ping === 'number' ? `${status.ping} ms` : '--'
  els.lagValue.textContent = status.lagMode ? 'ON' : 'OFF'
  els.reconnectValue.textContent = `${status.reconnectAttempts || 0}`
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

  if (status.coordinates) {
    els.coordValue.textContent = `${status.coordinates.x.toFixed(1)}, ${status.coordinates.y.toFixed(1)}, ${status.coordinates.z.toFixed(1)}`
  } else {
    els.coordValue.textContent = '--'
  }

  els.dimensionValue.textContent = status.dimension || '--'

  renderMaterials(status.inventory || {}, status.refill || {})

  const refill = status.refill || {}
  els.refillStatus.textContent = (refill.needsRefill ? 'NEEDS REFILL' : 'OK')
  const container = refill.lastRefillContainer
  els.refillContainer.textContent = container
    ? `${container.name} @ ${container.position.x},${container.position.y},${container.position.z}`
    : '--'
  els.refillTime.textContent = formatTime(refill.lastRefillSuccessAtMs)

  renderDynamicTimeFields()
}

async function sendControl (action) {
  if (state.controlsInFlight) return
  setControlButtonsDisabled(true)

  try {
    const result = await fetch('/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })

    const payload = await result.json().catch(() => ({}))
    if (!result.ok || payload.ok === false) {
      throw new Error(payload.error || `Action failed: ${action}`)
    }

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
  if (!state.lastError) {
    showToast('No error to copy yet.')
    return
  }

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
    btn.addEventListener('click', async () => {
      const action = btn.getAttribute('data-action')
      try {
        await sendControl(action)
      } catch (err) {
        state.lastError = err.message
        appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
        showToast(err.message)
      }
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

  els.openConfigBtn.addEventListener('click', async () => {
    try {
      await loadConfigForm()
      els.configDialog.showModal()
    } catch (err) {
      appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
      showToast(err.message)
    }
  })

  els.closeConfigBtn.addEventListener('click', () => {
    els.configDialog.close()
  })

  els.reloadConfigBtn.addEventListener('click', () => {
    loadConfigForm().catch(err => {
      els.configMessage.textContent = err.message
      showToast(err.message)
    })
  })

  els.configForm.addEventListener('submit', (event) => {
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
  if (state.eventStream) {
    state.eventStream.close()
    state.eventStream = null
  }
}

function setupEventStream () {
  teardownEventStream()

  const stream = new EventSource('/events')
  state.eventStream = stream

  stream.addEventListener('status', event => updateStatus(JSON.parse(event.data)))
  stream.addEventListener('log', event => appendLog(JSON.parse(event.data)))
  stream.addEventListener('warning', event => appendLog(JSON.parse(event.data)))
  stream.addEventListener('error', event => onErrorEvent(JSON.parse(event.data)))

  stream.onerror = () => {
    appendLog({ level: 'warn', message: 'Event stream interrupted. Browser will retry automatically.', timestamp: Date.now() })
  }
}

async function init () {
  setupControls()

  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }

  const status = await fetch('/status', { cache: 'no-store' }).then(r => r.json())
  updateStatus(status)
  loadConfigForm().catch(() => {})
  setupEventStream()

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
