'use strict'

const els = {
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
  logFeed: document.getElementById('log-feed'),
  materialsPanel: document.getElementById('materials-panel'),
  refillTime: document.getElementById('refill-time'),
  refillContainer: document.getElementById('refill-container'),
  refillStatus: document.getElementById('refill-status'),
  errorSound: document.getElementById('error-sound')
}

let autoScroll = true
let statusSnapshot = null
let logEntries = []
let lastError = ''

const lowThresholdDefaults = { sand: 64, cactus: 64, string: 64, cobblestone: 128 }

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

function appendLog (entry) {
  logEntries.push(entry)
  if (logEntries.length > 1000) logEntries.shift()

  const line = document.createElement('p')
  line.className = `log-line ${entry.level || 'info'}`
  line.textContent = `[${new Date(entry.timestamp || Date.now()).toLocaleTimeString()}] [${(entry.level || 'info').toUpperCase()}] ${entry.message}`
  els.logFeed.appendChild(line)

  if (autoScroll) {
    els.logFeed.scrollTop = els.logFeed.scrollHeight
  }
}

function renderMaterials (inventory = {}, refill = {}) {
  const thresholds = (refill && refill.thresholds) || lowThresholdDefaults
  const keys = ['sand', 'cactus', 'string', 'cobblestone']
  els.materialsPanel.innerHTML = ''

  for (const key of keys) {
    const value = inventory[key] || 0
    const threshold = thresholds[key] || lowThresholdDefaults[key] || 1
    const fillPct = Math.min((value / Math.max(threshold * 2, 1)) * 100, 100)
    const row = document.createElement('div')
    row.className = 'material-row'
    row.innerHTML = `
      <div class="material-head"><span>${key[0].toUpperCase() + key.slice(1)}</span><strong>${value} ${value <= threshold ? '<span class="low">LOW</span>' : ''}</strong></div>
      <div class="material-bar"><div class="material-fill" style="width:${fillPct}%"></div></div>
    `
    els.materialsPanel.appendChild(row)
  }
}

function updateStatus (status) {
  statusSnapshot = status
  const state = status.connectionState || 'offline'
  els.connectionBadge.textContent = state.toUpperCase()
  els.connectionBadge.className = `badge ${state}`
  els.serverMeta.textContent = `Server: ${status.host}:${status.port} | Bot: ${status.username}`
  els.pingValue.textContent = typeof status.ping === 'number' ? `${status.ping} ms` : '--'
  els.lagValue.textContent = status.lagMode ? 'ON' : 'OFF'
  els.reconnectValue.textContent = `${status.reconnectAttempts || 0}`
  els.uptimeValue.textContent = formatDuration(status.uptimeMs)

  const reconnectAt = status.reconnectAt
  if (reconnectAt) {
    const remaining = Math.max(reconnectAt - Date.now(), 0)
    els.reconnectCountdown.textContent = formatDuration(remaining)
  } else {
    els.reconnectCountdown.textContent = '--'
  }

  const build = status.build || {}
  const metrics = build.metrics || {}
  const layer = build.layer || 0
  const layersTotal = build.layersTotal || 0
  const cell = build.cell || 0
  const cellsTotal = build.cellsTotal || 0

  els.layerValue.textContent = `${layer} / ${layersTotal}`
  els.cellValue.textContent = `${cell} / ${cellsTotal}`
  els.buildState.textContent = (build.status || build.state || 'idle').toUpperCase()
  els.ppmValue.textContent = Number(metrics.placementsPerMinute || 0).toFixed(1)
  els.etaValue.textContent = formatDuration(metrics.etaMs)
  els.checkpointValue.textContent = `Layer ${layer}, Cell ${cell}`

  const totalDone = metrics.totalPlaced || 0
  const estimatedTotal = metrics.estimatedTotalCells || (layersTotal * (cellsTotal || 0))
  const progressPct = estimatedTotal > 0 ? Math.min((totalDone / estimatedTotal) * 100, 100) : 0
  els.progressFill.style.width = `${progressPct.toFixed(1)}%`

  if (status.coordinates) {
    els.coordValue.textContent = `${status.coordinates.x.toFixed(1)}, ${status.coordinates.y.toFixed(1)}, ${status.coordinates.z.toFixed(1)}`
  } else {
    els.coordValue.textContent = '--'
  }
  els.dimensionValue.textContent = status.dimension || '--'

  renderMaterials(status.inventory, status.refill)

  const refill = status.refill || {}
  els.refillStatus.textContent = refill.needsRefill ? 'needs refill' : 'ok'
  const container = refill.lastRefillContainer
  els.refillContainer.textContent = container ? `${container.name} @ ${container.position.x},${container.position.y},${container.position.z}` : '--'
  els.refillTime.textContent = formatTime(refill.lastRefillSuccessAtMs)
}

async function sendControl (action) {
  const result = await fetch('/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  })
  const payload = await result.json()
  if (!result.ok || payload.ok === false) {
    throw new Error(payload.error || `Action failed: ${action}`)
  }
  appendLog({ level: 'info', message: `Control action accepted: ${action}`, timestamp: Date.now() })
}

function bindControls () {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.getAttribute('data-action')
      try {
        await sendControl(action)
      } catch (err) {
        lastError = err.message
        appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
      }
    })
  })

  document.getElementById('pause-scroll-btn').addEventListener('click', (e) => {
    autoScroll = !autoScroll
    e.target.textContent = autoScroll ? 'Pause Scroll' : 'Resume Scroll'
  })

  document.getElementById('clear-log-btn').addEventListener('click', () => {
    logEntries = []
    els.logFeed.innerHTML = ''
  })

  document.getElementById('export-log-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(logEntries, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `minefarmbot-log-${Date.now()}.json`
    link.click()
    URL.revokeObjectURL(link.href)
  })

  document.getElementById('copy-error-btn').addEventListener('click', async () => {
    if (!lastError) return
    await navigator.clipboard.writeText(lastError)
    appendLog({ level: 'info', message: 'Copied last error to clipboard', timestamp: Date.now() })
  })
}

function setupEventStream () {
  const stream = new EventSource('/events')
  stream.addEventListener('status', (event) => updateStatus(JSON.parse(event.data)))
  stream.addEventListener('log', (event) => appendLog(JSON.parse(event.data)))
  stream.addEventListener('warning', (event) => appendLog(JSON.parse(event.data)))
  stream.addEventListener('error', (event) => {
    const payload = JSON.parse(event.data)
    lastError = payload.message
    appendLog(payload)
    els.errorSound.play().catch(() => {})
    if (window.Notification && Notification.permission === 'granted') {
      new Notification('MineFarmBot Error', { body: payload.message })
    }
  })
  stream.onerror = () => appendLog({ level: 'warn', message: 'Event stream interrupted. Waiting to reconnect...', timestamp: Date.now() })
}

async function init () {
  bindControls()
  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
  const status = await fetch('/status').then(r => r.json())
  updateStatus(status)
  setupEventStream()
  setInterval(() => {
    if (statusSnapshot && statusSnapshot.reconnectAt) updateStatus(statusSnapshot)
  }, 1000)
}

init().catch(err => appendLog({ level: 'error', message: err.message, timestamp: Date.now() }))
